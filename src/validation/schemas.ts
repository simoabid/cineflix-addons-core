/**
 * Runtime schema definitions and validation types for addons-core.
 * Validates path parameters, query strings, headers, and request bodies.
 */

import { assertUrlSyntax, UrlPolicyError } from '../security/urlPolicy.js';

export interface ValidationIssue {
    field: string;
    message: string;
    received?: unknown;
}

export interface ValidationResult<T = unknown> {
    ok: boolean;
    data?: T;
    errors?: ValidationIssue[];
}

export type ValidatorFn<T> = (input: unknown) => ValidationResult<T>;

// ── Object inspection helpers ────────────────────────────────────────────────

export function checkUnknownProperties(
    obj: Record<string, unknown>,
    allowedKeys: string[],
    prefix: string
): ValidationIssue[] {
    const errors: ValidationIssue[] = [];
    for (const key of Object.keys(obj)) {
        if (!allowedKeys.includes(key)) {
            errors.push({
                field: `${prefix}.${key}`,
                message: `Unknown or disallowed property '${key}'`,
                received: key
            });
        }
    }
    return errors;
}

export function checkObjectDepth(
    obj: unknown,
    maxDepth = 5,
    currentDepth = 0
): boolean {
    if (currentDepth > maxDepth) return false;
    if (obj && typeof obj === 'object') {
        for (const val of Object.values(obj as Record<string, unknown>)) {
            if (!checkObjectDepth(val, maxDepth, currentDepth + 1))
                return false;
        }
    }
    return true;
}

// ── Path parameter validators ────────────────────────────────────────────────

export const tmdbIdValidator: ValidatorFn<string> = (input) => {
    if (typeof input !== 'string') {
        return {
            ok: false,
            errors: [
                {
                    field: 'params.tmdbId',
                    message: 'Expected string for tmdbId',
                    received: input
                }
            ]
        };
    }
    const val = input.trim();
    // TMDB ID: strictly positive integer or IMDb format (tt\d+)
    if (!val || (!/^\d+$/.test(val) && !/^tt\d+$/i.test(val))) {
        return {
            ok: false,
            errors: [
                {
                    field: 'params.tmdbId',
                    message:
                        'Invalid tmdbId / media ID format: must be numeric TMDB ID or tt-prefixed IMDb ID',
                    received: val
                }
            ]
        };
    }
    return { ok: true, data: val };
};

export const seasonEpisodeValidator = (
    season: unknown,
    episode: unknown
): ValidationResult<{ season: number; episode: number }> => {
    const s = Number(season);
    const e = Number(episode);
    const errors: ValidationIssue[] = [];

    if (!Number.isInteger(s) || s < 0) {
        errors.push({
            field: 'params.season',
            message: 'Season must be a non-negative integer (>= 0)',
            received: season
        });
    }
    if (!Number.isInteger(e) || e < 1) {
        errors.push({
            field: 'params.episode',
            message: 'Episode must be a positive integer (>= 1)',
            received: episode
        });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }
    return { ok: true, data: { season: s, episode: e } };
};

export const providerIdValidator: ValidatorFn<string> = (input) => {
    if (typeof input !== 'string') {
        return {
            ok: false,
            errors: [
                {
                    field: 'params.providerId',
                    message: 'Expected string for providerId',
                    received: input
                }
            ]
        };
    }
    const val = input.trim();
    if (!val || val.length > 128 || !/^[a-zA-Z0-9_\-:]+$/.test(val)) {
        return {
            ok: false,
            errors: [
                {
                    field: 'params.providerId',
                    message:
                        'Provider ID must be 1-128 characters containing only alphanumerics, hyphens, underscores, or colons',
                    received: val
                }
            ]
        };
    }
    return { ok: true, data: val };
};

export const jobIdValidator: ValidatorFn<string> = (input) => {
    if (typeof input !== 'string') {
        return {
            ok: false,
            errors: [
                {
                    field: 'params.jobId',
                    message: 'Expected string for jobId',
                    received: input
                }
            ]
        };
    }
    const val = input.trim();
    if (!val || val.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(val)) {
        return {
            ok: false,
            errors: [
                {
                    field: 'params.jobId',
                    message: 'Job ID must be a valid non-empty identifier',
                    received: val
                }
            ]
        };
    }
    return { ok: true, data: val };
};

// ── Query parameter validators ───────────────────────────────────────────────

export interface AddonsQueryParams {
    page?: number;
    limit?: number;
    search?: string;
    capability?: 'all' | 'stream' | 'subtitles' | 'catalog' | 'meta';
    health?: 'all' | 'healthy' | 'unhealthy' | 'unknown';
    enabled?: boolean;
    admissionState?: 'all' | 'validated' | 'disabled' | 'quarantined';
    sort?: 'order' | 'name' | 'addedAt' | 'updatedAt' | 'health';
    direction?: 'asc' | 'desc';
}

