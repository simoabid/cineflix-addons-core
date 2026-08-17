/**
 * addons-core Operator Console · Admin Client Script
 * Strictly adheres to Phase 8 requirements:
 * - Pure CSP compliance (0 inline scripts, 0 external network font requests)
 * - Safe HttpOnly session auth + double-submit CSRF
 * - Optimistic concurrency on mutations (with If-Match guards excluded from auth)
 * - Role-gated tabs (Metrics & Audit admin-only)
 * - Accessible modals with focus trap/restore & keyboard reordering
 * - Comprehensive telemetry, health freshness, queue depth & provider rankings
 */

'use strict';

// ── Application State ────────────────────────────────────────────────────────
const state = {
    actor: { id: 'anonymous', role: 'viewer', method: 'none' },
    authMode: 'disabled',
    csrfToken: '',
    revision: 0,
    activeView: 'providers',

    // Providers state
    addons: [],
    pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
    filters: {
        search: '',
        capability: 'all',
        health: 'all',
        state: 'all',
        sort: 'order',
        direction: 'asc'
    },
    draggedIndex: null,

    // Subsystems cache
    quarantined: [],
    circuits: {},
    jobs: [],
    metrics: null,
    health: null,
    auditLogs: [],
    settings: {},

    // Timers
    healthPollTimer: null,
    jobsPollTimer: null
};

let lastFocusedElement = null;

// ── Role & Permission Helpers ────────────────────────────────────────────────
function canOperate() {
    return state.actor.role === 'operator' || state.actor.role === 'admin';
}

function isAdmin() {
    return state.actor.role === 'admin';
}

function updatePermissionUI() {
    const isOp = canOperate();
    const isAdm = isAdmin();

    // Role-gated controls
    document.querySelectorAll('[data-require-role]').forEach((el) => {
        const req = el.dataset.requireRole;
        if (req === 'admin') {
            el.disabled = !isAdm;
            if (!isAdm) {
                el.title = 'Requires administrator privileges';
                if (el.classList.contains('nav-tab')) {
                    el.classList.add('tab-locked');
                }
            } else {
                el.title = '';
                el.classList.remove('tab-locked');
            }
        } else if (req === 'operator') {
            el.disabled = !isOp;
            if (!isOp)
                el.title = 'Requires operator or administrator privileges';
            else el.title = '';
        }
    });

    // If viewer is currently on an admin tab, bounce to providers
    if (
        !isAdm &&
        (state.activeView === 'metrics' || state.activeView === 'audit')
    ) {
        switchTab('providers');
    }

    // Update Actor Pill in Topbar
    const actorRoleEl = document.getElementById('actor-role');
    const actorIdEl = document.getElementById('actor-id');
    const authBtn = document.getElementById('auth-btn');

    if (actorRoleEl) {
        actorRoleEl.textContent = state.actor.role.toUpperCase();
        actorRoleEl.className =
            'actor-role badge ' +
            (state.actor.role === 'admin'
                ? 'badge-ok'
                : state.actor.role === 'operator'
                  ? 'badge-stream'
                  : 'badge-meta');
    }
    if (actorIdEl) actorIdEl.textContent = state.actor.id;
    if (authBtn) {
        authBtn.textContent =
            state.actor.id !== 'anonymous' && state.actor.method !== 'none'
                ? 'Sign out'
                : 'Sign in';
    }
}

// ── CSRF & Headers ───────────────────────────────────────────────────────────
function getCsrfFromCookie() {
    const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
}

function buildHeaders(extra = {}, method = 'GET', path = '') {
    const headers = Object.assign({ Accept: 'application/json' }, extra);
    const m = method.toUpperCase();

    if (m !== 'GET' && m !== 'HEAD') {
        const csrf = state.csrfToken || getCsrfFromCookie();
        if (csrf) headers['x-csrf-token'] = csrf;

        // Apply If-Match only to provider/quarantine/settings mutation routes, NEVER auth or jobs
        const isMutationPath =
            path.includes('/v1/addons') ||
            path.includes('/v1/quarantine') ||
            path.includes('/v1/settings');
        const isAuthOrJob =
            path.startsWith('/v1/auth') ||
            path.startsWith('/v1/jobs') ||
            path.startsWith('/health');

        if (
            state.revision > 0 &&
            !headers['If-Match'] &&
            isMutationPath &&
            !isAuthOrJob
        ) {
            headers['If-Match'] = `"rev-${state.revision}"`;
        }
    }
    return headers;
}

// ── API Network Client ───────────────────────────────────────────────────────
async function api(path, options = {}) {
    const method = options.method || 'GET';
    const opts = Object.assign({ credentials: 'same-origin' }, options);
    opts.headers = buildHeaders(opts.headers, method, path);

    let res;
    try {
        res = await fetch(path, opts);
    } catch (err) {
        setOfflineState(true);
        throw new Error(`Network error: ${err.message}`);
    }
    setOfflineState(false);

    // Track latest configuration revision from headers
    const revHeader = res.headers.get('x-provider-revision');
    if (revHeader) {
        const revNum = parseInt(revHeader, 10);
        if (!isNaN(revNum) && revNum > state.revision) {
            state.revision = revNum;
            updateRevisionUI();
        }
    }

    let body = null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        try {
            body = await res.json();
        } catch (_) {
            /* ignore json parse failure */
        }
    } else {
        body = await res.text();
    }

    if (res.status === 401) {
        state.actor = { id: 'anonymous', role: 'viewer', method: 'none' };
        updatePermissionUI();
        openModal('auth-dialog');
        const err = new Error('Authentication required');
        err.requestId = body?.requestId || res.headers.get('x-request-id');
        throw err;
    }

    if (res.status === 403) {
        const err = new Error('Forbidden: insufficient role permissions');
        err.requestId = body?.requestId || res.headers.get('x-request-id');
        throw err;
    }

    if (res.status === 412 || res.status === 409) {
        toast('Configuration was modified concurrently. Reloading…', 'warn');
        loadAddons();
        const err = new Error('Concurrent revision conflict');
        err.requestId = body?.requestId;
        throw err;
    }

    if (!res.ok) {
        const msg =
            (body && (body.error?.message || body.error || body.message)) ||
            `HTTP ${res.status}`;
        const err = new Error(
            typeof msg === 'string' ? msg : JSON.stringify(msg)
        );
        err.code = body?.error?.code || 'ERROR';
        err.requestId = body?.requestId || res.headers.get('x-request-id');
        throw err;
    }

    return body;
}

