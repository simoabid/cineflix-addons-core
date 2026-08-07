/**
 * Immutable audit log for management mutations.
 *
 * Phase 1 persists audit events as JSON lines under the data directory
 * (or AUDIT_LOG_FILE). Each event is append-only; callers never mutate
 * prior records. A ring buffer also keeps recent events in memory for
 * privileged API access.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactValue } from './redaction.js';
import type { AuthActor, AuthMethod, Role } from './auth.js';

export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditEvent {
    id: string;
    ts: string;
    actor: {
        id: string;
        role: Role;
        method: AuthMethod;
        ip?: string;
    };
    action: string;
    target?: string;
    requestId?: string;
    /** Configuration / provider-set revision after the mutation, when known. */
    revision?: number | string;
    /** Revision before mutation (new) */
    revisionBefore?: number | string;
    /** Revision after mutation */
    revisionAfter?: number | string;
    before?: unknown;
    after?: unknown;
    outcome: AuditOutcome;
    reason?: string;
    meta?: Record<string, unknown>;
}

export interface AuditLogger {
    record(
        event: Omit<AuditEvent, 'id' | 'ts'> & { id?: string; ts?: string }
    ): Promise<AuditEvent>;
    recent(limit?: number): AuditEvent[];
}

const MEMORY_CAP = 500;

export function createAuditLogger(opts: {
    filePath?: string;
    enabled?: boolean;
    failClosed?: boolean;
}): AuditLogger {
    const enabled = opts.enabled !== false;
    const failClosed = opts.failClosed ?? process.env.NODE_ENV === 'production';
    const filePath = opts.filePath;
    const ring: AuditEvent[] = [];

    async function append(event: AuditEvent): Promise<void> {
        if (!filePath) return;
        try {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.appendFile(filePath, JSON.stringify(event) + '\n', 'utf8');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[audit] failed to append:', msg);
            if (failClosed && enabled) {
                throw new Error(`Audit append failed: ${msg}`);
            }
        }
    }

    return {
        async record(
            partial: Omit<AuditEvent, 'id' | 'ts'> & {
                id?: string;
                ts?: string;
            }
        ): Promise<AuditEvent> {
            // Central redaction: every field that may contain URLs/secrets goes through redactValue
            const redactedActor = {
                id: String(redactValue(partial.actor.id)),
                role: partial.actor.role,
                method: partial.actor.method,
                ip: partial.actor.ip
                    ? String(redactValue(partial.actor.ip))
                    : undefined
            };
            const event: AuditEvent = {
                id: partial.id ?? randomUUID(),
                ts: partial.ts ?? new Date().toISOString(),
                actor: redactedActor,
                action: String(redactValue(partial.action)),
                target:
                    partial.target !== undefined
                        ? (redactValue(partial.target) as string)
                        : undefined,
                requestId: partial.requestId
                    ? String(redactValue(partial.requestId))
                    : undefined,
                revision: partial.revision
                    ? (redactValue(partial.revision) as string | number)
                    : undefined,
                revisionBefore: partial.revisionBefore
                    ? (redactValue(partial.revisionBefore) as string | number)
                    : undefined,
                revisionAfter: partial.revisionAfter
                    ? (redactValue(partial.revisionAfter) as string | number)
                    : undefined,
                before:
                    partial.before !== undefined
                        ? redactValue(partial.before)
                        : undefined,
                after:
                    partial.after !== undefined
                        ? redactValue(partial.after)
                        : undefined,
                outcome: partial.outcome,
                reason:
                    partial.reason !== undefined
                        ? (redactValue(partial.reason) as string)
                        : undefined,
                meta: partial.meta
                    ? (redactValue(partial.meta) as Record<string, unknown>)
                    : undefined
            };

            if (!enabled) {
                if (failClosed) {
                    throw new Error(
                        'Audit is disabled but failClosed is enabled — refusing mutation'
                    );
                }
                // When audit is disabled and not fail-closed, still return event but don't persist
                return event;
            }
            ring.push(event);
            if (ring.length > MEMORY_CAP) ring.shift();
            await append(event);
            const line =
                `[audit] ${event.outcome} ${event.action}` +
                (event.target ? ` target=${event.target}` : '') +
                ` actor=${event.actor.id}/${event.actor.role}` +
                (event.requestId ? ` req=${event.requestId}` : '');
            if (event.outcome === 'denied' || event.outcome === 'failure') {
                console.warn(line, event.reason ?? '');
            } else {
                console.log(line);
            }
            return event;
        },

        recent(limit = 100): AuditEvent[] {
            const n = Math.max(1, Math.min(limit, MEMORY_CAP));
            return ring.slice(-n);
        }
    };
}

/** Helper to build actor snapshot from request auth context. */
export function actorFromAuth(
    actor: AuthActor | undefined,
    ip?: string
): AuditEvent['actor'] {
    if (!actor) {
        return { id: 'anonymous', role: 'viewer', method: 'none', ip };
    }
    return {
        id: actor.id,
        role: actor.role,
        method: actor.method,
        ip: ip ?? actor.ip
    };
}