export const addonsQueryValidator: ValidatorFn<AddonsQueryParams> = (input) => {
    const raw = (
        typeof input === 'object' && input !== null ? input : {}
    ) as Record<string, unknown>;
    const errors: ValidationIssue[] = [];
    const out: AddonsQueryParams = {};

    const allowed = [
        'page',
        'limit',
        'search',
        'capability',
        'health',
        'enabled',
        'admissionState',
        'sort',
        'direction'
    ];
    errors.push(...checkUnknownProperties(raw, allowed, 'query'));

    if (raw.page !== undefined) {
        const p = Number(raw.page);
        if (!Number.isInteger(p) || p < 1 || p > 1000) {
            errors.push({
                field: 'query.page',
                message: 'Page must be an integer between 1 and 1000',
                received: raw.page
            });
        } else {
            out.page = p;
        }
    }

    if (raw.limit !== undefined) {
        const l = Number(raw.limit);
        if (!Number.isInteger(l) || l < 1 || l > 200) {
            errors.push({
                field: 'query.limit',
                message: 'Limit must be an integer between 1 and 200',
                received: raw.limit
            });
        } else {
            out.limit = l;
        }
    }

    if (raw.search !== undefined) {
        if (typeof raw.search !== 'string') {
            errors.push({
                field: 'query.search',
                message: 'Search query must be a string',
                received: raw.search
            });
        } else {
            out.search = raw.search.slice(0, 100).trim();
        }
    }

    if (raw.capability !== undefined) {
        const cap = String(raw.capability).toLowerCase();
        const validCaps = ['all', 'stream', 'subtitles', 'catalog', 'meta'];
        if (!validCaps.includes(cap)) {
            errors.push({
                field: 'query.capability',
                message: `Capability filter must be one of: ${validCaps.join(', ')}`,
                received: raw.capability
            });
        } else {
            out.capability = cap as AddonsQueryParams['capability'];
        }
    }

    if (raw.health !== undefined) {
        const h = String(raw.health).toLowerCase();
        const validHealth = ['all', 'healthy', 'unhealthy', 'unknown'];
        if (!validHealth.includes(h)) {
            errors.push({
                field: 'query.health',
                message: `Health filter must be one of: ${validHealth.join(', ')}`,
                received: raw.health
            });
        } else {
            out.health = h as AddonsQueryParams['health'];
        }
    }

    if (raw.enabled !== undefined) {
        if (raw.enabled === 'true' || raw.enabled === true) out.enabled = true;
        else if (raw.enabled === 'false' || raw.enabled === false)
            out.enabled = false;
        else {
            errors.push({
                field: 'query.enabled',
                message: 'Enabled filter must be a boolean (true/false)',
                received: raw.enabled
            });
        }
    }

    if (raw.admissionState !== undefined) {
        const adm = String(raw.admissionState).toLowerCase();
        const validAdm = ['all', 'validated', 'disabled', 'quarantined'];
        if (!validAdm.includes(adm)) {
            errors.push({
                field: 'query.admissionState',
                message: `Admission state filter must be one of: ${validAdm.join(', ')}`,
                received: raw.admissionState
            });
        } else {
            out.admissionState = adm as AddonsQueryParams['admissionState'];
        }
    }

    if (raw.sort !== undefined) {
        const s = String(raw.sort);
        const validSorts = ['order', 'name', 'addedAt', 'updatedAt', 'health'];
        if (!validSorts.includes(s)) {
            errors.push({
                field: 'query.sort',
                message: `Sort field must be one of: ${validSorts.join(', ')}`,
                received: raw.sort
            });
        } else {
            out.sort = s as AddonsQueryParams['sort'];
        }
    }

    if (raw.direction !== undefined) {
        const d = String(raw.direction).toLowerCase();
        if (d !== 'asc' && d !== 'desc') {
            errors.push({
                field: 'query.direction',
                message: "Sort direction must be 'asc' or 'desc'",
                received: raw.direction
            });
        } else {
            out.direction = d;
        }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: out };
};

export interface SubtitlesQueryParams {
    tmdbId?: string;
    imdbId?: string;
    season?: number;
    episode?: number;
    language?: string;
}

