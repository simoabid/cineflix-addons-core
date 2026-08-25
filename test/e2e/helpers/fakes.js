/**
 * E2E fake upstreams.
 *
 * startFakeTmdb   — minimal TMDB v3 API answering movie/tv detail lookups
 *                   (used via TMDB_API_BASE_URL so identity resolution never
 *                   touches the real network).
 * startFakeMedia  — static-byte media origin with HTTP Range support that
 *                   playback grants ultimately proxy.
 */
import { startHttpServer } from '../../helpers/harness.js';

export function startFakeTmdb({ movies = {}, tv = {} } = {}) {
    return startHttpServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (!u.searchParams.get('api_key')) {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ status_message: 'invalid key' }));
        }
        const movie = u.pathname.match(/^\/3\/movie\/(\d+)$/);
        if (movie) {
            const body = movies[movie[1]] ?? {
                title: `E2E Movie ${movie[1]}`,
                release_date: '2001-01-01',
                external_ids: { imdb_id: `tt${movie[1]}` }
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(body));
        }
        const show = u.pathname.match(/^\/3\/tv\/(\d+)$/);
        if (show) {
            const body = tv[show[1]] ?? {
                name: `E2E Show ${show[1]}`,
                first_air_date: '2002-02-02',
                external_ids: { imdb_id: `tt${show[1]}` }
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(body));
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status_code: 34 }));
    });
}

/** Deterministic pseudo-random payload so proxied bytes can be verified. */
export function mediaPayload(size = 64 * 1024) {
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
    return buf;
}

export function startFakeMedia(payload = mediaPayload()) {
    const seen = [];
    const handle = startHttpServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/video.mp4') {
            res.writeHead(404);
            return res.end();
        }
        seen.push(req.headers.range ?? null);
        const range = req.headers.range;
        const baseHeaders = {
            'content-type': 'video/mp4',
            'accept-ranges': 'bytes'
        };
        if (range) {
            const m = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (m) {
                const start = Number(m[1]);
                const end = m[2]
                    ? Math.min(Number(m[2]), payload.length - 1)
                    : payload.length - 1;
                if (start >= payload.length || start > end) {
                    res.writeHead(416, {
                        'content-range': `bytes */${payload.length}`
                    });
                    return res.end();
                }
                res.writeHead(206, {
                    ...baseHeaders,
                    'content-range': `bytes ${start}-${end}/${payload.length}`,
                    'content-length': String(end - start + 1)
                });
                return res.end(payload.subarray(start, end + 1));
            }
        }
        res.writeHead(200, {
            ...baseHeaders,
            'content-length': String(payload.length)
        });
        res.end(payload);
    }).then((h) => ({ ...h, seen, payload }));
    return handle;
}