// ── Toast Notification System ────────────────────────────────────────────────
function toast(message, kind = 'info', meta = {}) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast ${kind}`;

    const header = document.createElement('div');
    header.className = 'toast-header';
    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = message;
    header.appendChild(msgSpan);
    el.appendChild(header);

    if (meta.requestId || meta.jobId) {
        const footer = document.createElement('div');
        footer.className = 'toast-footer';

        if (meta.requestId) {
            const reqSpan = document.createElement('span');
            reqSpan.className = 'toast-req-id';
            reqSpan.textContent = `req: ${meta.requestId.slice(0, 8)}…`;
            const copyBtn = document.createElement('button');
            copyBtn.className = 'toast-btn';
            copyBtn.type = 'button';
            copyBtn.textContent = 'Copy ID';
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(meta.requestId);
                copyBtn.textContent = 'Copied!';
                setTimeout(() => (copyBtn.textContent = 'Copy ID'), 2000);
            });
            footer.appendChild(reqSpan);
            footer.appendChild(copyBtn);
        }

        if (meta.jobId) {
            const jobBtn = document.createElement('button');
            jobBtn.className = 'toast-btn';
            jobBtn.type = 'button';
            jobBtn.textContent = 'View Job';
            jobBtn.addEventListener('click', () => {
                switchTab('jobs');
            });
            footer.appendChild(jobBtn);
        }
        el.appendChild(footer);
    }

    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(10px)';
        el.style.transition = 'opacity 0.2s, transform 0.2s';
        setTimeout(() => el.remove(), 250);
    }, 4500);
}

function busy(btn, isBusy, busyText = 'Working…') {
    if (!btn) return;
    btn.disabled = isBusy;
    if (isBusy) {
        btn.dataset.originalLabel = btn.textContent;
        btn.textContent = busyText;
    } else if (btn.dataset.originalLabel) {
        btn.textContent = btn.dataset.originalLabel;
    }
}

function updateRevisionUI() {
    const revEl = document.getElementById('global-rev');
    if (revEl) revEl.textContent = `rev ${state.revision}`;
}

function setOfflineState(isOffline) {
    const banner = document.getElementById('offline-banner');
    if (banner) banner.hidden = !isOffline;
}

// ── Modal Dialog Manager with Accessible Focus Trap/Restore ──────────────────
function openModal(dialogId) {
    const dialog = document.getElementById(dialogId);
    if (dialog && typeof dialog.showModal === 'function') {
        lastFocusedElement = document.activeElement;
        dialog.showModal();

        // Clear any previous error summaries
        const errSummary = dialog.querySelector('.form-error-summary');
        if (errSummary) {
            errSummary.hidden = true;
            errSummary.textContent = '';
        }

        // Focus first actionable input or close button
        const focusable = dialog.querySelector(
            'input:not([type="hidden"]), textarea, select, button[type="submit"], [data-close-modal]'
        );
        if (focusable) focusable.focus();
    }
}

function closeModal(dialogId) {
    const dialog = document.getElementById(dialogId);
    if (dialog && typeof dialog.close === 'function') {
        dialog.close();
        if (
            lastFocusedElement &&
            typeof lastFocusedElement.focus === 'function'
        ) {
            lastFocusedElement.focus();
            lastFocusedElement = null;
        }
    }
}

function showFormError(dialogId, message) {
    const dialog = document.getElementById(dialogId);
    if (!dialog) return;
    const summary = dialog.querySelector('.form-error-summary');
    if (summary) {
        summary.textContent = message;
        summary.hidden = false;
    }
}

function initModals() {
    document.querySelectorAll('.modal-dialog').forEach((dialog) => {
        // Light dismiss on click outside modal content
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) closeModal(dialog.id);
        });

        dialog.querySelectorAll('[data-close-modal]').forEach((btn) => {
            btn.addEventListener('click', () => closeModal(dialog.id));
        });

        dialog.addEventListener('cancel', () => {
            if (
                lastFocusedElement &&
                typeof lastFocusedElement.focus === 'function'
            ) {
                lastFocusedElement.focus();
                lastFocusedElement = null;
            }
        });
    });
}

// ── Session & Auth Authentication ────────────────────────────────────────────
async function initSession() {
    try {
        const me = await api('/v1/auth/me');
        if (me && me.actor) {
            state.actor = me.actor;
            state.authMode = me.authMode || 'disabled';
        }
    } catch (_) {
        state.actor = { id: 'anonymous', role: 'viewer', method: 'none' };
    }

    try {
        const csrf = getCsrfFromCookie();
        if (!csrf) {
            const r = await api('/v1/auth/csrf');
            if (r && r.csrfToken) state.csrfToken = r.csrfToken;
        } else {
            state.csrfToken = csrf;
        }
    } catch (_) {
        /* ignore */
    }

    updatePermissionUI();
}

async function loginWithToken(token) {
    try {
        const res = await api('/v1/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        if (res && res.actor) {
            state.actor = res.actor;
            if (res.csrfToken) state.csrfToken = res.csrfToken;
        }
        updatePermissionUI();
        closeModal('auth-dialog');
        toast(`Signed in as ${state.actor.role}`, 'ok');
        refreshCurrentTab();
    } catch (err) {
        showFormError('auth-dialog', err.message || 'Login failed');
        toast(err.message || 'Login failed', 'err', {
            requestId: err.requestId
        });
    }
}

async function logoutSession() {
    try {
        await api('/v1/auth/logout', { method: 'POST' });
        state.actor = { id: 'anonymous', role: 'viewer', method: 'none' };
        updatePermissionUI();
        toast('Signed out', 'info');
        refreshCurrentTab();
    } catch (err) {
        toast(err.message, 'err');
    }
}

// ── Tab Navigation ───────────────────────────────────────────────────────────
function switchTab(viewName) {
    if ((viewName === 'metrics' || viewName === 'audit') && !isAdmin()) {
        toast('Administrator role required to access this dashboard', 'warn');
        return;
    }

    state.activeView = viewName;
    document.querySelectorAll('.nav-tab').forEach((tab) => {
        const isActive = tab.dataset.view === viewName;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    document.querySelectorAll('.view-panel').forEach((panel) => {
        const isActive = panel.id === `view-${viewName}`;
        panel.classList.toggle('active', isActive);
        panel.hidden = !isActive;
    });

    refreshCurrentTab();
}

function refreshCurrentTab() {
    switch (state.activeView) {
        case 'providers':
            loadAddons();
            break;
        case 'reliability':
            loadReliability();
            break;
        case 'jobs':
            loadJobs();
            break;
        case 'metrics':
            if (isAdmin()) loadMetrics();
            break;
        case 'audit':
            if (isAdmin()) loadAuditLogs();
            break;
        case 'settings':
            loadSettings();
            break;
        default:
            break;
    }
}

// ── Global Health & Heartbeat ────────────────────────────────────────────────
async function checkGlobalHealth() {
    const dot = document.getElementById('health-dot');
    const label = document.getElementById('health-text');
    try {
        const res = await fetch('/health/status', {
            headers: { Accept: 'application/json' }
        });
        const body = await res.json();
        const status = body.status || (res.ok ? 'operational' : 'offline');

        if (dot) {
            dot.className =
                'beacon-dot ' +
                (status === 'operational'
                    ? 'ok'
                    : status === 'degraded'
                      ? 'degraded'
                      : 'bad');
        }
        if (label)
            label.textContent =
                status.charAt(0).toUpperCase() + status.slice(1);
    } catch (_) {
        if (dot) dot.className = 'beacon-dot bad';
        if (label) label.textContent = 'Offline';
    }
}

// ── VIEW 1: PROVIDERS & ADDONS CONTROLLER ────────────────────────────────────
async function loadAddons() {
    const params = new URLSearchParams();
    params.set('page', String(state.pagination.page));
    params.set('limit', String(state.pagination.limit));

    if (state.filters.search) params.set('search', state.filters.search);
    if (state.filters.capability !== 'all')
        params.set('capability', state.filters.capability);
    if (state.filters.health !== 'all')
        params.set('health', state.filters.health);
    if (state.filters.state === 'enabled') params.set('enabled', 'true');
    if (state.filters.state === 'disabled') params.set('enabled', 'false');
    if (state.filters.state === 'pending')
        params.set('admissionState', 'pending');
    if (state.filters.state === 'quarantined')
        params.set('admissionState', 'quarantined');

    const [sortField, sortDir] = state.filters.sort.split('-');
    params.set('sort', sortField);
    params.set('direction', sortDir || 'asc');

    try {
        const res = await api(`/v1/addons?${params.toString()}`);
        state.addons = res.addons || [];
        if (res.revision != null) state.revision = res.revision;
        updateRevisionUI();

        if (res.pagination) {
            state.pagination = res.pagination;
        }

        const streamCnt = state.addons.filter(
            (a) => a.capabilities?.stream?.length
        ).length;
        const subCnt = state.addons.filter(
            (a) => a.capabilities?.subtitles?.length
        ).length;
        const countBadge = document.getElementById('tab-provider-count');
        if (countBadge)
            countBadge.textContent = String(
                state.pagination.total || state.addons.length
            );

        const summaryEl = document.getElementById('store-summary');
        if (summaryEl) {
            summaryEl.textContent = `Store: ${res.store || 'file'} · Total: ${state.pagination.total} (Stream: ${streamCnt}, Subtitles: ${subCnt}) · rev ${state.revision}`;
        }

        renderProviders();
        renderPagination();
    } catch (err) {
        toast(err.message, 'err', { requestId: err.requestId });
    }
}

function renderCapabilities(caps) {
    if (!caps) return '<span class="badge badge-meta">none</span>';
    const badges = [];

    if (caps.stream && caps.stream.length) {
        const types = caps.stream.flatMap((s) => s.mediaTypes).join(', ');
        badges.push(
            `<span class="badge badge-stream" title="Media types: ${escapeAttr(types)}">Stream</span>`
        );
    }
    if (caps.subtitles && caps.subtitles.length) {
        badges.push('<span class="badge badge-subtitles">Subtitles</span>');
    }
    if (caps.catalog)
        badges.push('<span class="badge badge-catalog">Catalog</span>');
    if (caps.meta) badges.push('<span class="badge badge-meta">Meta</span>');

    if (caps.status === 'limited') {
        badges.push(
            `<span class="badge badge-limited" title="${escapeAttr(caps.statusReason || 'Limited')}">Limited</span>`
        );
    } else if (caps.status === 'unsupported') {
        badges.push(
            `<span class="badge badge-unsupported" title="${escapeAttr(caps.statusReason || 'Unsupported')}">Unsupported</span>`
        );
    }

    return badges.join(' ') || '<span class="badge badge-meta">none</span>';
}

function formatRelativeTime(isoString) {
    if (!isoString) return 'Never checked';
    const ms = Date.now() - new Date(isoString).getTime();
    if (ms < 0) return 'Just now';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function renderHealth(health) {
    if (!health) {
        return `<div class="health-status-row"><span class="health-dot-sm unknown"></span><span>Unchecked</span></div>`;
    }
    const isOk = health.healthy;
    const isStale =
        health.lastChecked &&
        Date.now() - new Date(health.lastChecked).getTime() > 3600000;
    const dotCls = isOk ? (isStale ? 'warning' : 'ok') : 'bad';
    const statusText = isOk
        ? isStale
            ? 'Healthy (Stale)'
            : 'Healthy'
        : health.failureClassification || 'Unhealthy';
    const latency = health.latencyMs != null ? `${health.latencyMs}ms` : '';
    const age = formatRelativeTime(health.lastChecked);

    return `
        <div class="health-status-row" title="${escapeAttr(health.error || (isOk ? `Operational · ${age}` : 'Failed'))}">
            <span class="health-dot-sm ${dotCls}"></span>
            <strong>${escapeHtml(statusText)}</strong>
        </div>
        <span class="latency-label">${latency ? `${latency} · ` : ''}${escapeHtml(age)}</span>
    `;
}

function renderAdmissionBadge(addon) {
    if (addon.admissionState === 'quarantined') {
        return '<span class="badge badge-danger">Quarantined</span>';
    }
    if (addon.admissionState === 'pending') {
        return '<span class="badge badge-warning">Pending</span>';
    }
    if (!addon.enabled) {
        return '<span class="badge badge-meta">Disabled</span>';
    }
    return '';
}

function renderProviders() {
    const list = document.getElementById('provider-list');
    const empty = document.getElementById('empty-providers-msg');
    if (!list) return;

    list.innerHTML = '';
    if (state.addons.length === 0) {
        if (empty) empty.hidden = false;
        return;
    }
    if (empty) empty.hidden = true;

    state.addons.forEach((addon, idx) => {
        const li = document.createElement('li');
        li.className =
            'provider-row' +
            (addon.enabled ? '' : ' disabled') +
            (addon.admissionState === 'quarantined' ? ' quarantined' : '') +
            (addon.admissionState === 'pending' ? ' pending' : '');
        li.tabIndex = 0;
        li.setAttribute('role', 'listitem');
        li.setAttribute('aria-grabbed', 'false');
        li.draggable = canOperate();
        li.dataset.id = addon.providerId;
        li.dataset.index = String(idx);
        applyVuHealthAttr(addon, li);

        const isOp = canOperate();
        const isAdm = isAdmin();

        // Accessible safe logo rendering without inline scripts
        const logoWrapper = document.createElement('div');
        logoWrapper.className = 'provider-logo';
        if (addon.manifest?.logo) {
            const img = document.createElement('img');
            img.src = addon.manifest.logo;
            img.alt = '';
            img.addEventListener('error', () => {
                logoWrapper.textContent = addon.name.slice(0, 2);
            });
            logoWrapper.appendChild(img);
        } else {
            logoWrapper.textContent = addon.name.slice(0, 2);
        }

        li.innerHTML = `
            <div class="col-rank">
                <span class="drag-handle" title="Drag to reorder (or use Alt+Up/Down)" aria-hidden="true">⠿</span>
                <span class="rank-number">#${addon.order}</span>
                <div class="rank-buttons">
                    <button type="button" class="btn-rank btn-rank-up" data-act="rank-up" title="Move Up" ${!isOp || idx === 0 ? 'disabled' : ''}>▲</button>
                    <button type="button" class="btn-rank btn-rank-down" data-act="rank-down" title="Move Down" ${!isOp || idx === state.addons.length - 1 ? 'disabled' : ''}>▼</button>
                </div>
            </div>

            <div class="col-provider">
                <div class="logo-slot"></div>
                <div class="provider-meta">
                    <div class="provider-name-row">
                        <span class="provider-name">${escapeHtml(addon.name)}</span>
                        ${renderAdmissionBadge(addon)}
                        <span class="badge badge-rev">${escapeHtml(addon.source)}</span>
                    </div>
                    <div class="provider-id-tag">${escapeHtml(addon.providerId)} · v${escapeHtml(addon.manifest?.version || '1.0')}</div>
                </div>
            </div>

            <div class="col-caps">
                ${renderCapabilities(addon.capabilities)}
            </div>

            <div class="col-health">
                ${renderHealth(addon.health)}
            </div>

            <div class="col-policy">
                <input type="number" class="timeout-input" min="1000" max="120000" step="1000" value="${addon.timeoutMs}" data-act="timeout" ${!isOp ? 'disabled' : ''} title="Per-request timeout in milliseconds" />
            </div>

            <div class="col-actions">
                <label class="switch" title="${addon.enabled ? 'Disable addon' : 'Enable addon'}">
                    <input type="checkbox" data-act="toggle" ${addon.enabled ? 'checked' : ''} ${!isOp ? 'disabled' : ''} />
                    <span class="slider"></span>
                </label>
                <button type="button" class="btn btn-xs btn-ghost" data-act="probe" title="Run single-provider probe" ${!isOp ? 'disabled' : ''}>Probe</button>
                <button type="button" class="btn btn-xs btn-ghost" data-act="inspect" title="Inspect raw manifest">Inspect</button>
                <button type="button" class="btn btn-xs btn-ghost" data-act="refresh" title="Refresh upstream manifest" ${!isOp ? 'disabled' : ''}>Refresh</button>
                <button type="button" class="btn btn-xs btn-danger" data-act="remove" title="Remove provider" ${!isAdm ? 'disabled' : ''}>✕</button>
            </div>
        `;

        li.querySelector('.logo-slot').replaceWith(logoWrapper);

        // Event listeners
        li.querySelector('[data-act="toggle"]').addEventListener(
            'change',
            async (e) => {
                const enabled = e.target.checked;
                try {
                    await api(
                        `/v1/addons/${encodeURIComponent(addon.providerId)}`,
                        {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ enabled })
                        }
                    );
                    addon.enabled = enabled;
                    li.classList.toggle('disabled', !enabled);
                    toast(
                        `${addon.name} ${enabled ? 'enabled' : 'disabled'}`,
                        'ok'
                    );
                } catch (err) {
                    e.target.checked = !enabled;
                    toast(err.message, 'err', { requestId: err.requestId });
                }
            }
        );

        li.querySelector('[data-act="timeout"]').addEventListener(
            'change',
            async (e) => {
                const timeoutMs = parseInt(e.target.value, 10);
                if (isNaN(timeoutMs) || timeoutMs < 1000) return;
                try {
                    await api(
                        `/v1/addons/${encodeURIComponent(addon.providerId)}`,
                        {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ timeoutMs })
                        }
                    );
                    addon.timeoutMs = timeoutMs;
                    toast(`Timeout set to ${timeoutMs}ms`, 'ok');
                } catch (err) {
                    toast(err.message, 'err', { requestId: err.requestId });
                }
            }
        );

        li.querySelector('[data-act="probe"]').addEventListener(
            'click',
            async (e) => {
                busy(e.target, true, 'Probing…');
                try {
                    const res = await api(
                        `/v1/addons/${encodeURIComponent(addon.providerId)}/probe`,
                        {
                            method: 'POST'
                        }
                    );
                    toast(
                        `Probe ${res.healthy ? 'passed' : 'failed'} (${res.latencyMs}ms)`,
                        res.healthy ? 'ok' : 'err'
                    );
                    await loadAddons();
                } catch (err) {
                    toast(err.message, 'err', { requestId: err.requestId });
                } finally {
                    busy(e.target, false);
                }
            }
        );

        li.querySelector('[data-act="inspect"]').addEventListener(
            'click',
            () => {
                inspectProvider(addon.providerId);
            }
        );

        li.querySelector('[data-act="refresh"]').addEventListener(
            'click',
            async (e) => {
                busy(e.target, true, '…');
                try {
                    await api(
                        `/v1/addons/${encodeURIComponent(addon.providerId)}/refresh`,
                        { method: 'POST' }
                    );
                    toast(`Manifest refreshed for ${addon.name}`, 'ok');
                    await loadAddons();
                } catch (err) {
                    toast(err.message, 'err', { requestId: err.requestId });
                } finally {
                    busy(e.target, false);
                }
            }
        );

        li.querySelector('[data-act="remove"]').addEventListener(
            'click',
            () => {
                confirmRemove(addon.providerId, addon.name);
            }
        );

        li.querySelector('[data-act="rank-up"]').addEventListener(
            'click',
            () => {
                if (idx > 0) moveProvider(idx, idx - 1);
            }
        );

        li.querySelector('[data-act="rank-down"]').addEventListener(
            'click',
            () => {
                if (idx < state.addons.length - 1) moveProvider(idx, idx + 1);
            }
        );

        // Keyboard reordering with Alt+ArrowUp / Alt+ArrowDown
        li.addEventListener('keydown', (e) => {
            if (e.altKey && e.key === 'ArrowUp' && idx > 0 && isOp) {
                e.preventDefault();
                moveProvider(idx, idx - 1);
            } else if (
                e.altKey &&
                e.key === 'ArrowDown' &&
                idx < state.addons.length - 1 &&
                isOp
            ) {
                e.preventDefault();
                moveProvider(idx, idx + 1);
            }
        });

        // Drag and drop handlers with ARIA
        li.addEventListener('dragstart', () => {
            state.draggedIndex = idx;
            li.classList.add('dragging');
            li.setAttribute('aria-grabbed', 'true');
        });

        li.addEventListener('dragend', () => {
            li.classList.remove('dragging');
            li.setAttribute('aria-grabbed', 'false');
            document
                .querySelectorAll('.provider-row')
                .forEach((r) => r.classList.remove('drag-over'));
        });

        li.addEventListener('dragover', (e) => {
            e.preventDefault();
            li.classList.add('drag-over');
        });

        li.addEventListener('dragleave', () => {
            li.classList.remove('drag-over');
        });

        li.addEventListener('drop', (e) => {
            e.preventDefault();
            li.classList.remove('drag-over');
            if (state.draggedIndex != null && state.draggedIndex !== idx) {
                moveProvider(state.draggedIndex, idx);
            }
            state.draggedIndex = null;
        });

        list.appendChild(li);
    });
}

function renderPagination() {
    const info = document.getElementById('pagination-info');
    const indicator = document.getElementById('page-indicator');
    const prevBtn = document.getElementById('prev-page-btn');
    const nextBtn = document.getElementById('next-page-btn');

    const { page, totalPages, total, limit } = state.pagination;
    const start = total > 0 ? (page - 1) * limit + 1 : 0;
    const end = Math.min(page * limit, total);

    if (info)
        info.textContent = `Showing ${start}–${end} of ${total} providers`;
    if (indicator) indicator.textContent = `Page ${page} of ${totalPages || 1}`;
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= totalPages;
}

async function moveProvider(fromIndex, toIndex) {
    const order = state.addons.map((a) => a.providerId);
    const [moved] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, moved);

    try {
        await api('/v1/addons/reorder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order })
        });
        toast('Provider order updated', 'ok');
        await loadAddons();
    } catch (err) {
        toast(err.message, 'err', { requestId: err.requestId });
    }
}

async function inspectProvider(providerId) {
    try {
        const data = await api(
            `/v1/addons/${encodeURIComponent(providerId)}?raw=true&diagnostics=true`
        );
        document.getElementById('manifest-provider-id').textContent =
            data.providerId || providerId;

        const grid = document.getElementById('manifest-meta-grid');
        grid.innerHTML = `
            <div class="meta-box">
                <div class="meta-box-label">Status &amp; Admission</div>
                <div class="meta-box-val">${escapeHtml(data.admissionState || (data.enabled ? 'validated' : 'disabled'))}</div>
            </div>
            <div class="meta-box">
                <div class="meta-box-label">Timeout</div>
                <div class="meta-box-val">${data.timeoutMs}ms</div>
            </div>
            <div class="meta-box">
                <div class="meta-box-label">Circuit State</div>
                <div class="meta-box-val">${escapeHtml(data.diagnostics?.circuitState || 'closed')}</div>
            </div>
            <div class="meta-box">
                <div class="meta-box-label">Origin (Redacted)</div>
                <div class="meta-box-val" style="word-break: break-all;">${escapeHtml(data.manifestUrl || data.source || 'url')}</div>
            </div>
        `;

        document.getElementById('manifest-raw-json').textContent =
            JSON.stringify(data.manifest || {}, null, 2);
        openModal('manifest-dialog');
    } catch (err) {
        toast(err.message, 'err', { requestId: err.requestId });
    }
}

function confirmRemove(providerId, name) {
    document.getElementById('remove-provider-id').value = providerId;
    document.getElementById('remove-addon-name').textContent = name;
    document.getElementById('remove-reason').value = '';
    openModal('remove-dialog');
}

// ── VIEW 2: RELIABILITY & CIRCUITS CONTROLLER ────────────────────────────────
async function loadReliability() {
    try {
        const qRes = await api('/v1/quarantine');
        state.quarantined = qRes.quarantined || [];
    } catch (err) {
        state.quarantined = [];
        toast(`Quarantine fetch error: ${err.message}`, 'warn');
    }

    try {
        const mRes = await api('/metrics?format=json');
        state.circuits = mRes.circuits || {};
    } catch (err) {
        state.circuits = {};
    }

    const badge = document.getElementById('tab-quarantine-count');
    if (badge) {
        badge.textContent = String(state.quarantined.length);
        badge.hidden = state.quarantined.length === 0;
    }

    renderQuarantine();
    renderCircuits();
}

function renderQuarantine() {
    const list = document.getElementById('quarantine-list');
    const empty = document.getElementById('empty-quarantine-msg');
    if (!list) return;

    list.innerHTML = '';
    if (state.quarantined.length === 0) {
        if (empty) empty.hidden = false;
        return;
    }
    if (empty) empty.hidden = true;

    state.quarantined.forEach((q) => {
        const div = document.createElement('div');
        div.className = 'card';
        div.style.borderColor = 'rgba(244, 63, 94, 0.3)';

        const isAdm = isAdmin();
        div.innerHTML = `
            <div class="card-header-row">
                <strong style="color: var(--danger)">${escapeHtml(q.providerId)}</strong>
                <span class="badge badge-danger">Quarantined</span>
            </div>
            <p class="muted" style="margin-bottom: 8px;">${escapeHtml(q.reason)}</p>
            <div style="font-size: 11px; color: var(--text-tertiary); margin-bottom: 12px;">
                Since: ${new Date(q.since).toLocaleString()} ${q.until ? `· Until: ${new Date(q.until).toLocaleTimeString()}` : '· Indefinite'}
            </div>
            <button type="button" class="btn btn-xs btn-secondary" data-act="release" ${!isAdm ? 'disabled' : ''}>Release Quarantine</button>
        `;

        div.querySelector('[data-act="release"]').addEventListener(
            'click',
            async (e) => {
                busy(e.target, true, 'Releasing…');
                try {
                    await api(
                        `/v1/quarantine/${encodeURIComponent(q.providerId)}/release`,
                        { method: 'POST' }
                    );
                    toast(`Released ${q.providerId} from quarantine`, 'ok');
                    await loadReliability();
                } catch (err) {
                    toast(err.message, 'err', { requestId: err.requestId });
                } finally {
                    busy(e.target, false);
                }
            }
        );

        list.appendChild(div);
    });
}

function renderCircuits() {
    const tbody = document.getElementById('circuits-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const entries = Object.entries(state.circuits);
    if (entries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align: center; padding: 20px;">No circuit telemetry available yet.</td></tr>`;
        return;
    }

    entries.forEach(([id, c]) => {
        const tr = document.createElement('tr');
        const stateBadge =
            c.state === 'closed'
                ? '<span class="badge badge-ok">Closed</span>'
                : c.state === 'half-open'
                  ? '<span class="badge badge-warning">Half-Open</span>'
                  : '<span class="badge badge-danger">Open</span>';

        const isOp = canOperate();
        tr.innerHTML = `
            <td><strong>${escapeHtml(id)}</strong></td>
            <td>${stateBadge}</td>
            <td>${c.failures || 0}</td>
            <td>${escapeHtml(c.lastFailureKind || '—')}</td>
            <td>${c.metrics ? `${c.metrics.successes}/${c.metrics.attempts} ok` : '—'}</td>
            <td>
                <button type="button" class="btn btn-xs btn-ghost" data-act="manual-q" ${!isOp ? 'disabled' : ''}>Quarantine</button>
            </td>
        `;

        tr.querySelector('[data-act="manual-q"]').addEventListener(
            'click',
            () => {
                document.getElementById('quarantine-provider-id').value = id;
                openModal('quarantine-dialog');
            }
        );

        tbody.appendChild(tr);
    });
}

