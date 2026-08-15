/**
 * Cluster event bus (Phase 7 §10.3).
 *
 * Multi-instance deployments coordinate through Redis pub/sub:
 *   - `revision` events tell other replicas that the provider set changed so
 *     they reload configuration from shared storage and drop stale caches.
 *   - `cache-invalidate` events drop other replicas' in-memory copies of
 *     keyspace that the origin already invalidated in Redis.
 *
 * Without Redis (single-instance dev/test) the bus degrades to a no-op —
 * local mutations already clear local state directly.
 *
 * Self-originated events are ignored on receipt (origin id equality), and
 * the revision handler treats older/equal revisions as no-ops, so event
 * replay and races are harmless.
 */

import { logger } from '../telemetry/logger.js';

export interface RevisionEvent {
    type: 'revision';
    /** Monotonic provider revision after the mutation. */
    revision: number;
    /** Emitting instance id (used to skip self-echo). */
    origin: string;
    /** What kind of mutation caused the bump (diagnostics). */
    action?: string;
}

export interface CacheInvalidateEvent {
    type: 'cache-invalidate';
    /** Key prefixes other replicas should drop from local memory. */
    prefixes: string[];
    origin: string;
}

export type ClusterEvent = RevisionEvent | CacheInvalidateEvent;

export type ClusterEventHandler = (event: ClusterEvent) => void | Promise<void>;

const CHANNEL = 'addons-core:bus:v1';

export class ClusterBus {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private pubClient: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private subClient: any = null;
    private initAttempted = false;
    private closed = false;
    private published = 0;
    private received = 0;
    private ignoredSelf = 0;
    private readonly handlers: ClusterEventHandler[] = [];

    constructor(
        private readonly opts: {
            enabled: boolean;
            instanceId: string;
            redis?: { host: string; port: number; password?: string };
        }
    ) {}

    on(handler: ClusterEventHandler): void {
        this.handlers.push(handler);
    }

    /** Connect and subscribe. Returns the operative mode. */
    async start(): Promise<'redis' | 'disabled'> {
        if (!this.opts.enabled || !this.opts.redis) {
            logger.info('Cluster bus disabled (single-instance mode)', {
                component: 'cluster'
            });
            return 'disabled';
        }
        if (this.initAttempted)
            return this.mode === 'redis' ? 'redis' : 'disabled';
        this.initAttempted = true;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mod = (await import('redis')) as any;
            const cfg = this.opts.redis;
            const auth = cfg.password
                ? `:${encodeURIComponent(cfg.password)}@`
                : '';
            const url = `redis://${auth}${cfg.host}:${cfg.port}`;

            this.subClient = mod.createClient({ url });
            this.subClient.on('error', (e: unknown) =>
                logger.debug('cluster bus subscribe client error', {
                    component: 'cluster',
                    error: e instanceof Error ? e.message : String(e)
                })
            );
            await this.subClient.connect();
            await this.subClient.subscribe(CHANNEL, (raw: string) => {
                this.receive(raw);
            });

            // Dedicated publisher connection (a subscribed client cannot send).
            this.pubClient = mod.createClient({ url });
            this.pubClient.on('error', (e: unknown) =>
                logger.debug('cluster bus publish client error', {
                    component: 'cluster',
                    error: e instanceof Error ? e.message : String(e)
                })
            );
            await this.pubClient.connect();

            logger.info(
                `Cluster bus connected (redis, channel=${CHANNEL}, instance=${this.opts.instanceId})`,
                { component: 'cluster' }
            );
            return 'redis';
        } catch (err) {
            if (this.subClient) {
                try {
                    await this.subClient.quit().catch(() => undefined);
                } catch {
                    /* ignore */
                }
                this.subClient = null;
            }
            logger.warn(
                `Cluster bus could not connect to Redis — running without cross-instance propagation: ${
                    err instanceof Error ? err.message : String(err)
                }`,
                { component: 'cluster' }
            );
            return 'disabled';
        }
    }

    private receive(raw: string): void {
        if (this.closed) return;
        try {
            const event = JSON.parse(raw) as ClusterEvent;
            if (!event || typeof event !== 'object' || !event.type) return;
            if (
                (event as { origin?: string }).origin === this.opts.instanceId
            ) {
                this.ignoredSelf++;
                return;
            }
            this.received++;
            void this.dispatchHandlers(event);
        } catch {
            /* malformed message — ignore */
        }
    }

    private async dispatchHandlers(event: ClusterEvent): Promise<void> {
        // Await handlers sequentially so reloadFromStorage ordering is
        // preserved and promise rejections are surfaced via logger.
        for (const handler of this.handlers) {
            try {
                await handler(event);
            } catch (err) {
                logger.error('Cluster bus handler failed', {
                    component: 'cluster',
                    error: err instanceof Error ? err.message : String(err)
                });
            }
        }
    }

    /** Publish an event to other replicas (fire-and-forget, best-effort). */
    async publish(event: ClusterEvent): Promise<void> {
        if (this.closed) return;
        if (!this.pubClient) return;
        try {
            await this.pubClient.publish(
                CHANNEL,
                JSON.stringify({ ...event, origin: this.opts.instanceId })
            );
            this.published++;
        } catch {
            /* best-effort */
        }
    }

    async close(): Promise<void> {
        this.closed = true;
        const closes: Array<Promise<unknown>> = [];
        for (const client of [this.subClient, this.pubClient]) {
            if (client) {
                closes.push(client.quit().catch(() => undefined));
            }
        }
        await Promise.all(closes);
        this.subClient = null;
        this.pubClient = null;
    }

    get mode(): 'redis' | 'disabled' {
        return this.pubClient ? 'redis' : 'disabled';
    }

    stats(): {
        mode: 'redis' | 'disabled';
        instanceId: string;
        published: number;
        received: number;
        ignoredSelf: number;
    } {
        return {
            mode: this.mode,
            instanceId: this.opts.instanceId,
            published: this.published,
            received: this.received,
            ignoredSelf: this.ignoredSelf
        };
    }
}
