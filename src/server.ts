import { OMSSServer } from '@omss/framework';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig, resolvePublicUrl } from './config.js';
import { AddonManager } from './addons/manager.js';
import {
    buildProgressiveMedia,
    listProvidersWithPriority,
    scrapeSingleProvider
} from './progressiveScrape.js';
import { aggregateSubtitles } from './subtitles/index.js';
import { HealthMonitor } from './health/monitor.js';
import { registerAddonRoutes } from './routes/addons.routes.js';
import { registerImportRoutes } from './routes/import.routes.js';
import { logScrapeProxyStatus } from './egress/scrapeFetch.js';
import { installStreamEgress } from './egress/globalDispatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ADMIN_DIR = path.join(__dirname, '..', 'public', 'admin');

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

async function main(): Promise<void> {
    const cfg = loadConfig();

    if (!cfg.tmdbApiKey) {
        console.error(
            '\n[fatal] TMDB_API_KEY is required (used to resolve IMDb ids for Stremio addons).\n' +
                '        Set it in .env — see .env.example.\n'
        );
        process.exit(1);
    }

    // Route stream egress (framework /v1/proxy fetches) through the proxy when set.
    installStreamEgress();

    const publicUrl = resolvePublicUrl(cfg);

    const server = new OMSSServer({
        name: cfg.name,
        version: cfg.version,
        host: cfg.host,
        port: cfg.port,
        publicUrl: cfg.publicUrl,
        cache: {
            type: cfg.cacheType,
            ttl: { sources: 60 * 60, subtitles: 60 * 60 * 24 },
            redis: {
                host: cfg.redis.host,
                port: cfg.redis.port,
                password: cfg.redis.password
            }
        },
        tmdb: { apiKey: cfg.tmdbApiKey, cacheTTL: cfg.tmdbCacheTTL },
        proxyConfig: {
            knownThirdPartyProxies: {},
            // Segment/binary types stream; keep .m3u8/.mpd buffered so the
            // framework rewrites their inner URLs through /v1/proxy.
            streamPatterns: [/\.ts(\?|$)/i, /\.m4s(\?|$)/i]
        },
        cors: {
            origin: cfg.corsOrigin,
            methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
            allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
            exposedHeaders: ['Content-Range', 'Accept-Ranges', 'ETag'],
            optionsSuccessStatus: 204
        },
        stremio: {
            enableNativeAddon: cfg.enableNativeAddon,
            stremioAddons: []
        },
        mcp: { enabled: false }
    });

    const registry = server.getRegistry();
    const manager = AddonManager.create(registry, cfg);
    await manager.init();

    const monitor = new HealthMonitor(manager, {
        intervalMinutes: cfg.healthIntervalMinutes,
        autoRefresh: cfg.autoRefresh
    });

    const app = server.getInstance();

    // ── Provider list (frontend waterfall order) ──────────────────────────────
    app.get('/v1/providers', async (_req, reply) => {
        return reply.code(200).send(listProvidersWithPriority(manager));
    });

    // ── Progressive single-addon scrape ───────────────────────────────────────
    app.get<{ Params: { tmdbId: string; providerId: string } }>(
        '/v1/movies/:tmdbId/providers/:providerId',
        async (request, reply) => {
            const { tmdbId, providerId } = request.params;
            try {
                const media = await buildProgressiveMedia('movie', tmdbId);
                const result = await scrapeSingleProvider(
                    registry,
                    providerId,
                    media,
                    manager.getTimeoutMs(providerId)
                );
                return reply.code(200).send(result);
            } catch (err) {
                return sendProviderError(reply, err);
            }
        }
    );

    app.get<{
        Params: {
            tmdbId: string;
            season: string;
            episode: string;
            providerId: string;
        };
    }>(
        '/v1/tv/:tmdbId/seasons/:season/episodes/:episode/providers/:providerId',
        async (request, reply) => {
            const { tmdbId, season, episode, providerId } = request.params;
            const s = Number(season);
            const e = Number(episode);
            if (!Number.isFinite(s) || !Number.isFinite(e)) {
                return reply.code(400).send({
                    sources: [],
                    subtitles: [],
                    diagnostics: [],
                    error: 'Invalid season or episode'
                });
            }
            try {
                const media = await buildProgressiveMedia('tv', tmdbId, s, e);
                const result = await scrapeSingleProvider(
                    registry,
                    providerId,
                    media,
                    manager.getTimeoutMs(providerId)
                );
                return reply.code(200).send(result);
            } catch (err) {
                return sendProviderError(reply, err);
            }
        }
    );

    // ── Dedicated subtitle aggregation ─────────────────────────────────────────
    app.get<{
        Querystring: {
            tmdbId?: string;
            imdbId?: string;
            id?: string;
            season?: string;
            episode?: string;
            s?: string;
            e?: string;
            language?: string;
        };
    }>('/v1/subtitles', async (request, reply) => {
        const q = request.query;
        const id = (q.id || '').trim();
        const imdbId = (q.imdbId || (id.startsWith('tt') ? id : '')).trim();
        const tmdbId = (
            q.tmdbId || (!imdbId && /^\d+$/.test(id) ? id : '')
        ).trim();
        const seasonRaw = q.season ?? q.s;
        const episodeRaw = q.episode ?? q.e;
        const season =
            seasonRaw != null && seasonRaw !== '' ? Number(seasonRaw) : undefined;
        const episode =
            episodeRaw != null && episodeRaw !== ''
                ? Number(episodeRaw)
                : undefined;

        if (!imdbId && !tmdbId) {
            return reply.code(400).send({
                subtitles: [],
                error: 'Provide tmdbId, imdbId, or id'
            });
        }

        const result = await aggregateSubtitles(manager, publicUrl, {
            imdbId: imdbId || undefined,
            tmdbId: tmdbId || undefined,
            season: Number.isFinite(season as number) ? season : undefined,
            episode: Number.isFinite(episode as number) ? episode : undefined,
            language: q.language
        });
        return reply.code(200).send({
            subtitles: result.subtitles,
            source: 'stremio-addons',
            addonsQueried: result.addonsQueried,
            ...(result.error ? { error: result.error } : {})
        });
    });

    // ── Management + import API ────────────────────────────────────────────────
    registerAddonRoutes(app, manager, cfg, monitor);
    registerImportRoutes(app, manager, cfg);

    // ── Admin UI (static) ──────────────────────────────────────────────────────
    if (cfg.adminEnabled) {
        registerAdminUi(app);
    }

    await server.start();

    logScrapeProxyStatus();
    monitor.start();
    console.log(
        `\n[addons-core] ready → ${publicUrl}` +
            `\n  • Point CINEFLIX serverUrl / VITE_CINEPRO_URL at this base.` +
            (cfg.adminEnabled
                ? `\n  • Admin UI: ${publicUrl}/admin`
                : '') +
            `\n  • Store: ${manager.describeStore()}\n`
    );
}