// ── VIEW 3: BACKGROUND JOBS CONTROLLER ───────────────────────────────────────
async function loadJobs() {
    const type = document.getElementById('filter-job-type')?.value;
    const status = document.getElementById('filter-job-status')?.value;

    const params = new URLSearchParams({ limit: '50' });
    if (type && type !== 'all') params.set('type', type);
    if (status && status !== 'all') params.set('status', status);

    try {
        const res = await api(`/v1/jobs?${params.toString()}`);
        state.jobs = res.jobs || [];

        const countBadge = document.getElementById('tab-job-count');
        if (countBadge) countBadge.textContent = String(state.jobs.length);

        // Compute Queue Depth Breakdown
        const active = state.jobs.filter((j) => j.status === 'running').length;
        const queued = state.jobs.filter((j) => j.status === 'queued').length;
        const completed = state.jobs.filter(
            (j) => j.status === 'completed'
        ).length;
        const failed = state.jobs.filter(
            (j) => j.status === 'failed' || j.status === 'dead_letter'
        ).length;

        const activeEl = document.getElementById('queue-active-count');
        const queuedEl = document.getElementById('queue-pending-count');
        const compEl = document.getElementById('queue-completed-count');
        const failEl = document.getElementById('queue-failed-count');

        if (activeEl) activeEl.textContent = String(active);
        if (queuedEl) queuedEl.textContent = String(queued);
        if (compEl) compEl.textContent = String(completed);
        if (failEl) failEl.textContent = String(failed);

        renderJobs();

        // Check if any jobs are currently active to trigger polling
        const hasActiveJobs = active > 0 || queued > 0;
        if (hasActiveJobs && !state.jobsPollTimer) {
            state.jobsPollTimer = setInterval(loadJobs, 4000);
        } else if (!hasActiveJobs && state.jobsPollTimer) {
            clearInterval(state.jobsPollTimer);
            state.jobsPollTimer = null;
        }
    } catch (err) {
        toast(err.message, 'err', { requestId: err.requestId });
    }
}