export const subtitlesQueryValidator: ValidatorFn<SubtitlesQueryParams> = (
    input
) => {
    const raw = (
        typeof input === 'object' && input !== null ? input : {}
    ) as Record<string, unknown>;
    const errors: ValidationIssue[] = [];
    const out: SubtitlesQueryParams = {};

    const id = (typeof raw.id === 'string' ? raw.id : '').trim();
    const imdbId = (
        typeof raw.imdbId === 'string'
            ? raw.imdbId
            : id.startsWith('tt')
              ? id
              : ''
    ).trim();
    const tmdbId = (
        typeof raw.tmdbId === 'string'
            ? raw.tmdbId
            : !imdbId && /^\d+$/.test(id)
              ? id
              : ''
    ).trim();

    if (imdbId) {
        if (!/^tt\d+$/i.test(imdbId)) {
            errors.push({
                field: 'query.imdbId',
                message: 'Invalid IMDb ID format (expected tt1234567)',
                received: imdbId
            });
        } else {
            out.imdbId = imdbId;
        }
    }

    if (tmdbId) {
        if (!/^\d+$/.test(tmdbId)) {
            errors.push({
                field: 'query.tmdbId',
                message: 'Invalid TMDB ID format (expected numeric digits)',
                received: tmdbId
            });
        } else {
            out.tmdbId = tmdbId;
        }
    }

    if (!out.imdbId && !out.tmdbId) {
        errors.push({
            field: 'query',
            message:
                'Must provide at least one valid identifier: tmdbId, imdbId, or id'
        });
    }

    const sRaw = raw.season ?? raw.s;
    if (sRaw !== undefined && sRaw !== '') {
        const s = Number(sRaw);
        if (!Number.isInteger(s) || s < 0) {
            errors.push({
                field: 'query.season',
                message: 'Season must be a non-negative integer (>= 0)',
                received: sRaw
            });
        } else {
            out.season = s;
        }
    }

    const eRaw = raw.episode ?? raw.e;
    if (eRaw !== undefined && eRaw !== '') {
        const e = Number(eRaw);
        if (!Number.isInteger(e) || e < 1) {
            errors.push({
                field: 'query.episode',
                message: 'Episode must be a positive integer (>= 1)',
                received: eRaw
            });
        } else {
            out.episode = e;
        }
    }

    if (raw.language !== undefined) {
        if (typeof raw.language !== 'string') {
            errors.push({
                field: 'query.language',
                message: 'Language must be a string code (e.g. eng, spa)',
                received: raw.language
            });
        } else {
            out.language = raw.language.slice(0, 10).trim();
        }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: out };
};

export interface JobsQueryParams {
    page?: number;
    limit?: number;
    type?: string;
    status?:
        | 'queued'
        | 'running'
        | 'completed'
        | 'failed'
        | 'cancelled'
        | 'dead_letter';
}

export const jobsQueryValidator: ValidatorFn<JobsQueryParams> = (input) => {
    const raw = (
        typeof input === 'object' && input !== null ? input : {}
    ) as Record<string, unknown>;
    const errors: ValidationIssue[] = [];
    const out: JobsQueryParams = {};

    errors.push(
        ...checkUnknownProperties(
            raw,
            ['page', 'limit', 'type', 'status'],
            'query'
        )
    );

    if (raw.page !== undefined) {
        const p = Number(raw.page);
        if (!Number.isInteger(p) || p < 1 || p > 1000) {
            errors.push({
                field: 'query.page',
                message: 'Page must be an integer between 1 and 1000',
                received: raw.page
            });
        } else {
            out.page = p;
        }
    }

    if (raw.limit !== undefined) {
        const l = Number(raw.limit);
        if (!Number.isInteger(l) || l < 1 || l > 200) {
            errors.push({
                field: 'query.limit',
                message: 'Limit must be an integer between 1 and 200',
                received: raw.limit
            });
        } else {
            out.limit = l;
        }
    }

    if (raw.type !== undefined) {
        if (typeof raw.type !== 'string' || !raw.type.trim()) {
            errors.push({
                field: 'query.type',
                message: 'Type must be a non-empty string',
                received: raw.type
            });
        } else {
            out.type = raw.type.trim();
        }
    }

    if (raw.status !== undefined) {
        const valid = [
            'queued',
            'running',
            'completed',
            'failed',
            'cancelled',
            'dead_letter'
        ];
        if (!valid.includes(String(raw.status))) {
            errors.push({
                field: 'query.status',
                message: `Status must be one of: ${valid.join(', ')}`,
                received: raw.status
            });
        } else {
            out.status = raw.status as JobsQueryParams['status'];
        }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: out };
};

export interface AuditQueryParams {
    page?: number;
    limit?: number;
    action?: string;
    outcome?: 'success' | 'failure' | 'denied';
    since?: string;
    until?: string;
}

