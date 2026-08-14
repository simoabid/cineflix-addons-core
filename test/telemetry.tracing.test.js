import test from 'node:test';
import assert from 'node:assert/strict';
import { Tracer, TraceRecorder } from '../dist/telemetry/tracing.js';

test('tracing: generates valid 32-hex traceId and 16-hex spanId', () => {
    const tracer = new Tracer({ enabled: true });
    const span = tracer.startSpan('http.request');

    assert.equal(span.traceId.length, 32);
    assert.match(span.traceId, /^[0-9a-f]{32}$/);
    assert.equal(span.spanId.length, 16);
    assert.match(span.spanId, /^[0-9a-f]{16}$/);

    span.end();
    assert.ok(span.durationMs !== undefined);
    assert.ok(span.durationMs >= 0);
});

test('tracing: W3C traceparent header extraction and injection', () => {
    const tracer = new Tracer({ enabled: true });
    const incomingTraceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    const ctx = tracer.extractTraceparent({ traceparent: incomingTraceparent });
    assert.ok(ctx);
    assert.equal(ctx.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(ctx.parentSpanId, '00f067aa0ba902b7');

    const span = tracer.startSpan('child.operation', { parentContext: ctx });
    assert.equal(span.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(span.parentSpanId, '00f067aa0ba902b7');
    assert.notEqual(span.spanId, '00f067aa0ba902b7');

    const carrier = {};
    tracer.injectTraceparent(carrier, span);
    assert.ok(carrier.traceparent);
    assert.ok(carrier.traceparent.startsWith(`00-${span.traceId}-${span.spanId}-`));

    span.end();
});

test('tracing: span attribute sanitization redacts sensitive attributes', () => {
    const tracer = new Tracer({ enabled: true });
    const span = tracer.startSpan('db.query');

    span.setAttribute('user.password', 'secret123');
    span.setAttribute('http.authorization', 'Bearer token123');
    span.setAttribute('query.table', 'addons');

    const attrs = span.toPublicJson().attributes;
    assert.equal(attrs['user.password'], '[REDACTED]');
    assert.equal(attrs['http.authorization'], '[REDACTED]');
    assert.equal(attrs['query.table'], 'addons');

    span.end();
});

test('tracing: withSpan propagates context through AsyncLocalStorage', async () => {
    const tracer = new Tracer({ enabled: true });

    await tracer.withSpan('parent.task', async (parentSpan) => {
        assert.equal(tracer.getActiveSpan()?.spanId, parentSpan.spanId);

        await tracer.withSpan('child.task', async (childSpan) => {
            assert.equal(tracer.getActiveSpan()?.spanId, childSpan.spanId);
            assert.equal(childSpan.traceId, parentSpan.traceId);
            assert.equal(childSpan.parentSpanId, parentSpan.spanId);
        });

        assert.equal(tracer.getActiveSpan()?.spanId, parentSpan.spanId);
    });

    assert.equal(tracer.getActiveSpan(), undefined);
});

test('tracing: TraceRecorder stores and queries spans in ring buffer', () => {
    const recorder = new TraceRecorder(10);
    const tracer = new Tracer({ enabled: true, recorder });

    for (let i = 0; i < 15; i++) {
        const span = tracer.startSpan(`operation-${i}`);
        if (i === 12) {
            span.setStatus('error', 'Operation failed');
        }
        span.end();
    }

    const recent = recorder.getRecent(10);
    assert.equal(recent.length, 10);
    assert.equal(recent[0].name, 'operation-14');

    const errors = recent.filter((s) => s.status === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, 'operation-12');
});

test('tracing: addEvent sanitizes sensitive attributes in span events', () => {
    const tracer = new Tracer({ enabled: true });
    const span = tracer.startSpan('scrape.task');

    span.addEvent('auth_attempt', {
        providerId: 'torrentio',
        apiKey: 'sk-secret-token-12345',
        authorization: 'Bearer eyJhbGciOiJIUzI1Ni...'
    });

    const json = span.toPublicJson();
    assert.equal(json.events.length, 1);
    assert.equal(json.events[0].name, 'auth_attempt');
    assert.equal(json.events[0].attributes?.providerId, 'torrentio');
    assert.equal(json.events[0].attributes?.apiKey, '[REDACTED]');
    assert.equal(json.events[0].attributes?.authorization, '[REDACTED]');
    span.end();
});
