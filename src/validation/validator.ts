/**
 * Validation middleware and pre-handler helpers for Fastify routes.
 * Produces structured, safe validation error responses with request IDs.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ValidationIssue, ValidatorFn } from './schemas.js';

export interface ValidationSpec {
    params?: ValidatorFn<unknown>;
    query?: ValidatorFn<unknown>;
    body?: ValidatorFn<unknown>;
    headers?: (
        headers: Record<string, unknown>
    ) => ValidationIssue[] | undefined;
}

export function formatValidationError(
    issues: ValidationIssue[],
    requestId?: string
) {
    return {
        error: {
            code: 'VALIDATION_ERROR',
            message: `Request validation failed: ${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`,
            details: issues
        },
        requestId
    };
}

/**
 * Creates a Fastify preHandler hook that validates params, query, body, and headers.
 */
export function validate(spec: ValidationSpec) {
    return async function (
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> {
        const allIssues: ValidationIssue[] = [];

        if (spec.params) {
            const res = spec.params(request.params);
            if (!res.ok && res.errors) {
                allIssues.push(...res.errors);
            } else if (res.ok && res.data !== undefined) {
                // Attach validated / transformed data
                request.params = res.data as typeof request.params;
            }
        }

        if (spec.query) {
            const res = spec.query(request.query);
            if (!res.ok && res.errors) {
                allIssues.push(...res.errors);
            } else if (res.ok && res.data !== undefined) {
                request.query = res.data as typeof request.query;
            }
        }

        if (spec.body) {
            const res = spec.body(request.body);
            if (!res.ok && res.errors) {
                allIssues.push(...res.errors);
            } else if (res.ok && res.data !== undefined) {
                request.body = res.data as typeof request.body;
            }
        }

        if (spec.headers) {
            const hdrIssues = spec.headers(
                request.headers as Record<string, unknown>
            );
            if (hdrIssues && hdrIssues.length > 0) {
                allIssues.push(...hdrIssues);
            }
        }

        if (allIssues.length > 0) {
            await reply
                .code(400)
                .send(formatValidationError(allIssues, request.id));
            return;
        }
    };
}

/**
 * Optimistic concurrency check for mutations.
 * Inspects `If-Match` header and request body/query `revision`.
 * If provided and mismatched with `currentRevision`, responds with 412 Precondition Failed.
 * Returns true if check passes, false if 412 was sent.
 */
export async function checkOptimisticConcurrency(
    request: FastifyRequest,
    reply: FastifyReply,
    currentRevision: number
): Promise<boolean> {
    const rawIfMatch =
        request.headers['if-match'] ??
        request.headers['If-Match'] ??
        request.headers['x-if-match'] ??
        (request.body as { revision?: number } | undefined)?.revision ??
        (request.query as { revision?: string } | undefined)?.revision;

    if (rawIfMatch === undefined || rawIfMatch === null || rawIfMatch === '') {
        return true; // Optional concurrency if caller did not specify
    }

    let expectedRev: number | null = null;
    const str = String(rawIfMatch)
        .trim()
        .replace(/^W\//, '')
        .replace(/^"|"$/g, '');

    if (str === '*') {
        return true; // Match any
    }

    if (str.startsWith('rev-')) {
        expectedRev = Number(str.slice(4));
    } else {
        expectedRev = Number(str);
    }

    if (!Number.isFinite(expectedRev)) {
        await reply.code(400).send({
            error: {
                code: 'INVALID_HEADER',
                message:
                    "If-Match header must be '*' or a revision number/tag, e.g. 'rev-5' or '5'"
            },
            requestId: request.id
        });
        return false;
    }

    if (expectedRev !== currentRevision) {
        reply.header('ETag', `"rev-${currentRevision}"`);
        reply.header('x-provider-revision', String(currentRevision));
        await reply.code(412).send({
            error: {
                code: 'PRECONDITION_FAILED',
                message: `Resource revision conflict: expected ${expectedRev} but current is ${currentRevision}`,
                details: {
                    currentRevision,
                    expectedRevision: expectedRev
                }
            },
            revision: currentRevision,
            requestId: request.id
        });
        return false;
    }

    return true;
}