export const auditQueryValidator: ValidatorFn<AuditQueryParams> = (input) => {
    const raw = (
        typeof input === 'object' && input !== null ? input : {}
    ) as Record<string, unknown>;
    const errors: ValidationIssue[] = [];
    const out: AuditQueryParams = {};

    errors.push(
        ...checkUnknownProperties(
            raw,
            ['page', 'limit', 'action', 'outcome', 'since', 'until'],
            'query'
        )
    );

    if (raw.page !== undefined) {
        const p = Number(raw.page);
        if (!Number.isInteger(p) || p < 1 || p > 1000) {
            errors.push({
                field: 'query.page',
                message: 'Page must be an integer between 1 and 1000',
                received: raw.page
            });
        } else {
            out.page = p;
        }
    }

    if (raw.limit !== undefined) {
        const l = Number(raw.limit);
        if (!Number.isInteger(l) || l < 1 || l > 200) {
            errors.push({
                field: 'query.limit',
                message: 'Limit must be an integer between 1 and 200',
                received: raw.limit
            });
        } else {
            out.limit = l;
        }
    }

    if (raw.action !== undefined) {
        if (typeof raw.action !== 'string' || !raw.action.trim()) {
            errors.push({
                field: 'query.action',
                message: 'Action must be a non-empty string',
                received: raw.action
            });
        } else {
            out.action = raw.action.trim();
        }
    }

    if (raw.outcome !== undefined) {
        const valid = ['success', 'failure', 'denied'];
        if (!valid.includes(String(raw.outcome))) {
            errors.push({
                field: 'query.outcome',
                message: `Outcome must be one of: ${valid.join(', ')}`,
                received: raw.outcome
            });
        } else {
            out.outcome = raw.outcome as AuditQueryParams['outcome'];
        }
    }

    if (raw.since !== undefined) {
        const d = new Date(String(raw.since));
        if (isNaN(d.getTime())) {
            errors.push({
                field: 'query.since',
                message: 'Since must be a valid ISO date string',
                received: raw.since
            });
        } else {
            out.since = d.toISOString();
        }
    }

    if (raw.until !== undefined) {
        const d = new Date(String(raw.until));
        if (isNaN(d.getTime())) {
            errors.push({
                field: 'query.until',
                message: 'Until must be a valid ISO date string',
                received: raw.until
            });
        } else {
            out.until = d.toISOString();
        }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: out };
};

export interface MetricsQueryParams {
    format?: 'prometheus' | 'json';
}

export const metricsQueryValidator: ValidatorFn<MetricsQueryParams> = (
    input
) => {
    const raw = (
        typeof input === 'object' && input !== null ? input : {}
    ) as Record<string, unknown>;
    const errors: ValidationIssue[] = [];
    const out: MetricsQueryParams = {};

    errors.push(...checkUnknownProperties(raw, ['format'], 'query'));

    if (raw.format !== undefined) {
        const f = String(raw.format).toLowerCase();
        if (f !== 'prometheus' && f !== 'json') {
            errors.push({
                field: 'query.format',
                message: "Format must be 'prometheus' or 'json'",
                received: raw.format
            });
        } else {
            out.format = f;
        }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: out };
};

// ── Request body validators ──────────────────────────────────────────────────

export interface PatchAddonBody {
    enabled?: boolean;
    timeoutMs?: number;
}

export const patchAddonBodyValidator: ValidatorFn<PatchAddonBody> = (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return {
            ok: false,
            errors: [
                {
                    field: 'body',
                    message: 'Request body must be a JSON object',
                    received: input
                }
            ]
        };
    }
    const b = input as Record<string, unknown>;
    const errors: ValidationIssue[] = [];
    const out: PatchAddonBody = {};

    errors.push(...checkUnknownProperties(b, ['enabled', 'timeoutMs'], 'body'));

    if (b.enabled !== undefined) {
        if (typeof b.enabled !== 'boolean') {
            errors.push({
                field: 'body.enabled',
                message: 'Expected boolean for enabled',
                received: b.enabled
            });
        } else {
            out.enabled = b.enabled;
        }
    }

    if (b.timeoutMs !== undefined) {
        const t = Number(b.timeoutMs);
        if (!Number.isInteger(t) || t < 1000 || t > 120_000) {
            errors.push({
                field: 'body.timeoutMs',
                message:
                    'Timeout must be an integer between 1000 and 120000 ms',
                received: b.timeoutMs
            });
        } else {
            out.timeoutMs = t;
        }
    }

    if (b.enabled === undefined && b.timeoutMs === undefined) {
        errors.push({
            field: 'body',
            message:
                'Must provide at least one field to update: enabled or timeoutMs'
        });
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: out };
};

