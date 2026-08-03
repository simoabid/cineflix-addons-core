/**
 * Import REST API (mounted on the OMSS Fastify instance).
 *
 *   POST /v1/addons/import/url         { url } | { urls: string[] }
 *   POST /v1/addons/import/stremio     { email, password } | { authKey }
 *   POST /v1/addons/import/repository  { url }
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AddonManager } from '../addons/manager.js';
import { importFromUrl, importFromUrls } from '../import/url.js';
import { importFromStremioAccount } from '../import/stremioAccount.js';
import { importFromRepository } from '../import/repository.js';
import { makeAdminGuard } from './auth.js';

export function registerImportRoutes(
    app: FastifyInstance,
    manager: AddonManager,
    cfg: AppConfig
): void {
    const guard = makeAdminGuard(cfg);

    app.post<{ Body: { url?: string; urls?: string[] } }>(
        '/v1/addons/import/url',
        { preHandler: guard },
        async (req, reply) => {
            const body = req.body ?? {};
            if (Array.isArray(body.urls) && body.urls.length) {
                const results = await importFromUrls(manager, body.urls);
                const installed = results.filter((r) => r.ok).length;
                return reply
                    .code(200)
                    .send({ ok: true, installed, total: results.length, results });
            }
            if (typeof body.url === 'string' && body.url.trim()) {
                const result = await importFromUrl(manager, body.url.trim());
                return reply.code(result.ok ? 200 : 400).send(result);
            }
            return reply.code(400).send({
                error: {
                    code: 'MISSING_PARAMETER',
                    message: 'Provide { url } or { urls: string[] }'
                }
            });
        }
    );

    app.post<{
        Body: {
            email?: string;
            password?: string;
            authKey?: string;
            endpoint?: string;
        };
    }>(
        '/v1/addons/import/stremio',
        { preHandler: guard },
        async (req, reply) => {
            const body = req.body ?? {};
            if (!body.authKey && (!body.email || !body.password)) {
                return reply.code(400).send({
                    error: {
                        code: 'MISSING_PARAMETER',
                        message: 'Provide { authKey } or { email, password }'
                    }
                });
            }
            try {
                const result = await importFromStremioAccount(manager, body);
                return reply.code(200).send({ ok: true, ...result });
            } catch (err) {
                return reply.code(400).send({
                    ok: false,
                    error: err instanceof Error ? err.message : 'Import failed'
                });
            }
        }
    );

    app.post<{ Body: { url?: string } }>(
        '/v1/addons/import/repository',
        { preHandler: guard },
        async (req, reply) => {
            const url = req.body?.url?.trim();
            if (!url) {
                return reply.code(400).send({
                    error: {
                        code: 'MISSING_PARAMETER',
                        message: 'Provide { url } pointing at an addon list'
                    }
                });
            }
            try {
                const result = await importFromRepository(manager, url);
                return reply.code(200).send({ ok: true, ...result });
            } catch (err) {
                return reply.code(400).send({
                    ok: false,
                    error: err instanceof Error ? err.message : 'Import failed'
                });
            }
        }
    );
}
