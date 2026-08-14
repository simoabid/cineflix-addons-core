/**
 * Distributed Tracing & W3C Trace Context Engine for addons-core.
 * Phase 6.3: Implements W3C Trace Context, AsyncLocalStorage context propagation,
 * span lifecycle, safe attribute sanitization, and an in-memory trace recorder.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { redactString, redactUrl } from '../security/redaction.js';

export interface SpanContext {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    traceFlags: string;
}

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanEvent {
    name: string;
    timestamp: number;
    attributes?: Record<string, unknown>;
}

export interface SpanSnapshot {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    startTime: number;
    endTime?: number;
    durationMs?: number;
    status: SpanStatus;
    statusMessage?: string;
    attributes: Record<string, string | number | boolean>;
    events: SpanEvent[];
}

const FORBIDDEN_ATTR_PATTERNS =
    /password|secret|token|apikey|api_key|auth|cookie|authorization/i;

function sanitizeAttributeValue(
    key: string,
    val: unknown
): string | number | boolean | undefined {
    if (val === undefined || val === null) return undefined;
    if (typeof val === 'number' || typeof val === 'boolean') return val;

    if (FORBIDDEN_ATTR_PATTERNS.test(key)) {
        return '[REDACTED]';
    }

    const str = String(val);
    if (/^https?:\/\//i.test(str)) {
        return redactUrl(str);
    }
    return redactString(str, 250);
}

export class Span {
    public readonly traceId: string;
    public readonly spanId: string;
    public readonly parentSpanId?: string;
    public readonly name: string;
    public readonly startTime: number;
    public endTime?: number;
    public durationMs?: number;
    public status: SpanStatus = 'unset';
    public statusMessage?: string;
    public attributes: Record<string, string | number | boolean> = {};
    public events: SpanEvent[] = [];
    private ended = false;
    private readonly onEnd?: (span: Span) => void;

    constructor(
        name: string,
        context: SpanContext,
        initialAttributes?: Record<string, unknown>,
        onEnd?: (span: Span) => void
    ) {
        this.name = name;
        this.traceId = context.traceId;
        this.spanId = context.spanId;
        this.parentSpanId = context.parentSpanId;
        this.startTime = Date.now();
        this.onEnd = onEnd;

        if (initialAttributes) {
            this.setAttributes(initialAttributes);
        }
    }

    setAttribute(key: string, value: unknown): this {
        if (this.ended) return this;
        const sanitized = sanitizeAttributeValue(key, value);
        if (sanitized !== undefined) {
            this.attributes[key] = sanitized;
        }
        return this;
    }

    setAttributes(attributes: Record<string, unknown>): this {
        if (this.ended) return this;
        for (const [k, v] of Object.entries(attributes)) {
            this.setAttribute(k, v);
        }
        return this;
    }

    addEvent(name: string, attributes?: Record<string, unknown>): this {
        if (this.ended) return this;
        let sanitizedAttrs: Record<string, unknown> | undefined;
        if (attributes) {
            sanitizedAttrs = {};
            for (const [k, v] of Object.entries(attributes)) {
                const s = sanitizeAttributeValue(k, v);
                if (s !== undefined) {
                    sanitizedAttrs[k] = s;
                }
            }
        }
        this.events.push({
            name,
            timestamp: Date.now(),
            attributes: sanitizedAttrs
        });
        return this;
    }

    setStatus(status: SpanStatus, message?: string): this {
        if (this.ended) return this;
        this.status = status;
        if (message) {
            this.statusMessage = redactString(message, 300);
        }
        return this;
    }

    recordException(err: unknown): this {
        if (this.ended) return this;
        this.status = 'error';
        const msg = err instanceof Error ? err.message : String(err);
        this.statusMessage = redactString(msg, 300);
        this.setAttribute('error', true);
        this.setAttribute(
            'error.type',
            err instanceof Error ? err.name : 'Error'
        );
        this.setAttribute('error.message', redactString(msg, 300));
        return this;
    }

    end(): void {
        if (this.ended) return;
        this.ended = true;
        this.endTime = Date.now();
        this.durationMs = Math.max(0, this.endTime - this.startTime);
        if (this.status === 'unset') {
            this.status = 'ok';
        }
        if (this.onEnd) {
            try {
                this.onEnd(this);
            } catch {
                /* ignore */
            }
        }
    }

    toSnapshot(): SpanSnapshot {
        return {
            traceId: this.traceId,
            spanId: this.spanId,
            parentSpanId: this.parentSpanId,
            name: this.name,
            startTime: this.startTime,
            endTime: this.endTime,
            durationMs:
                this.durationMs ?? Math.max(0, Date.now() - this.startTime),
            status: this.status,
            statusMessage: this.statusMessage,
            attributes: { ...this.attributes },
            events: [...this.events]
        };
    }

    toPublicJson(): SpanSnapshot {
        return this.toSnapshot();
    }

    toJSON(): SpanSnapshot {
        return this.toSnapshot();
    }
}

export class TraceRecorder {
    private buffer: SpanSnapshot[] = [];
    private readonly capacity: number;

    constructor(capacity = 500) {
        this.capacity = capacity;
    }

    record(span: Span): void {
        if (this.buffer.length >= this.capacity) {
            this.buffer.shift();
        }
        this.buffer.push(span.toSnapshot());
    }

    getRecent(limit = 100): SpanSnapshot[] {
        return this.buffer.slice(-limit).reverse();
    }

    findByTraceId(traceId: string): SpanSnapshot[] {
        return this.buffer.filter((s) => s.traceId === traceId);
    }