function renderJobs() {
    const stream = document.getElementById('job-stream');
    const empty = document.getElementById('empty-jobs-card');
    if (!stream) return;

    stream.innerHTML = '';
    if (state.jobs.length === 0) {
        if (empty) empty.hidden = false;
        return;
    }
    if (empty) empty.hidden = true;

    state.jobs.forEach((job) => {
        const card = document.createElement('div');
        card.className = 'job-card';

        const statusBadge =
            job.status === 'completed'
                ? '<span class="badge badge-ok">Completed</span>'
                : job.status === 'running'
                  ? '<span class="badge badge-stream">Running</span>'
                  : job.status === 'queued'
                    ? '<span class="badge badge-warning">Queued</span>'
                    : '<span class="badge badge-danger">' +
                      escapeHtml(job.status) +
                      '</span>';

        const canCancel =
            (job.status === 'queued' || job.status === 'running') &&
            canOperate();
        const canRetry =
            (job.status === 'failed' ||
                job.status === 'cancelled' ||
                job.status === 'dead_letter') &&
            canOperate();

        card.innerHTML = `
            <div class="job-header-row">
                <div class="job-type-group">
                    ${statusBadge}
                    <strong>${escapeHtml(job.type)}</strong>
                    <span class="job-id-label">${escapeHtml(job.id)}</span>
                </div>
                <span class="job-time">${new Date(job.createdAt).toLocaleTimeString()}</span>
            </div>

            <div class="job-progress-bar">
                <div class="job-progress-fill" style="width: ${job.progress || (job.status === 'completed' ? 100 : 0)}%"></div>
            </div>

            ${job.error ? `<div class="job-error-box">${escapeHtml(job.error)}</div>` : ''}

            <div class="job-footer-row">
                <span>Requester: ${escapeHtml(job.requester?.id || 'system')} (${escapeHtml(job.requester?.ip || 'local')})</span>
                <div style="display: flex; gap: 6px;">
                    ${canCancel ? `<button type="button" class="btn btn-xs btn-ghost" data-act="cancel">Cancel</button>` : ''}
                    ${canRetry ? `<button type="button" class="btn btn-xs btn-secondary" data-act="retry">Retry</button>` : ''}
                </div>
            </div>
        `;

        if (canCancel) {
            card.querySelector('[data-act="cancel"]').addEventListener(
                'click',
                async () => {
                    try {
                        await api(`/v1/jobs/${job.id}/cancel`, {
                            method: 'POST'
                        });
                        toast('Job cancellation requested', 'ok');
                        loadJobs();
                    } catch (err) {
                        toast(err.message, 'err', { requestId: err.requestId });
                    }
                }
            );
        }

        if (canRetry) {
            card.querySelector('[data-act="retry"]').addEventListener(
                'click',
                async () => {
                    try {
                        await api(`/v1/jobs/${job.id}/retry`, {
                            method: 'POST'
                        });
                        toast('Job queued for retry', 'ok');
                        loadJobs();
                    } catch (err) {
                        toast(err.message, 'err', { requestId: err.requestId });
                    }
                }
            );
        }

        stream.appendChild(card);
    });
}

