import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger, redactValue, redactString, configureLogger } from '../dist/telemetry/logger.js';
import { tracer } from '../dist/telemetry/tracing.js';

test('telemetry: logger formats json output with timestamp, level, message, and metadata', () => {
    const logs = [];
    const customWriter = (level, payload) => {
        logs.push({ level, payload: JSON.parse(payload) });
    };

    const logger = new Logger({
        level: 'debug',
        format: 'json',
        writer: customWriter
    });

    logger.info('Server started', { port: 7000, host: '0.0.0.0' });

    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'info');
    assert.equal(logs[0].payload.msg, 'Server started');
    assert.equal(logs[0].payload.level, 'info');
    assert.equal(logs[0].payload.port, 7000);
    assert.equal(logs[0].payload.host, '0.0.0.0');
    assert.ok(logs[0].payload.timestamp);
});

test('telemetry: logger respects log level filtering', () => {
    const logs = [];
    const logger = new Logger({
        level: 'warn',
        writer: (level, payload) => logs.push({ level, payload })
    });

    logger.trace('trace message');
    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    assert.equal(logs.length, 2);
    assert.equal(logs[0].level, 'warn');
    assert.equal(logs[1].level, 'error');
});

test('telemetry: logger redacts sensitive keys and bearer tokens', () => {
    const logs = [];
    const logger = new Logger({
        level: 'info',
        format: 'json',
        writer: (_level, payload) => logs.push(JSON.parse(payload))
    });

    logger.info('User action', {
        password: 'SuperSecretPassword123',
        apiKey: 'sk-live-secret-key-1234567890',
        authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token123',
        token: 'sensitive_token_value',
        nested: {
            adminToken: 'admin_secret',
            safeField: 'hello world'
        }
    });

    assert.equal(logs.length, 1);
    const p = logs[0];
    assert.equal(p.password, '[REDACTED]');
    assert.equal(p.apiKey, '[REDACTED]');
    assert.equal(p.authorization, '[REDACTED]');
    assert.equal(p.token, '[REDACTED]');
    assert.equal(p.nested.adminToken, '[REDACTED]');
    assert.equal(p.nested.safeField, 'hello world');
});

test('telemetry: child logger inherits and merges context', () => {
    const logs = [];
    const parent = new Logger({
        level: 'info',
        format: 'json',
        context: { service: 'addons-core', version: '1.0.0' },
        writer: (_level, payload) => logs.push(JSON.parse(payload))
    });

    const child = parent.child({ component: 'scraper', providerId: 'torrentio' });
    child.info('Scrape complete', { durationMs: 120 });

    assert.equal(logs.length, 1);
    const p = logs[0];
    assert.equal(p.service, 'addons-core');
    assert.equal(p.version, '1.0.0');
    assert.equal(p.component, 'scraper');
    assert.equal(p.providerId, 'torrentio');
    assert.equal(p.durationMs, 120);
    assert.equal(p.msg, 'Scrape complete');
});

test('telemetry: logger automatically binds active span trace context', async () => {
    const logs = [];
    const logger = new Logger({
        level: 'info',
        format: 'json',
        writer: (_level, payload) => logs.push(JSON.parse(payload))
    });

    await tracer.withSpan('test-operation', async (span) => {
        logger.info('Inside span execution');
        assert.equal(logs.length, 1);
        assert.equal(logs[0].traceId, span.traceId);
        assert.equal(logs[0].spanId, span.spanId);
    });
});

test('telemetry: redactString masks bearer tokens, secrets, and truncates huge strings', () => {
    const bearer = 'Bearer ya29.a0AfH6SMD-fake-token-content-12345';
    assert.ok(redactString(bearer).includes('[REDACTED]'));

    const huge = 'This is a public log message with regular words that repeats. '.repeat(50);
    const truncated = redactString(huge, 200);
    assert.ok(truncated.length <= 205);
    assert.ok(truncated.endsWith('…'));
});

test('telemetry: logger redacts secrets in upstreamHost and error context', () => {
    const logs = [];
    const logger = new Logger({
        level: 'info',
        format: 'json',
        writer: (_level, payload) => logs.push(JSON.parse(payload))
    });

    logger.error('Upstream call failed', {
        upstreamHost: 'user:secret_password@upstream.example.com',
        apiKey: 'sk-secret-123456',
        failureClassification: 'http_5xx'
    });

    assert.equal(logs.length, 1);
    const p = logs[0];
    assert.ok(!JSON.stringify(p).includes('secret_password'));
    assert.equal(p.apiKey, '[REDACTED]');
    assert.equal(p.failureClassification, 'http_5xx');
});

test('telemetry: redactString scrubs user:pass in URLs without mangling JSON objects', () => {
    const urlWithAuth = 'Fetching from https://admin:secret_pass123@stream.provider.com/manifest.json';
    const redactedUrl = redactString(urlWithAuth);
    assert.ok(redactedUrl.includes('://[REDACTED]@'));
    assert.ok(!redactedUrl.includes('secret_pass123'));

    const jsonText = '{"channel":"cineflix:main@v1","status":"active"}';
    const redactedJson = redactString(jsonText);
    assert.equal(redactedJson, jsonText); // Not mangled because it is not a URL scheme
});
