import type { JobHandlerContext } from '../types.js';
import { importFromUrl } from '../../import/url.js';
import { importFromRepository } from '../../import/repository.js';
import { importFromStremioAccount } from '../../import/stremioAccount.js';
import { toPublicAddon } from '../../addons/manager.js';

export async function multiAddonImportHandler(
    ctx: JobHandlerContext
): Promise<unknown> {
    const urls = ctx.job.payload.urls as string[] | undefined;
    const enable = ctx.job.payload.enable as boolean | undefined;

    if (!Array.isArray(urls) || urls.length === 0) {
        throw new Error("Invalid payload: 'urls' must be a non-empty string array");
    }

    const total = urls.length;
    let completed = 0;
    const results = [];

    for (let i = 0; i < urls.length; i++) {
        if (ctx.signal.aborted) {
            throw Object.assign(new Error('Job cancelled'), {
                name: 'AbortError',
                code: 'CANCELLED'
            });
        }

        const url = urls[i];
        const res = await importFromUrl(ctx.manager, url, {
            enable,
            signal: ctx.signal
        });
        results.push(res);
        completed++;

        await ctx.updateProgress(Math.round((completed / total) * 100));
        await ctx.heartbeat();
    }

    const installed = results.filter((r) => r.ok).length;
    return {
        ok: true,
        installed,
        total,
        results: results.map((r) => ({
            ok: r.ok,
            error: r.error,
            updated: r.updated,
            findings: r.findings,
            addon: r.addon ? toPublicAddon(r.addon) : undefined
        }))
    };
}

export async function repositoryImportHandler(
    ctx: JobHandlerContext
): Promise<unknown> {
    const url = ctx.job.payload.url as string | undefined;
    if (!url || typeof url !== 'string') {
        throw new Error("Invalid payload: 'url' string is required");
    }

    await ctx.updateProgress(10);
    const result = await importFromRepository(ctx.manager, url.trim(), {
        cfg: ctx.cfg,
        signal: ctx.signal
    });
    await ctx.updateProgress(100);

    return {
        ok: true,
        ...result,
        results: result.results.map((r) => ({
            ok: r.ok,
            error: r.error,
            updated: r.updated,
            findings: r.findings,
            addon: r.addon ? toPublicAddon(r.addon) : undefined
        }))
    };
}

export async function stremioAccountImportHandler(
    ctx: JobHandlerContext
): Promise<unknown> {
    const { email, password, authKey, endpoint } = ctx.job.payload as {
        email?: string;
        password?: string;
        authKey?: string;
        endpoint?: string;
    };

    if (!authKey && (!email || !password)) {
        throw new Error("Provide 'authKey' or 'email' and 'password'");
    }

    await ctx.updateProgress(15);
    const result = await importFromStremioAccount(ctx.manager, {
        email,
        password,
        authKey,
        endpoint
    });
    await ctx.updateProgress(100);

    return {
        ok: true,
        ...result,
        results: result.results?.map((r) => ({
            ok: r.ok,
            error: r.error,
            updated: r.updated,
            findings: r.findings,
            addon: r.addon ? toPublicAddon(r.addon) : undefined
        }))
    };
}