// ── VIEW 4: SYSTEM METRICS & OBSERVABILITY CONTROLLER ────────────────────────
async function loadMetrics() {
    try {
        const [mRes, statusRes, depRes] = await Promise.all([
            api('/metrics?format=json').catch((err) => {
                toast(`Metrics error: ${err.message}`, 'warn');
                return null;
            }),
            api('/health/status').catch(() => null),
            api('/health/dependencies').catch(() => null)
        ]);

        if (mRes && mRes.slo) {
            const slo = mRes.slo;
            document.getElementById('slo-availability').textContent =
                `${(slo.availabilityRatio * 100).toFixed(1)}%`;
            document.getElementById('slo-error-budget').textContent =
                `${slo.errorBudgetRemainingPercent}%`;
            document.getElementById('slo-error-rate').textContent =
                `Error Rate: ${slo.errorRate}%`;
            document.getElementById('slo-p95').textContent =
                `${slo.p95LatencyMs} ms`;
            document.getElementById('slo-provider-success').textContent =
                `${slo.providerSuccessRate}%`;
            document.getElementById('slo-stale-count').textContent =
                `${slo.staleHealthCount} Stale Records`;

            // Alert banner evaluation
            const alertBanner = document.getElementById('system-alerts-banner');
            const alertText = document.getElementById('system-alerts-text');
            if (slo.errorBudgetRemainingPercent < 20) {
                alertBanner.hidden = false;
                alertText.textContent = `Critical: Error budget depleted (${slo.errorBudgetRemainingPercent}% remaining). High upstream failure rate detected.`;
            } else {
                alertBanner.hidden = true;
            }
        }

        if (mRes && mRes.cache) {
            const c = mRes.cache;
            const total = (c.hits || 0) + (c.misses || 0);
            const ratio =
                total > 0 ? ((c.hits / total) * 100).toFixed(1) : '0.0';
            document.getElementById('cache-hit-ratio').textContent =
                `${ratio}%`;
            document.getElementById('cache-hit-bar').style.width = `${ratio}%`;
            document.getElementById('cache-hits').textContent = String(
                c.hits || 0
            );
            document.getElementById('cache-misses').textContent = String(
                c.misses || 0
            );
            document.getElementById('cache-swr').textContent = String(
                c.swrHits || 0
            );
            document.getElementById('cache-evictions').textContent = String(
                c.evictions || 0
            );
            document.getElementById('cache-bypasses').textContent = String(
                c.bypasses || 0
            );
        }

        if (mRes && mRes.proxy) {
            const p = mRes.proxy;
            document.getElementById('metric-active-http').textContent = String(
                mRes.activeHttpRequests || 0
            );
            document.getElementById('metric-active-streams').textContent =
                String(p.activeStreams || 0);
            const mb = ((p.totalBytes || 0) / (1024 * 1024)).toFixed(1);
            document.getElementById('metric-proxy-bytes').textContent =
                `${mb} MB`;
            document.getElementById('metric-ssrf-denied').textContent = String(
                p.deniedSsrf || 0
            );
        }

        if (mRes && mRes.egressBudget) {
            const pct = (mRes.egressBudget.usedPct || 0).toFixed(1);
            document.getElementById('egress-budget-pct').textContent =
                `${pct}%`;
            document.getElementById('egress-budget-bar').style.width =
                `${pct}%`;
        }

        // Render Provider Success & Latency Ranking Table
        const rankingTbody = document.getElementById('provider-ranking-tbody');
        if (rankingTbody) {
            rankingTbody.innerHTML = '';
            const providers = state.addons.slice().sort((a, b) => {
                const aHealth = a.health?.healthy ? 1 : 0;
                const bHealth = b.health?.healthy ? 1 : 0;
                if (bHealth !== aHealth) return bHealth - aHealth;
                return (
                    (a.health?.latencyMs || 99999) -
                    (b.health?.latencyMs || 99999)
                );
            });

            if (providers.length === 0) {
                rankingTbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align: center; padding: 16px;">No provider ranking data available.</td></tr>`;
            } else {
                providers.forEach((p, idx) => {
                    const tr = document.createElement('tr');
                    const isHealthy = p.health?.healthy;
                    const latency =
                        p.health?.latencyMs != null
                            ? `${p.health.latencyMs}ms`
                            : '—';
                    const circuit =
                        state.circuits[p.providerId]?.state || 'closed';

                    tr.innerHTML = `
                        <td><strong>#${idx + 1}</strong></td>
                        <td><strong>${escapeHtml(p.name)}</strong> <span class="badge badge-rev">${escapeHtml(p.providerId)}</span></td>
                        <td>${isHealthy ? '<span class="badge badge-ok">Healthy</span>' : '<span class="badge badge-danger">Degraded</span>'}</td>
                        <td>${isHealthy ? '100%' : '0%'}</td>
                        <td>${escapeHtml(latency)}</td>
                        <td><span class="badge ${circuit === 'closed' ? 'badge-ok' : circuit === 'half-open' ? 'badge-warning' : 'badge-danger'}">${escapeHtml(circuit)}</span></td>
                    `;
                    rankingTbody.appendChild(tr);
                });
            }
        }

        if (depRes && depRes.dependencies) {
            const grid = document.getElementById('dependencies-grid');
            grid.innerHTML = Object.entries(depRes.dependencies)
                .map(([name, dep]) => {
                    const isOk = dep.status === 'ok';
                    return `
                    <div class="dep-card">
                        <span class="dep-name">${escapeHtml(name)}</span>
                        <span class="badge ${isOk ? 'badge-ok' : 'badge-danger'}">${escapeHtml(dep.status || 'unknown')}</span>
                    </div>
                `;
                })
                .join('');
        }
    } catch (err) {
        toast(err.message, 'err');
    }
}