export interface ReorderAddonsBody {
    order: string[];
}

export const reorderAddonsBodyValidator: ValidatorFn<ReorderAddonsBody> = (
    input
) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return {
            ok: false,
            errors: [
                {
                    field: 'body',
                    message: 'Request body must be a JSON object',
                    received: input
                }
            ]
        };
    }
    const b = input as Record<string, unknown>;
    const errors: ValidationIssue[] = [];

    errors.push(...checkUnknownProperties(b, ['order'], 'body'));

    if (!Array.isArray(b.order) || b.order.length === 0) {
        return {
            ok: false,
            errors: [
                {
                    field: 'body.order',
                    message:
                        'Field order must be a non-empty array of provider IDs',
                    received: b.order
                }
            ]
        };
    }

    if (b.order.length > 200) {
        return {
            ok: false,
            errors: [
                {
                    field: 'body.order',
                    message: 'Order list exceeds maximum of 200 items',
                    received: b.order.length
                }
            ]
        };
    }

    for (let i = 0; i < b.order.length; i++) {
        const item = b.order[i];
        if (typeof item !== 'string' || !item.trim() || item.length > 128) {
            errors.push({
                field: `body.order[${i}]`,
                message: 'Each order item must be a valid provider ID string',
                received: item
            });
        }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: { order: b.order as string[] } };
};

export interface ImportUrlBody {
    url?: string;
    urls?: string[];
    enable?: boolean;
}

export const importUrlBodyValidator: ValidatorFn<ImportUrlBody> = (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return {
            ok: false,
            errors: [
                {
                    field: 'body',
                    message: 'Request body must be a JSON object',
                    received: input
                }
            ]
        };
    }
    const b = input as Record<string, unknown>;
    const errors: ValidationIssue[] = [];
    const out: ImportUrlBody = {};

    errors.push(
        ...checkUnknownProperties(b, ['url', 'urls', 'enable'], 'body')
    );

    if (b.enable !== undefined) {
        if (typeof b.enable !== 'boolean') {
            errors.push({
                field: 'body.enable',
                message: 'Expected boolean for enable',
                received: b.enable
            });
        } else {
            out.enable = b.enable;
        }
    }

    const validateSingleUrl = (
        rawUrl: unknown,
        fieldName: string
    ): string | null => {
        if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
            errors.push({
                field: fieldName,
                message: 'URL must be a non-empty string',
                received: rawUrl
            });
            return null;
        }
        const trimmed = rawUrl.trim();
        if (trimmed.length > 4096) {
            errors.push({
                field: fieldName,
                message: 'URL exceeds maximum length of 4096 characters'
            });
            return null;
        }
        try {
            assertUrlSyntax(trimmed, { allowHttp: true });
            return trimmed;
        } catch (err) {
            const msg =
                err instanceof UrlPolicyError
                    ? err.message
                    : 'Invalid or disallowed URL scheme/host';
            errors.push({ field: fieldName, message: msg, received: trimmed });
            return null;
        }
    };

    if (b.url !== undefined) {
        const valid = validateSingleUrl(b.url, 'body.url');
        if (valid) out.url = valid;
    }

    if (b.urls !== undefined) {
        if (!Array.isArray(b.urls)) {
            errors.push({
                field: 'body.urls',
                message: 'Field urls must be an array of strings',
                received: b.urls
            });
        } else if (b.urls.length > 200) {
            errors.push({
                field: 'body.urls',
                message: 'Batch import exceeds maximum of 200 URLs',
                received: b.urls.length
            });
        } else {
            const list: string[] = [];
            for (let i = 0; i < b.urls.length; i++) {
                const valid = validateSingleUrl(b.urls[i], `body.urls[${i}]`);
                if (valid) list.push(valid);
            }
            out.urls = list;
        }
    }

    if (!out.url && (!out.urls || out.urls.length === 0)) {
        errors.push({
            field: 'body',
            message: 'Must provide at least one valid URL via url or urls'
        });
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: out };
};

export interface ImportStremioBody {
    authKey?: string;
    email?: string;
    password?: string;
    enable?: boolean;
}

export interface ImportStremioBody {
    authKey?: string;
    email?: string;
    password?: string;
    endpoint?: string;
    enable?: boolean;
}

