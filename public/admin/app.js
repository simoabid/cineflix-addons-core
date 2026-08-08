'use strict';

// Session auth: login exchanges the admin token for an HttpOnly cookie.
// We keep an in-memory token only long enough to call /v1/auth/login — it is
// never written to localStorage (phase 1 security requirement).
let pendingToken = '';
let csrfToken = '';
let authed = false;

function getCsrfFromCookie() {
    const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
}

function authHeaders(extra) {
    const h = Object.assign({ Accept: 'application/json' }, extra || {});
    // Prefer cookie session; fall back to header only during first login.
    if (pendingToken) h['x-admin-token'] = pendingToken;
    // CSRF double-submit: send cookie value as header for state-changing requests
    const csrf = csrfToken || getCsrfFromCookie();
    if (csrf) h['x-csrf-token'] = csrf;
    return h;
}

async function api(path, options) {
    const opts = Object.assign({ credentials: 'same-origin' }, options);
    opts.headers = authHeaders(opts.headers);
    const res = await fetch(path, opts);
    let body = null;
    try {
        body = await res.json();
    } catch (_) {
        /* ignore */
    }
    if (res.status === 401) {
        authed = false;
        document.getElementById('token-panel').hidden = false;
        throw new Error('Admin authentication required');
    }
    if (!res.ok) {
        const msg = (body && (body.error?.message || body.error)) || `HTTP ${res.status}`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return body;
}

async function ensureSession() {
    try {
        const me = await api('/v1/auth/me');
        authed = true;
        document.getElementById('token-panel').hidden = true;
        // Fetch CSRF token for subsequent mutations if not already in cookie
        try {
            const csrf = getCsrfFromCookie();
            if (!csrf) {
                const r = await api('/v1/auth/csrf');
                if (r && r.csrfToken) csrfToken = r.csrfToken;
            } else {
                csrfToken = csrf;
            }
        } catch (_) {
            /* ignore */
        }
        return me;
    } catch (_) {
        document.getElementById('token-panel').hidden = false;
        return null;
    }
}

async function loginWithToken(token) {
    pendingToken = token;
    try {
        const body = await api('/v1/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        // Store CSRF token returned by login (also set as cookie)
        if (body && body.csrfToken) csrfToken = body.csrfToken;
        else csrfToken = getCsrfFromCookie();
        // Drop the raw token from memory once the HttpOnly cookie is set.
        pendingToken = '';
        authed = true;
        document.getElementById('token-panel').hidden = true;
        return body;
    } catch (err) {
        pendingToken = '';
        throw err;
    }
}

// ── toast ─────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(message, kind) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4200);
}

function busy(btn, on, label) {
    if (!btn) return;
    btn.disabled = on;
    if (on) {
        btn.dataset.label = btn.textContent;
        btn.textContent = label || 'Working…';
    } else if (btn.dataset.label) {
        btn.textContent = btn.dataset.label;
    }
}

// ── health ──────────────────────────────────────────────────────────────────
async function checkHealth() {
    const dot = document.getElementById('health-dot');
    const text = document.getElementById('health-text');
    try {
        const res = await fetch('/v1/health', { headers: { Accept: 'application/json' } });
        const body = await res.json();
        const status = body.status || (res.ok ? 'operational' : 'offline');
        dot.className = 'dot ' + (status === 'operational' ? 'ok' : 'bad');
        text.textContent = status;
    } catch (_) {
        dot.className = 'dot bad';
        text.textContent = 'offline';
    }
}

// ── installed addons ──────────────────────────────────────────────────────────
let addons = [];
let filterText = '';
let dragFrom = -1;

function visibleAddons() {
    if (!filterText) return addons;
    const q = filterText.toLowerCase();
    return addons.filter(
        (a) =>
            a.name.toLowerCase().includes(q) ||
            a.id.toLowerCase().includes(q) ||
            (a.types || []).join(' ').toLowerCase().includes(q)
    );
}

function healthBadge(a) {
    if (!a.health) return '<span class="badge unknown" title="Not checked">●</span>';
    const cls = a.health.healthy ? 'ok' : 'bad';
    const t = a.health.error
        ? 'Unhealthy: ' + a.health.error
        : 'Healthy · ' + new Date(a.health.lastChecked).toLocaleString();
    return `<span class="badge ${cls}" title="${escapeAttr(t)}">●</span>`;
}

function capabilityBadges(a) {
    const c = a.capabilities;
    if (!c) return '';
    const parts = [];
    if (c.stream && c.stream.length) {
        const types = c.stream.flatMap((e) => e.mediaTypes).join(',');
        const prefixes = c.stream.flatMap((e) => e.idPrefixes).join(',');
        parts.push(`<span class="cap stream" title="stream: ${escapeAttr(types)} · ${escapeAttr(prefixes)}">stream</span>`);
    }
    if (c.subtitles && c.subtitles.length) {
        parts.push('<span class="cap subtitles">subtitles</span>');
    }
    if (c.catalog) parts.push('<span class="cap catalog">catalog</span>');
    if (c.meta) parts.push('<span class="cap meta">meta</span>');
    if (c.status === 'limited') {
        parts.push(`<span class="cap limited" title="${escapeAttr(c.statusReason || 'limited')}">limited</span>`);
    } else if (c.status === 'unsupported') {
        parts.push(`<span class="cap unsupported" title="${escapeAttr(c.statusReason || 'unsupported')}">unsupported</span>`);
    }
    return parts.join(' ');
}

function render() {
    const list = document.getElementById('addon-list');
    const empty = document.getElementById('empty-msg');
    document.getElementById('addon-count').textContent = String(addons.length);
    list.innerHTML = '';
    const shown = visibleAddons();
    empty.hidden = addons.length > 0;

    shown.forEach((a) => {
        const realIdx = addons.indexOf(a);
        const li = document.createElement('li');
        li.className = 'addon' + (a.enabled ? '' : ' disabled');
        li.draggable = true;
        li.dataset.idx = String(realIdx);

        const types = (a.types || []).join(', ') || 'any';
        const resources = (a.resources || []).join(', ');
        const logo = a.logo
            ? `<img class="logo-sm" src="${escapeAttr(a.logo)}" alt="" onerror="this.style.visibility='hidden'"/>`
            : `<div class="logo-sm"></div>`;
        const caps = capabilityBadges(a);

        li.innerHTML = `
            <span class="drag" title="Drag to reorder">⠿</span>
            ${logo}
            <div class="info">
                <div class="name">${healthBadge(a)} ${escapeHtml(a.name)}
                    <span class="tag">${escapeHtml(a.source)}</span>
                </div>
                <div class="meta">${escapeHtml(types)}${resources ? ' · ' + escapeHtml(resources) : ''} · ${escapeHtml(a.id)}</div>
                <div class="caps">${caps}</div>
            </div>
            <div class="actions">
                <label class="timeout" title="Per-request timeout (ms)">
                    <input type="number" min="1000" max="120000" step="1000" value="${a.timeoutMs}" data-act="timeout"/>ms
                </label>
                <label class="switch" title="Enable / disable">
                    <input type="checkbox" data-act="toggle" ${a.enabled ? 'checked' : ''}/>
                    <span class="slider"></span>
                </label>
                <button class="mini ghost" data-act="refresh">Refresh</button>
                <button class="mini danger" data-act="remove">Remove</button>
            </div>`;

        li.querySelector('[data-act="toggle"]').addEventListener('change', (e) =>
            patchAddon(a.id, { enabled: e.target.checked })
        );
        li.querySelector('[data-act="timeout"]').addEventListener('change', (e) => {
            const ms = Number(e.target.value);
            if (Number.isFinite(ms)) patchAddon(a.id, { timeoutMs: ms }, true);
        });
        li.querySelector('[data-act="refresh"]').addEventListener('click', () =>
            refreshAddon(a.id)
        );
        li.querySelector('[data-act="remove"]').addEventListener('click', () =>
            removeAddon(a.id, a.name)
        );

        li.addEventListener('dragstart', () => {
            dragFrom = realIdx;
            li.classList.add('dragging');
        });
        li.addEventListener('dragend', () => li.classList.remove('dragging'));
        li.addEventListener('dragover', (e) => {
            e.preventDefault();
            li.classList.add('dragover');
        });
        li.addEventListener('dragleave', () => li.classList.remove('dragover'));
        li.addEventListener('drop', (e) => {
            e.preventDefault();
            li.classList.remove('dragover');
            const to = realIdx;
            if (dragFrom >= 0 && dragFrom !== to) reorderTo(dragFrom, to);
            dragFrom = -1;
        });

        list.appendChild(li);
    });
}

async function loadAddons() {
    try {
        const body = await api('/v1/addons');
        addons = body.addons || [];
        const rev = body.revision != null ? ` · rev ${body.revision}` : '';
        const streamCnt = addons.filter((a) => a.capabilities && a.capabilities.stream.length).length;
        const subCnt = addons.filter((a) => a.capabilities && a.capabilities.subtitles.length).length;
        document.getElementById('store-desc').textContent =
            'Store: ' + (body.store || 'unknown') + rev + ` · stream:${streamCnt} subtitles:${subCnt}`;
        render();
    } catch (err) {
        toast(err.message, 'err');
    }
}

// ── mutations ─────────────────────────────────────────────────────────────────
async function patchAddon(id, patch, quiet) {
    try {
        await api('/v1/addons/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
        if (!quiet) await loadAddons();
    } catch (err) {
        toast(err.message, 'err');
        await loadAddons();
    }
}

async function removeAddon(id, name) {
    if (!confirm(`Remove "${name}"?`)) return;
    try {
        await api('/v1/addons/' + encodeURIComponent(id), { method: 'DELETE' });
        toast('Removed ' + name, 'ok');
        await loadAddons();
    } catch (err) {
        toast(err.message, 'err');
    }
}

async function refreshAddon(id) {
    try {
        await api('/v1/addons/' + encodeURIComponent(id) + '/refresh', {
            method: 'POST'
        });
        toast('Refreshed manifest', 'ok');
        await loadAddons();
    } catch (err) {
        toast(err.message, 'err');
    }
}

async function reorderTo(from, to) {
    const order = addons.map((a) => a.id);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    try {
        const body = await api('/v1/addons/reorder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order })
        });
        addons = body.addons || addons;
        render();
    } catch (err) {
        toast(err.message, 'err');
    }
}

async function runHealthCheck(btn) {
    busy(btn, true, 'Checking…');
    try {
        const body = await api('/v1/addons/health/check', { method: 'POST' });
        addons = body.addons || addons;
        render();
        toast(`Health: ${body.healthy}/${body.checked} healthy`, 'ok');
    } catch (err) {
        toast(err.message, 'err');
    } finally {
        busy(btn, false);
    }
}

// ── debrid settings ─────────────────────────────────────────────────────────
async function loadSettings() {
    try {
        const body = await api('/v1/settings');
        const d = body.debrid || {};
        const badge = document.getElementById('debrid-badge');
        badge.textContent = d.enabled ? d.provider : 'off';
        badge.className = 'debrid-badge' + (d.enabled ? ' on' : '');
        document.getElementById('debrid-provider').value = d.provider || 'none';
        document.getElementById('debrid-lock').hidden = !d.lockedByEnv;
        const disabled = !!d.lockedByEnv;
        document.getElementById('debrid-provider').disabled = disabled;
        document.getElementById('debrid-key').disabled = disabled;
        document.getElementById('debrid-save').disabled = disabled;
    } catch (_) {
        /* settings guarded by token; ignore until token set */
    }
}

async function saveDebrid(btn) {
    const provider = document.getElementById('debrid-provider').value;
    const apiKey = document.getElementById('debrid-key').value;
    busy(btn, true, 'Saving…');
    try {
        const payload = { provider };
        if (apiKey) payload.apiKey = apiKey;
        await api('/v1/settings/debrid', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        document.getElementById('debrid-key').value = '';
        toast('Debrid settings saved', 'ok');
        await loadSettings();
    } catch (err) {
        toast(err.message, 'err');
    } finally {
        busy(btn, false);
    }
}

async function testDebrid(btn) {
    busy(btn, true, 'Testing…');
    try {
        const body = await api('/v1/settings/debrid/check', { method: 'POST' });
        toast(
            body.ok ? `Debrid OK${body.user ? ' · ' + body.user : ''}` : 'Debrid failed: ' + body.error,
            body.ok ? 'ok' : 'err'
        );
    } catch (err) {
        toast(err.message, 'err');
    } finally {
        busy(btn, false);
    }
}

// ── imports ─────────────────────────────────────────────────────────────────
function wireImports() {
    document.getElementById('url-btn').addEventListener('click', async (e) => {
        const raw = document.getElementById('url-input').value.trim();
        if (!raw) return toast('Enter at least one URL', 'err');
        const urls = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        busy(e.target, true, 'Installing…');
        try {
            const body = await api('/v1/addons/import/url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(urls.length > 1 ? { urls } : { url: urls[0] })
            });
            const n = body.installed != null ? body.installed : body.ok ? 1 : 0;
            toast(`Installed ${n} addon(s)`, body.ok === false ? 'err' : 'ok');
            document.getElementById('url-input').value = '';
            await loadAddons();
        } catch (err) {
            toast(err.message, 'err');
        } finally {
            busy(e.target, false);
        }
    });

    document.getElementById('stremio-btn').addEventListener('click', async (e) => {
        const email = document.getElementById('stremio-email').value.trim();
        const password = document.getElementById('stremio-password').value;
        const authKey = document.getElementById('stremio-authkey').value.trim();
        if (!authKey && (!email || !password)) {
            return toast('Enter email + password, or an authKey', 'err');
        }
        busy(e.target, true, 'Importing…');
        try {
            const payload = authKey ? { authKey } : { email, password };
            const body = await api('/v1/addons/import/stremio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            toast(
                `Imported ${body.installed}/${body.total} from Stremio account`,
                'ok'
            );
            document.getElementById('stremio-password').value = '';
            await loadAddons();
        } catch (err) {
            toast(err.message, 'err');
        } finally {
            busy(e.target, false);
        }
    });

    document.getElementById('repo-btn').addEventListener('click', async (e) => {
        const url = document.getElementById('repo-input').value.trim();
        if (!url) return toast('Enter a repository URL', 'err');
        busy(e.target, true, 'Importing…');
        try {
            const body = await api('/v1/addons/import/repository', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });
            toast(
                `Installed ${body.installed}/${body.discovered} discovered addon(s)`,
                'ok'
            );
            document.getElementById('repo-input').value = '';
            await loadAddons();
        } catch (err) {
            toast(err.message, 'err');
        } finally {
            busy(e.target, false);
        }
    });

    document.getElementById('refresh-btn').addEventListener('click', loadAddons);
    document
        .getElementById('health-btn')
        .addEventListener('click', (e) => runHealthCheck(e.target));
    document.getElementById('addon-search').addEventListener('input', (e) => {
        filterText = e.target.value.trim();
        render();
    });

    document
        .getElementById('debrid-save')
        .addEventListener('click', (e) => saveDebrid(e.target));
    document
        .getElementById('debrid-test')
        .addEventListener('click', (e) => testDebrid(e.target));

    document.getElementById('token-save').addEventListener('click', async () => {
        const token = document.getElementById('token-input').value.trim();
        if (!token) {
            toast('Enter the admin token', 'err');
            return;
        }
        try {
            await loginWithToken(token);
            // Clear the password field so the token does not linger in the DOM.
            document.getElementById('token-input').value = '';
            toast('Signed in (session cookie)', 'ok');
            loadAddons();
            loadSettings();
        } catch (err) {
            toast(err.message || 'Login failed', 'err');
        }
    });
}

// ── helpers ─────────────────────────────────────────────────────────────────
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[c]);
}
function escapeAttr(s) {
    return escapeHtml(s);
}

// ── init ──────────────────────────────────────────────────────────────────────
wireImports();
checkHealth();
ensureSession().then(() => {
    loadAddons();
    loadSettings();
});
setInterval(checkHealth, 30000);
