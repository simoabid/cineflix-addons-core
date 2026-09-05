/**
 * Catalog browsing routes (Phase 12 §15.1).
 *
 * Scoped, read-only passthrough over installed addons' catalogs:
 *   GET /v1/catalogs                              — descriptors from all enabled catalog-capable addons
 *   GET /v1/catalogs/:slug/:type/:catalogId       — one normalized, cached page
 *
 * Catalog-only addons can serve these endpoints but never enter the stream
 * waterfall (capability model — see docs/concepts.md).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AddonManager } from '../addons/manager.js';
import type { CacheManager } from '../cache/manager.js';
import type { AppConfig } from '../config.js';
import { CatalogService } from '../catalogs/service.js';
import { getRateLimitIp } from '../security/auth.js';
import { createRateLimiter } from '../security/rateLimit.js';
import { enforceRateLimit, makeAuthGuard } from './auth.js';

interface CatalogParams {
    slug: string;
    type: string;
    catalogId: string;
}

interface CatalogQuery {
    search?: string;
    genre?: string;
    skip?: string;
}

export function registerCatalogRoutes(
    app: FastifyInstance,
    manager: AddonManager,
    cfg: AppConfig,
    cacheManager?: CacheManager
): void {
    const viewerGuard = makeAuthGuard(cfg, { role: 'viewer' });
    const limiter = createRateLimiter();
    const service = new CatalogService(manager, cacheManager, {
        maxItems: cfg.catalogMaxItems,
        ttlSec: cacheManager?.ttls.catalogSec ?? 1800,
        // Same SSRF/host policy the stream pipeline uses (cfg-aware, so dev
        // loopback exemptions match).
        policy: manager.urlPolicy()
    });

    const enforceCatalogRateLimit = async (
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<boolean> => {
        const ip = getRateLimitIp(request, cfg);
        return enforceRateLimit(reply, limiter, `catalog:${ip}`, 60, 60_000);
    };

    app.get(
        '/v1/catalogs',
        { preHandler: [viewerGuard] },
        async (request, reply) => {
            if (!(await enforceCatalogRateLimit(request, reply))) return;
            const catalogs = service.listCatalogs();
            return reply
                .code(200)
                .header('x-provider-revision', String(service.revision))
                .send({ catalogs });
        }
    );

    app.get<{
        Params: CatalogParams;
        Querystring: CatalogQuery;
    }>(
        '/v1/catalogs/:slug/:type/:catalogId',
        { preHandler: [viewerGuard] },
        async (request, reply) => {
            if (!(await enforceCatalogRateLimit(request, reply))) return;
            const { slug, type, catalogId } = request.params;
            if (
                !/^[a-z0-9-:_.]+$/i.test(slug) ||
                !/^[a-z0-9-_.]+$/i.test(type) ||
                !/^[a-z0-9-_.]+$/i.test(catalogId)
            ) {
                return reply.code(400).send({
                    error: {
                        code: 'INVALID_PARAMETER',
                        message: 'slug, type and catalogId must be url-safe'
                    },
                    requestId: request.id
                });
            }
            const extra: Record<string, string> = {};
            if (request.query.search) extra.search = request.query.search;
            if (request.query.genre) extra.genre = request.query.genre;
            if (request.query.skip) extra.skip = request.query.skip;
            try {
                const page = await service.getCatalogPage(
                    slug,
                    type,
                    catalogId,
                    extra
                );
                return reply
                    .code(200)
                    .header('x-provider-revision', String(service.revision))
                    .send(page);
            } catch (err) {
                const status =
                    err instanceof Error && 'statusCode' in err
                        ? Number((err as { statusCode?: number }).statusCode) ||
                          502
                        : 502;
                if (status === 404) {
                    return reply.code(404).send({
                        error: {
                            code: 'NOT_FOUND',
                            message:
                                err instanceof Error
                                    ? err.message
                                    : 'catalog not found'
                        },
                        requestId: request.id
                    });
                }
                return reply.code(502).send({
                    error: {
                        code: 'UPSTREAM_ERROR',
                        message: 'catalog upstream failed'
                    },
                    requestId: request.id
                });
            }
        }
    );
}