    findSlowSpans(minDurationMs: number, limit = 50): SpanSnapshot[] {
        return this.buffer
            .filter((s) => (s.durationMs ?? 0) >= minDurationMs)
            .slice(-limit)
            .reverse();
    }

    findErrors(limit = 50): SpanSnapshot[] {
        return this.buffer
            .filter((s) => s.status === 'error')
            .slice(-limit)
            .reverse();
    }

    clear(): void {
        this.buffer = [];
    }

    size(): number {
        return this.buffer.length;
    }
}

export const globalTraceRecorder = new TraceRecorder(1000);

const asyncLocalStorage = new AsyncLocalStorage<Span>();

export interface TracerOptions {
    enabled?: boolean;
    recorder?: TraceRecorder;
}

export class Tracer {
    private enabled = true;
    private readonly recorder: TraceRecorder;

    constructor(
        optsOrRecorder?: TracerOptions | TraceRecorder,
        enabled = true
    ) {
        if (optsOrRecorder instanceof TraceRecorder) {
            this.recorder = optsOrRecorder;
            this.enabled = enabled;
        } else if (optsOrRecorder && typeof optsOrRecorder === 'object') {
            this.recorder = optsOrRecorder.recorder ?? globalTraceRecorder;
            this.enabled = optsOrRecorder.enabled ?? true;
        } else {
            this.recorder = globalTraceRecorder;
            this.enabled = enabled;
        }
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    generateTraceId(): string {
        return crypto.randomBytes(16).toString('hex');
    }

    generateSpanId(): string {
        return crypto.randomBytes(8).toString('hex');
    }

    /**
     * Parse W3C traceparent header: 00-${traceId}-${spanId}-${flags}
     */
    extractTraceparent(
        headers?: Record<string, string | string[] | undefined> | null
    ): SpanContext | null {
        if (!headers) return null;

        let rawHeader: string | undefined;
        for (const [k, v] of Object.entries(headers)) {
            const lk = k.toLowerCase();
            if (lk === 'traceparent') {
                rawHeader = Array.isArray(v) ? v[0] : v;
                break;
            }
        }

        if (rawHeader && typeof rawHeader === 'string') {
            const match =
                /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(
                    rawHeader.trim()
                );
            if (match && match[1] && match[2] && match[3]) {
                if (
                    match[1] !== '00000000000000000000000000000000' &&
                    match[2] !== '0000000000000000'
                ) {
                    return {
                        traceId: match[1].toLowerCase(),
                        spanId: this.generateSpanId(),
                        parentSpanId: match[2].toLowerCase(),
                        traceFlags: match[3]
                    };
                }
            }
        }

        // Fallback: check x-trace-id or x-request-id
        for (const [k, v] of Object.entries(headers)) {
            const lk = k.toLowerCase();
            if (lk === 'x-trace-id' || lk === 'x-request-id') {
                const val = Array.isArray(v) ? v[0] : v;
                if (val && /^[0-9a-f]{32}$/i.test(val.trim())) {
                    return {
                        traceId: val.trim().toLowerCase(),
                        spanId: this.generateSpanId(),
                        traceFlags: '01'
                    };
                }
            }
        }

        return null;
    }

    /**
     * Inject W3C traceparent header into outgoing headers object.
     */
    injectTraceparent(
        targetHeaders: Record<string, string>,
        span?: Span | null
    ): Record<string, string> {
        const active = span || this.getActiveSpan();
        if (!active) return targetHeaders;

        targetHeaders['traceparent'] =
            `00-${active.traceId}-${active.spanId}-01`;
        targetHeaders['x-trace-id'] = active.traceId;
        return targetHeaders;
    }

    startSpan(
        name: string,
        options: {
            parentContext?: SpanContext | null;
            attributes?: Record<string, unknown>;
        } = {}
    ): Span {
        const activeParent = this.getActiveSpan();
        let context: SpanContext;

        if (options.parentContext) {
            context = {
                traceId: options.parentContext.traceId,
                spanId: this.generateSpanId(),
                parentSpanId:
                    options.parentContext.parentSpanId ||
                    options.parentContext.spanId,
                traceFlags: options.parentContext.traceFlags || '01'
            };
        } else if (activeParent) {
            context = {
                traceId: activeParent.traceId,
                spanId: this.generateSpanId(),
                parentSpanId: activeParent.spanId,
                traceFlags: '01'
            };
        } else {
            context = {
                traceId: this.generateTraceId(),
                spanId: this.generateSpanId(),
                traceFlags: '01'
            };
        }

        return new Span(name, context, options.attributes, (span) =>
            this.recorder.record(span)
        );
    }

    getActiveSpan(): Span | undefined {
        return asyncLocalStorage.getStore();
    }

    /**
     * Execute an asynchronous function within the context of a new active span.
     */
    async withSpan<T>(
        name: string,
        fn: (span: Span) => Promise<T>,
        options: {
            parentContext?: SpanContext | null;
            attributes?: Record<string, unknown>;
        } = {}
    ): Promise<T> {
        const span = this.startSpan(name, options);
        return asyncLocalStorage.run(span, async () => {
            try {
                const result = await fn(span);
                span.end();
                return result;
            } catch (err) {
                span.recordException(err);
                span.end();
                throw err;
            }
        });
    }

    /**
     * Execute a synchronous function within the context of an active span.
     */
    runWithSpan<T>(span: Span, fn: () => T): T {
        return asyncLocalStorage.run(span, fn);
    }
}

export const tracer = new Tracer();

export function getActiveSpan(): Span | undefined {
    return tracer.getActiveSpan();
}