export const importStremioBodyValidator: ValidatorFn<ImportStremioBody> = (
    input
) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return {
            ok: false,
            errors: [
                {
                    field: 'body',
                    message: 'Request body must be a JSON object',
                    received: input
                }
            ]
        };
    }
    const b = input as Record<string, unknown>;
    const errors: ValidationIssue[] = [];
    const out: ImportStremioBody = {};

    errors.push(
        ...checkUnknownProperties(
            b,
            ['authKey', 'email', 'password', 'endpoint', 'enable'],
            'body'
        )
    );

    if (b.enable !== undefined) {
        if (typeof b.enable !== 'boolean') {
            errors.push({
                field: 'body.enable',
                message: 'Expected boolean for enable',
                received: b.enable
            });
        } else {
            out.enable = b.enable;
        }
    }

    if (b.authKey !== undefined) {
        if (
            typeof b.authKey !== 'string' ||
            !b.authKey.trim() ||
            b.authKey.length > 512
        ) {
            errors.push({
                field: 'body.authKey',
                message:
                    'authKey must be a non-empty string under 512 characters'
            });
        } else {
            out.authKey = b.authKey.trim();
        }
    }

    if (b.email !== undefined) {
        if (
            typeof b.email !== 'string' ||
            !b.email.trim() ||
            !b.email.includes('@')
        ) {
            errors.push({
                field: 'body.email',
                message: 'email must be a valid email address'
            });
        } else {
            out.email = b.email.trim();
        }
    }

    if (b.password !== undefined) {
        if (typeof b.password !== 'string' || !b.password) {
            errors.push({
                field: 'body.password',
                message: 'password must be a non-empty string'
            });
        } else {
            out.password = b.password;
        }
    }

    if (b.endpoint !== undefined) {
        if (
            typeof b.endpoint !== 'string' ||
            !b.endpoint.trim() ||
            b.endpoint.length > 2048
        ) {
            errors.push({
                field: 'body.endpoint',
                message:
                    'endpoint must be a valid URL string under 2048 characters',
                received: b.endpoint
            });
        } else {
            const trimmed = b.endpoint.trim();
            try {
                assertUrlSyntax(trimmed, { allowHttp: true });
                out.endpoint = trimmed;
            } catch (err) {
                const msg =
                    err instanceof UrlPolicyError
                        ? err.message
                        : 'Invalid or disallowed endpoint URL';
                errors.push({
                    field: 'body.endpoint',
                    message: msg,
                    received: trimmed
                });
            }
        }
    }

    if (!out.authKey && (!out.email || !out.password)) {
        errors.push({
            field: 'body',
            message: 'Must provide either authKey or both email and password'
        });
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: out };
};

export interface ImportRepoBody {
    url: string;
    enable?: boolean;
}

export const importRepoBodyValidator: ValidatorFn<ImportRepoBody> = (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return {
            ok: false,
            errors: [
                {
                    field: 'body',
                    message: 'Request body must be a JSON object',
                    received: input
                }
            ]
        };
    }
    const b = input as Record<string, unknown>;
    const errors: ValidationIssue[] = [];
    const out: Partial<ImportRepoBody> = {};

    errors.push(...checkUnknownProperties(b, ['url', 'enable'], 'body'));

    if (b.enable !== undefined) {
        if (typeof b.enable !== 'boolean') {
            errors.push({
                field: 'body.enable',
                message: 'Expected boolean for enable',
                received: b.enable
            });
        } else {
            out.enable = b.enable;
        }
    }

    if (typeof b.url !== 'string' || !b.url.trim()) {
        errors.push({
            field: 'body.url',
            message: 'Repository URL must be a non-empty string',
            received: b.url
        });
    } else {
        const trimmed = b.url.trim();
        try {
            assertUrlSyntax(trimmed, { allowHttp: true });
            out.url = trimmed;
        } catch (err) {
            const msg =
                err instanceof UrlPolicyError
                    ? err.message
                    : 'Invalid or disallowed repository URL';
            errors.push({ field: 'body.url', message: msg, received: trimmed });
        }
    }

    if (errors.length > 0 || !out.url) return { ok: false, errors };
    return { ok: true, data: out as ImportRepoBody };
};

export interface CreateJobBody {
    type: string;
    payload?: Record<string, unknown>;
    priority?: number;
    idempotencyKey?: string;
}