function sendProviderError(
    reply: import('fastify').FastifyReply,
    err: unknown
) {
    const status = (err as Error & { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : 'Unknown error';
    return reply.code(status).send({
        sources: [],
        subtitles: [],
        diagnostics: [
            { code: 'PROVIDER_ERROR', message, field: '', severity: 'error' }
        ],
        error: message
    });
}

function registerAdminUi(app: import('fastify').FastifyInstance): void {
    const serveFile = async (
        relPath: string,
        reply: import('fastify').FastifyReply
    ): Promise<void> => {
        const safe = path
            .normalize(relPath)
            .replace(/^(\.\.(\/|\\|$))+/, '');
        const full = path.join(ADMIN_DIR, safe);
        if (!full.startsWith(ADMIN_DIR)) {
            await reply.code(403).send({ error: 'Forbidden' });
            return;
        }
        try {
            const data = await fs.readFile(full);
            const ext = path.extname(full).toLowerCase();
            await reply
                .header(
                    'Content-Type',
                    CONTENT_TYPES[ext] ?? 'application/octet-stream'
                )
                .code(200)
                .send(data);
        } catch {
            await reply.code(404).send({ error: 'Not found' });
        }
    };

    app.get('/admin', async (_req, reply) => serveFile('index.html', reply));
    app.get<{ Params: { '*': string } }>(
        '/admin/*',
        async (req, reply) => {
            const rest = req.params['*'] || 'index.html';
            return serveFile(rest, reply);
        }
    );
}

main().catch((err) => {
    console.error('[addons-core] fatal:', err);
    process.exit(1);
});
