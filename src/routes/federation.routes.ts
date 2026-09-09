/**
 * Federation routes (Phase 12 §15.3 — multi-backend aggregation).
 *
 * Read-only aggregation over remote OMSS backends:
 *   GET /v1/federation/status                          — per-backend diagnostics (operator)
 *   GET /v1/federation/movies/:id/sources              — merged sources (viewer)
 *   GET /v1/federation/tv/:id/seasons/:s/episodes/:e/sources — merged episode sources (viewer)
 *
 * Disabled entirely unless FEDERATION_ENABLED=true with at least one backend
 * configured (FEDERATION_BACKENDS) — fail-closed by default.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { FederationService } from '../federation/service.js';
import { getRateLimitIp } from '../security/auth.js';
import { createRateLimiter } from '../security/rateLimit.js';
import { enforceRateLimit, makeAuthGuard } from './auth.js';

interface FederationParams {
    id: string;
}

interface FederationTvParams {
    id: string;
    season: string;
    episode: string;
}

/** Accepts `tmdb:<digits>` or bare digits for the media id. */
function isValidMediaId(id: string): boolean {
    return /^(tmdb:)?\d{1,12}$/.test(id);
}

export function registerFederationRoutes(
    app: FastifyInstance,
    cfg: AppConfig,
    federation: FederationService
): void {
    const viewerGuard = makeAuthGuard(cfg, { role: 'viewer' });
    const operatorGuard = makeAuthGuard(cfg, { role: 'operator' });
    const limiter = createRateLimiter();

    const enforceFederationRateLimit = async (
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<boolean> => {
        const ip = getRateLimitIp(request, cfg);
        return enforceRateLimit(reply, limiter, `federation:${ip}`, 30, 60_000);
    };

    app.get(
        '/v1/federation/status',
        { preHandler: [operatorGuard] },
        async (request, reply) => {
            if (!(await enforceFederationRateLimit(request, reply))) return;
            return reply.code(200).send({
                enabled: federation.enabled,
                backends: federation.getStatus()
            });
        }
    );

    app.get<{ Params: FederationParams }>(
        '/v1/federation/movies/:id/sources',
        { preHandler: [viewerGuard] },
        async (request, reply) => {
            if (!(await enforceFederationRateLimit(request, reply))) return;
            const { id } = request.params;
            if (!isValidMediaId(id)) {
                return reply.code(400).send({
                    error: {
                        code: 'INVALID_TMDB_ID',
                        message: 'id must be tmdb:<digits> or digits'
                    },
                    requestId: request.id
                });
            }
            const result = await federation.fetchSources(
                { type: 'movie', omdbId: id },
                { timeoutMs: cfg.federationTimeoutMs }
            );
            return reply.code(200).send(result);
        }
    );

    app.get<{ Params: FederationTvParams }>(
        '/v1/federation/tv/:id/seasons/:season/episodes/:episode/sources',
        { preHandler: [viewerGuard] },
        async (request, reply) => {
            if (!(await enforceFederationRateLimit(request, reply))) return;
            const { id, season, episode } = request.params;
            const s = Number(season);
            const e = Number(episode);
            if (
                !isValidMediaId(id) ||
                !Number.isInteger(s) ||
                s < 0 ||
                !Number.isInteger(e) ||
                e < 0
            ) {
                return reply.code(400).send({
                    error: {
                        code: 'INVALID_PARAMETER',
                        message:
                            'id must be tmdb:<digits> or digits; season/episode must be non-negative integers'
                    },
                    requestId: request.id
                });
            }
            const result = await federation.fetchSources(
                { type: 'series', omdbId: id, season: s, episode: e },
                { timeoutMs: cfg.federationTimeoutMs }
            );
            return reply.code(200).send(result);
        }
    );
}