export const createJobBodyValidator: ValidatorFn<CreateJobBody> = (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return {
            ok: false,
            errors: [
                {
                    field: 'body',
                    message: 'Request body must be a JSON object',
                    received: input
                }
            ]
        };
    }
    const b = input as Record<string, unknown>;
    const errors: ValidationIssue[] = [];
    const out: CreateJobBody = { type: '' };

    errors.push(
        ...checkUnknownProperties(
            b,
            ['type', 'payload', 'priority', 'idempotencyKey'],
            'body'
        )
    );

    if (typeof b.type !== 'string' || !b.type.trim()) {
        errors.push({
            field: 'body.type',
            message: 'Job type must be a non-empty string',
            received: b.type
        });
    } else {
        out.type = b.type.trim();
    }

    if (b.payload !== undefined) {
        if (
            typeof b.payload !== 'object' ||
            b.payload === null ||
            Array.isArray(b.payload)
        ) {
            errors.push({
                field: 'body.payload',
                message: 'Job payload must be an object',
                received: b.payload
            });
        } else if (!checkObjectDepth(b.payload, 5)) {
            errors.push({
                field: 'body.payload',
                message: 'Job payload exceeds maximum nesting depth of 5'
            });
        } else {
            out.payload = b.payload as Record<string, unknown>;
        }
    }

    if (b.priority !== undefined) {
        const p = Number(b.priority);
        if (!Number.isInteger(p) || p < 1 || p > 10) {
            errors.push({
                field: 'body.priority',
                message: 'Job priority must be an integer between 1 and 10',
                received: b.priority
            });
        } else {
            out.priority = p;
        }
    }

    if (b.idempotencyKey !== undefined) {
        if (
            typeof b.idempotencyKey !== 'string' ||
            !b.idempotencyKey.trim() ||
            b.idempotencyKey.length > 128
        ) {
            errors.push({
                field: 'body.idempotencyKey',
                message: 'Idempotency key must be a string up to 128 characters'
            });
        } else {
            out.idempotencyKey = b.idempotencyKey.trim();
        }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: out };
};

export interface DebridTransferBody {
    infoHash: string;
    provider?: 'realdebrid' | 'alldebrid' | 'premiumize';
    name?: string;
    title?: string;
    season?: number;
    episode?: number;
    fileIdx?: number;
    sources?: string[];
    maxWaitSec?: number;
}

export const debridTransferBodyValidator: ValidatorFn<DebridTransferBody> = (
    input
) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return {
            ok: false,
            errors: [
                {
                    field: 'body',
                    message: 'Request body must be a JSON object',
                    received: input
                }
            ]
        };
    }
    const b = input as Record<string, unknown>;
    const errors: ValidationIssue[] = [];
    const out: Partial<DebridTransferBody> = {};

    errors.push(
        ...checkUnknownProperties(
            b,
            [
                'infoHash',
                'provider',
                'name',
                'title',
                'season',
                'episode',
                'fileIdx',
                'sources',
                'maxWaitSec'
            ],
            'body'
        )
    );

    if (typeof b.infoHash !== 'string' || !b.infoHash.trim()) {
        errors.push({
            field: 'body.infoHash',
            message: 'infoHash is required and must be a string',
            received: b.infoHash
        });
    } else {
        const h = b.infoHash.trim();
        const isHex = /^[0-9a-fA-F]{40}$/.test(h);
        const isBase32 = /^[2-7a-zA-Z=]{32,40}$/.test(h);
        if (!isHex && !isBase32) {
            errors.push({
                field: 'body.infoHash',
                message:
                    'Invalid infoHash format: must be 40-character hex or 32-character base32 SHA-1 hash',
                received: h
            });
        } else {
            out.infoHash = h.toLowerCase();
        }
    }

    if (b.provider !== undefined) {
        const p = String(b.provider).toLowerCase();
        if (p !== 'realdebrid' && p !== 'alldebrid' && p !== 'premiumize') {
            errors.push({
                field: 'body.provider',
                message:
                    "Provider must be one of: 'realdebrid', 'alldebrid', 'premiumize'",
                received: b.provider
            });
        } else {
            out.provider = p as DebridTransferBody['provider'];
        }
    }

    if (b.name !== undefined) {
        out.name =
            typeof b.name === 'string' ? b.name.slice(0, 200) : undefined;
    }

    if (b.title !== undefined) {
        if (typeof b.title !== 'string' || b.title.length > 200) {
            errors.push({
                field: 'body.title',
                message: 'Title must be a string up to 200 characters',
                received: b.title
            });
        } else {
            out.title = b.title;
        }
    }

    if (b.season !== undefined) {
        const s = Number(b.season);
        if (!Number.isInteger(s) || s < 0) {
            errors.push({
                field: 'body.season',
                message: 'Season must be a non-negative integer',
                received: b.season
            });
        } else {
            out.season = s;
        }
    }

    if (b.episode !== undefined) {
        const e = Number(b.episode);
        if (!Number.isInteger(e) || e < 1) {
            errors.push({
                field: 'body.episode',
                message: 'Episode must be a positive integer (>= 1)',
                received: b.episode
            });
        } else {
            out.episode = e;
        }
    }

    if (b.fileIdx !== undefined) {
        const idx = Number(b.fileIdx);
        if (!Number.isInteger(idx) || idx < 0) {
            errors.push({
                field: 'body.fileIdx',
                message: 'fileIdx must be a non-negative integer (>= 0)',
                received: b.fileIdx
            });
        } else {
            out.fileIdx = idx;
        }
    }

    if (b.sources !== undefined) {
        if (
            !Array.isArray(b.sources) ||
            b.sources.length < 1 ||
            b.sources.length > 100
        ) {
            errors.push({
                field: 'body.sources',
                message: 'sources must be an array of 1 to 100 URLs',
                received: b.sources
            });
        } else {
            const validSources: string[] = [];
            for (let i = 0; i < b.sources.length; i++) {
                const item = b.sources[i];
                if (typeof item !== 'string' || !item.trim()) {
                    errors.push({
                        field: `body.sources[${i}]`,
                        message: 'source URL must be a non-empty string',
                        received: item
                    });
                } else {
                    const trimmed = item.trim();
                    try {
                        assertUrlSyntax(trimmed, { allowHttp: true });
                        validSources.push(trimmed);
                    } catch (err) {
                        const msg =
                            err instanceof UrlPolicyError
                                ? err.message
                                : 'Invalid or disallowed source URL';
                        errors.push({
                            field: `body.sources[${i}]`,
                            message: msg,
                            received: trimmed
                        });
                    }
                }
            }
            if (errors.length === 0) {
                out.sources = validSources;
            }
        }
    }

    if (b.maxWaitSec !== undefined) {
        const w = Number(b.maxWaitSec);
        if (!Number.isInteger(w) || w < 1 || w > 600) {
            errors.push({
                field: 'body.maxWaitSec',
                message: 'maxWaitSec must be an integer between 1 and 600',
                received: b.maxWaitSec
            });
        } else {
            out.maxWaitSec = w;
        }
    }

    if (errors.length > 0 || !out.infoHash) return { ok: false, errors };
    return { ok: true, data: out as DebridTransferBody };
};