// ── VIEW 5: AUDIT LOGS CONTROLLER ────────────────────────────────────────────
async function loadAuditLogs() {
    try {
        const res = await api('/v1/audit?limit=50');
        state.auditLogs = res.events || [];
        renderAuditLogs();
    } catch (err) {
        toast(err.message, 'err');
    }
}

function renderAuditLogs() {
    const tbody = document.getElementById('audit-tbody');
    const empty = document.getElementById('empty-audit-msg');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (state.auditLogs.length === 0) {
        if (empty) empty.hidden = false;
        return;
    }
    if (empty) empty.hidden = true;

    state.auditLogs.forEach((ev) => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';

        const outcomeBadge =
            ev.outcome === 'success'
                ? '<span class="badge badge-ok">Success</span>'
                : ev.outcome === 'denied'
                  ? '<span class="badge badge-warning">Denied</span>'
                  : '<span class="badge badge-danger">Failure</span>';

        tr.innerHTML = `
            <td style="font-family: var(--font-mono); font-size: 11px;">${new Date(ev.timestamp).toLocaleTimeString()}</td>
            <td><strong>${escapeHtml(ev.action)}</strong></td>
            <td>${escapeHtml(ev.actor?.id || 'system')} <span class="badge badge-rev">${escapeHtml(ev.actor?.role || 'viewer')}</span></td>
            <td style="font-family: var(--font-mono); font-size: 11px;">${escapeHtml(ev.actor?.ip || '—')}</td>
            <td>${outcomeBadge}</td>
            <td>${escapeHtml(ev.target || '—')}</td>
            <td><button type="button" class="btn btn-xs btn-ghost" data-act="view-audit">View</button></td>
        `;

        tr.addEventListener('click', () => {
            document.getElementById('audit-meta-summary').innerHTML = `
                <div class="meta-box">
                    <div class="meta-box-label">Action</div>
                    <div class="meta-box-val">${escapeHtml(ev.action)}</div>
                </div>
                <div class="meta-box">
                    <div class="meta-box-label">Actor</div>
                    <div class="meta-box-val">${escapeHtml(ev.actor?.id || 'system')} (${escapeHtml(ev.actor?.role || 'viewer')})</div>
                </div>
                <div class="meta-box">
                    <div class="meta-box-label">Request ID</div>
                    <div class="meta-box-val">${escapeHtml(ev.requestId || '—')}</div>
                </div>
            `;
            document.getElementById('audit-raw-json').textContent =
                JSON.stringify(ev, null, 2);
            openModal('audit-dialog');
        });

        tbody.appendChild(tr);
    });
}

