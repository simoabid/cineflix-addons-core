import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';

/**
 * Optional admin auth. When ADMIN_TOKEN is set, every management/import call
 * must carry it via `x-admin-token` header (or `?token=`). No token configured
 * → open (fine for a private/localhost deployment).
 */
export function makeAdminGuard(cfg: AppConfig) {
    return async function adminGuard(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> {
        if (!cfg.adminToken) return;
        const header = request.headers['x-admin-token'];
        const provided =
            (Array.isArray(header) ? header[0] : header) ||
            (request.query as { token?: string } | undefined)?.token;
        if (provided !== cfg.adminToken) {
            await reply.code(401).send({
                error: {
                    code: 'UNAUTHORIZED',
                    message: 'Missing or invalid admin token'
                }
            });
        }
    };
}