export interface PatchDebridBody {
    enabled?: boolean;
    apiKey?: string;
    provider?: 'realdebrid' | 'alldebrid' | 'premiumize';
    autoDownloadUncached?: boolean;
    rateLimitPerMin?: number;
}

export const patchDebridBodyValidator: ValidatorFn<PatchDebridBody> = (
    input
) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return {
            ok: false,
            errors: [
                {
                    field: 'body',
                    message: 'Request body must be a JSON object',
                    received: input
                }
            ]
        };
    }
    const b = input as Record<string, unknown>;
    const errors: ValidationIssue[] = [];
    const out: PatchDebridBody = {};

    errors.push(
        ...checkUnknownProperties(
            b,
            [
                'enabled',
                'apiKey',
                'provider',
                'autoDownloadUncached',
                'rateLimitPerMin'
            ],
            'body'
        )
    );

    if (b.enabled !== undefined) {
        if (typeof b.enabled !== 'boolean') {
            errors.push({
                field: 'body.enabled',
                message: 'Expected boolean for enabled',
                received: b.enabled
            });
        } else {
            out.enabled = b.enabled;
        }
    }

    if (b.apiKey !== undefined) {
        if (typeof b.apiKey !== 'string' || b.apiKey.length > 1024) {
            errors.push({
                field: 'body.apiKey',
                message: 'API key must be a string up to 1024 characters'
            });
        } else {
            out.apiKey = b.apiKey.trim();
        }
    }

    if (b.provider !== undefined) {
        const p = String(b.provider).toLowerCase();
        if (p !== 'realdebrid' && p !== 'alldebrid' && p !== 'premiumize') {
            errors.push({
                field: 'body.provider',
                message:
                    "Provider must be one of: 'realdebrid', 'alldebrid', 'premiumize'",
                received: b.provider
            });
        } else {
            out.provider = p as PatchDebridBody['provider'];
        }
    }

    if (b.autoDownloadUncached !== undefined) {
        if (typeof b.autoDownloadUncached !== 'boolean') {
            errors.push({
                field: 'body.autoDownloadUncached',
                message: 'Expected boolean for autoDownloadUncached'
            });
        } else {
            out.autoDownloadUncached = b.autoDownloadUncached;
        }
    }

    if (b.rateLimitPerMin !== undefined) {
        const r = Number(b.rateLimitPerMin);
        if (!Number.isInteger(r) || r < 10 || r > 600) {
            errors.push({
                field: 'body.rateLimitPerMin',
                message: 'Rate limit must be between 10 and 600 req/min',
                received: b.rateLimitPerMin
            });
        } else {
            out.rateLimitPerMin = r;
        }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: out };
};