// ── VIEW 6: SETTINGS & DEBRID CONTROLLER ─────────────────────────────────────
async function loadSettings() {
    try {
        const res = await api('/v1/settings');
        state.settings = res || {};
        const d = res.debrid || {};

        const badge = document.getElementById('debrid-status-badge');
        if (badge) {
            badge.textContent = d.enabled
                ? d.provider.toUpperCase()
                : 'Disabled';
            badge.className = 'debrid-badge ' + (d.enabled ? 'badge-ok' : '');
        }

        const providerSelect = document.getElementById('debrid-provider');
        if (providerSelect) providerSelect.value = d.provider || 'none';

        const lockNotice = document.getElementById('debrid-env-lock');
        if (lockNotice) lockNotice.hidden = !d.lockedByEnv;

        const isLocked = Boolean(d.lockedByEnv) || !isAdmin();
        document.getElementById('debrid-provider').disabled = isLocked;
        document.getElementById('debrid-key').disabled = isLocked;
        document.getElementById('save-debrid-btn').disabled = isLocked;
    } catch (err) {
        toast(err.message, 'err');
    }
}

// ── Event Wireup ─────────────────────────────────────────────────────────────
function initEvents() {
    // Navigation Tabs
    document.querySelectorAll('.nav-tab').forEach((tab) => {
        tab.addEventListener('click', () => switchTab(tab.dataset.view));
    });

    // Topbar Auth Button
    document.getElementById('auth-btn')?.addEventListener('click', () => {
        if (state.actor.id !== 'anonymous' && state.actor.method !== 'none') {
            logoutSession();
        } else {
            openModal('auth-dialog');
        }
    });

    // Auth Form Submission
    document.getElementById('auth-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('admin-token-input');
        const token = input?.value.trim();
        if (token) {
            loginWithToken(token);
            input.value = '';
        }
    });

    // Providers Search & Filters
    document.getElementById('provider-search')?.addEventListener(
        'input',
        debounce((e) => {
            state.filters.search = e.target.value.trim();
            state.pagination.page = 1;
            loadAddons();
        }, 250)
    );

    document
        .getElementById('filter-capability')
        ?.addEventListener('change', (e) => {
            state.filters.capability = e.target.value;
            state.pagination.page = 1;
            loadAddons();
        });

    document
        .getElementById('filter-health')
        ?.addEventListener('change', (e) => {
            state.filters.health = e.target.value;
            state.pagination.page = 1;
            loadAddons();
        });

    document.getElementById('filter-state')?.addEventListener('change', (e) => {
        state.filters.state = e.target.value;
        state.pagination.page = 1;
        loadAddons();
    });

    document.getElementById('sort-by')?.addEventListener('change', (e) => {
        state.filters.sort = e.target.value;
        loadAddons();
    });

    document.getElementById('prev-page-btn')?.addEventListener('click', () => {
        if (state.pagination.page > 1) {
            state.pagination.page--;
            loadAddons();
        }
    });

    document.getElementById('next-page-btn')?.addEventListener('click', () => {
        if (state.pagination.page < state.pagination.totalPages) {
            state.pagination.page++;
            loadAddons();
        }
    });

    document
        .getElementById('refresh-addons-btn')
        ?.addEventListener('click', loadAddons);

    document
        .getElementById('sweep-health-btn')
        ?.addEventListener('click', async (e) => {
            busy(e.target, true, 'Sweeping…');
            try {
                const res = await api('/v1/addons/health/check?async=true', {
                    method: 'POST'
                });
                toast(
                    `Health sweep triggered (Job: ${res.jobId || 'async'})`,
                    'ok',
                    { jobId: res.jobId }
                );
                loadAddons();
            } catch (err) {
                toast(err.message, 'err', { requestId: err.requestId });
            } finally {
                busy(e.target, false);
            }
        });

    // Delete Addon Modal Form with Audit Explanation
    document
        .getElementById('remove-form')
        ?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const providerId =
                document.getElementById('remove-provider-id').value;
            const reason = document
                .getElementById('remove-reason')
                .value.trim();
            if (!reason) {
                showFormError(
                    'remove-dialog',
                    'Please provide a brief explanation for the audit trail.'
                );
                return;
            }

            const btn = document.getElementById('remove-submit-btn');
            busy(btn, true, 'Removing…');
            try {
                await api(`/v1/addons/${encodeURIComponent(providerId)}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason })
                });
                toast('Addon permanently removed', 'ok');
                closeModal('remove-dialog');
                loadAddons();
            } catch (err) {
                showFormError('remove-dialog', err.message);
                toast(err.message, 'err', { requestId: err.requestId });
            } finally {
                busy(btn, false);
            }
        });

    // Manual Quarantine Modal Form
    document
        .getElementById('quarantine-form')
        ?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const providerId = document.getElementById(
                'quarantine-provider-id'
            ).value;
            const reason = document
                .getElementById('quarantine-reason')
                .value.trim();
            const ttlMins =
                parseInt(document.getElementById('quarantine-ttl').value, 10) ||
                0;
            const ttlMs = ttlMins > 0 ? ttlMins * 60 * 1000 : undefined;

            if (!reason) {
                showFormError(
                    'quarantine-dialog',
                    'Please enter a reason for quarantine.'
                );
                return;
            }

            const btn = document.getElementById('quarantine-submit-btn');
            busy(btn, true, 'Quarantining…');
            try {
                await api(`/v1/quarantine/${encodeURIComponent(providerId)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason, ttlMs })
                });
                toast(`Provider ${providerId} quarantined`, 'ok');
                closeModal('quarantine-dialog');
                loadReliability();
            } catch (err) {
                showFormError('quarantine-dialog', err.message);
                toast(err.message, 'err', { requestId: err.requestId });
            } finally {
                busy(btn, false);
            }
        });

    document
        .getElementById('open-manual-quarantine-btn')
        ?.addEventListener('click', () => {
            document.getElementById('quarantine-provider-id').value = '';
            document.getElementById('quarantine-reason').value = '';
            openModal('quarantine-dialog');
        });

    // Refresh Buttons
    document
        .getElementById('refresh-reliability-btn')
        ?.addEventListener('click', loadReliability);
    document
        .getElementById('refresh-jobs-btn')
        ?.addEventListener('click', loadJobs);
    document
        .getElementById('refresh-metrics-btn')
        ?.addEventListener('click', loadMetrics);
    document
        .getElementById('refresh-audit-btn')
        ?.addEventListener('click', loadAuditLogs);

    // Job Filters
    document
        .getElementById('filter-job-type')
        ?.addEventListener('change', loadJobs);
    document
        .getElementById('filter-job-status')
        ?.addEventListener('change', loadJobs);

    // Trigger Maintenance Job
    document
        .getElementById('trigger-maintenance-btn')
        ?.addEventListener('click', async (e) => {
            busy(e.target, true, 'Starting…');
            try {
                const res = await api('/v1/jobs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'maintenance' })
                });
                toast('Maintenance job queued', 'ok', { jobId: res.job?.id });
                loadJobs();
            } catch (err) {
                toast(err.message, 'err', { requestId: err.requestId });
            } finally {
                busy(e.target, false);
            }
        });

    // Debrid Form
    document
        .getElementById('save-debrid-btn')
        ?.addEventListener('click', async (e) => {
            const provider = document.getElementById('debrid-provider').value;
            const apiKey = document.getElementById('debrid-key').value.trim();
            busy(e.target, true, 'Saving…');
            try {
                const payload = { provider };
                if (apiKey) payload.apiKey = apiKey;
                await api('/v1/settings/debrid', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                document.getElementById('debrid-key').value = '';
                toast('Debrid configuration saved', 'ok');
                loadSettings();
            } catch (err) {
                toast(err.message, 'err', { requestId: err.requestId });
            } finally {
                busy(e.target, false);
            }
        });

    document
        .getElementById('test-debrid-btn')
        ?.addEventListener('click', async (e) => {
            busy(e.target, true, 'Testing…');
            try {
                const res = await api('/v1/settings/debrid/check', {
                    method: 'POST'
                });
                toast(
                    res.ok
                        ? `Debrid OK${res.user ? ` · ${res.user}` : ''}`
                        : `Debrid check failed: ${res.error}`,
                    res.ok ? 'ok' : 'err'
                );
            } catch (err) {
                toast(err.message, 'err', { requestId: err.requestId });
            } finally {
                busy(e.target, false);
            }
        });

    // Backup & Restore
    document
        .getElementById('export-config-btn')
        ?.addEventListener('click', async () => {
            try {
                const data = await api('/v1/settings/export');
                const blob = new Blob([JSON.stringify(data, null, 2)], {
                    type: 'application/json'
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `addons-config-sanitized-${Date.now()}.json`;
                a.click();
                URL.revokeObjectURL(url);
                toast('Sanitized configuration exported', 'ok');
            } catch (err) {
                toast(err.message, 'err', { requestId: err.requestId });
            }
        });

    document
        .getElementById('upload-config-btn')
        ?.addEventListener('click', async () => {
            const fileInput = document.getElementById('import-config-file');
            const file = fileInput?.files?.[0];
            if (!file) return toast('Select a JSON file first', 'warn');

            try {
                const text = await file.text();
                const payload = JSON.parse(text);
                const res = await api('/v1/settings/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                toast(
                    `Configuration restored (${res.imported || 0} addons imported)`,
                    'ok'
                );
                loadAddons();
            } catch (err) {
                toast(`Restore failed: ${err.message}`, 'err');
            }
        });

    // Import Addons View
    document
        .getElementById('empty-import-btn')
        ?.addEventListener('click', () => switchTab('import'));

    document
        .getElementById('url-import-form')
        ?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const raw = document
                .getElementById('url-import-input')
                .value.trim();
            if (!raw) return toast('Enter at least one manifest URL', 'warn');
            const urls = raw
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean);

            const btn = document.getElementById('btn-import-url');
            busy(btn, true, 'Installing…');
            try {
                const payload = urls.length > 1 ? { urls } : { url: urls[0] };
                const res = await api('/v1/addons/import/url', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                toast(
                    `Installed ${res.installed || (res.ok ? 1 : 0)} addon(s)`,
                    'ok'
                );
                document.getElementById('url-import-input').value = '';
                switchTab('providers');
            } catch (err) {
                toast(err.message, 'err', { requestId: err.requestId });
            } finally {
                busy(btn, false);
            }
        });

    document
        .getElementById('stremio-import-form')
        ?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('stremio-email').value.trim();
            const password = document.getElementById('stremio-password').value;
            const authKey = document
                .getElementById('stremio-authkey')
                .value.trim();

            if (!authKey && (!email || !password)) {
                return toast('Enter email + password or an authKey', 'warn');
            }

            const btn = document.getElementById('btn-import-stremio');
            busy(btn, true, 'Importing…');
            try {
                const payload = authKey ? { authKey } : { email, password };
                const res = await api('/v1/addons/import/stremio', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                toast(
                    `Imported ${res.installed}/${res.total} addons from Stremio`,
                    'ok'
                );
                document.getElementById('stremio-password').value = '';
                switchTab('providers');
            } catch (err) {
                toast(err.message, 'err', { requestId: err.requestId });
            } finally {
                busy(btn, false);
            }
        });

    document
        .getElementById('repo-import-form')
        ?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const url = document.getElementById('repo-url-input').value.trim();
            if (!url) return toast('Enter a repository URL', 'warn');

            const btn = document.getElementById('btn-import-repo');
            busy(btn, true, 'Importing…');
            try {
                const res = await api('/v1/addons/import/repository', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                toast(
                    `Discovered & installed ${res.installed}/${res.discovered} addons`,
                    'ok'
                );
                document.getElementById('repo-url-input').value = '';
                switchTab('providers');
            } catch (err) {
                toast(err.message, 'err', { requestId: err.requestId });
            } finally {
                busy(btn, false);
            }
        });

    // Offline Retry
    document.getElementById('retry-conn-btn')?.addEventListener('click', () => {
        checkGlobalHealth();
        refreshCurrentTab();
    });
}

// ── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(
        /[&<>"']/g,
        (c) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            })[c]
    );
}

function escapeAttr(s) {
    return escapeHtml(s);
}

function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

// ── Timecode (broadcast slate detail) ────────────────────────────────────────
function tickTimecode() {
    const el = document.getElementById('topbar-timecode');
    if (!el) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    el.textContent = `${hh}:${mm}:${ss}`;
}

// ── Provider Row VU Health Attribute (for signal spine) ──────────────────────
function applyVuHealthAttr(addon, li) {
    const h = addon.health;
    if (!h || h.healthy == null) {
        li.removeAttribute('data-health');
        return;
    }
    const isStale =
        h.lastChecked &&
        Date.now() - new Date(h.lastChecked).getTime() > 3600000;
    if (!h.healthy) li.setAttribute('data-health', 'bad');
    else if (isStale) li.setAttribute('data-health', 'stale');
    else li.setAttribute('data-health', 'ok');
}

// ── Application Bootstrapping ────────────────────────────────────────────────
async function boot() {
    initModals();
    initEvents();
    await initSession();
    checkGlobalHealth();
    refreshCurrentTab();

    // Periodic Heartbeats
    state.healthPollTimer = setInterval(checkGlobalHealth, 25000);
    tickTimecode();
    setInterval(tickTimecode, 1000);
}

document.addEventListener('DOMContentLoaded', boot);
