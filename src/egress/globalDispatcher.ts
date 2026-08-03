/**
 * Optional global egress routing for the framework's `/v1/proxy` stream fetches.
 *
 * `@omss/framework`'s ProxyService uses the global `fetch` to pull upstream
 * streams/manifests and pipe them to the browser. To keep those fetches off a
 * datacenter IP (EC2 blocks), we install a global undici dispatcher that routes
 * proxy-worthy hosts through the residential ProxyAgent and everything else
 * (TMDB, Stremio API, localhost) directly.
 *
 * Enabled only when a proxy is configured AND SCRAPE_PROXY_STREAM=true.
 */
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';
import {
    getScrapeProxyUrl,
    isScrapeProxyStreamEnabled,
    shouldProxyHost
} from './scrapeFetch.js';

type DispatchOptions = Parameters<Dispatcher['dispatch']>[0];
type DispatchHandler = Parameters<Dispatcher['dispatch']>[1];

class HostRoutingDispatcher extends Dispatcher {
    private readonly direct: Agent;
    private readonly proxied: ProxyAgent;

    constructor(proxyUrl: string) {
        super();
        this.direct = new Agent();
        this.proxied = new ProxyAgent(proxyUrl);
    }

    dispatch(options: DispatchOptions, handler: DispatchHandler): boolean {
        let hostname = '';
        try {
            const origin = options.origin;
            const originStr =
                typeof origin === 'string' ? origin : origin?.toString();
            if (originStr) hostname = new URL(originStr).hostname;
        } catch {
            /* fall back to direct on parse failure */
        }
        const target =
            hostname && shouldProxyHost(hostname) ? this.proxied : this.direct;
        return target.dispatch(options, handler);
    }

    close(): Promise<void>;
    close(callback: () => void): void;
    close(callback?: () => void): void | Promise<void> {
        const done = Promise.all([
            this.direct.close(),
            this.proxied.close()
        ]).then(() => undefined);
        if (callback) {
            void done.then(() => callback());
            return;
        }
        return done;
    }

    destroy(): Promise<void>;
    destroy(err: Error | null): Promise<void>;
    destroy(callback: () => void): void;
    destroy(err: Error | null, callback: () => void): void;
    destroy(
        errOrCb?: Error | null | (() => void),
        maybeCb?: () => void
    ): void | Promise<void> {
        const err = typeof errOrCb === 'function' ? null : (errOrCb ?? null);
        const cb = typeof errOrCb === 'function' ? errOrCb : maybeCb;
        const done = Promise.all([
            this.direct.destroy(err),
            this.proxied.destroy(err)
        ]).then(() => undefined);
        if (cb) {
            void done.then(() => cb());
            return;
        }
        return done;
    }
}

let installed = false;

/**
 * Install the host-routing global dispatcher if stream egress is enabled.
 * Safe to call multiple times (no-op after the first successful install).
 */
export function installStreamEgress(prefix = '[egress]'): void {
    if (installed) return;
    const proxyUrl = getScrapeProxyUrl();
    if (!proxyUrl || !isScrapeProxyStreamEnabled()) return;
    try {
        setGlobalDispatcher(new HostRoutingDispatcher(proxyUrl));
        installed = true;
        console.log(
            `${prefix} stream egress routing installed (proxy-worthy hosts → residential proxy, control plane direct)`
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${prefix} failed to install stream egress: ${msg}`);
    }
}
