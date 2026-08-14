/**
 * Structured Telemetry & High-Performance Logger for addons-core.
 * Phase 6.1: High-throughput zero-dependency structured logger conforming to Pino-style
 * JSON schema in production (timestamp, level, service, version, msg/message, traceId,
 * spanId, actorId, route, method, statusCode, durationMs, upstreamHost, failureClassification)
 * with mandatory central redaction and formatted pretty-print output in development.
 */

import { redactValue, redactString } from '../security/redaction.js';
import { getActiveSpan } from './tracing.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogFormat = 'json' | 'pretty' | 'text';

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60
};

export interface LogContext {
    requestId?: string;
    traceId?: string;
    spanId?: string;
    actorId?: string;
    route?: string;
    method?: string;
    statusCode?: number;
    providerId?: string;
    addonId?: string;
    jobId?: string;
    upstreamHost?: string;
    targetHost?: string;
    durationMs?: number;
    failureClassification?: string;
    version?: string;
    component?: string;
    [key: string]: unknown;
}

export interface LoggerOptions {
    level?: LogLevel;
    format?: LogFormat;
    serviceVersion?: string;
    serviceName?: string;
    bindings?: LogContext;
    outputStream?: { write: (msg: string) => boolean | void };
    errorStream?: { write: (msg: string) => boolean | void };
    writer?: (level: LogLevel, payload: string) => void;
}

export class Logger {
    private level: LogLevel;
    private format: LogFormat;
    private serviceVersion: string;
    private serviceName: string;
    private bindings: LogContext;
    private outputStream: { write: (msg: string) => boolean | void };
    private errorStream: { write: (msg: string) => boolean | void };
    private writer?: (level: LogLevel, payload: string) => void;

    constructor(opts: LoggerOptions = {}) {
        this.level = opts.level ?? 'info';
        this.format = opts.format ?? 'json';
        this.serviceVersion = opts.serviceVersion ?? '1.0.0';
        this.serviceName = opts.serviceName ?? 'addons-core';
        this.bindings = opts.bindings ? { ...opts.bindings } : {};
        this.outputStream = opts.outputStream ?? process.stdout;
        this.errorStream = opts.errorStream ?? process.stderr;
        this.writer = opts.writer;
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    getLevel(): LogLevel {
        return this.level;
    }

    setFormat(format: LogFormat): void {
        this.format = format;
    }

    getFormat(): LogFormat {
        return this.format;
    }

    isLevelEnabled(targetLevel: LogLevel): boolean {
        return LEVEL_WEIGHTS[targetLevel] >= LEVEL_WEIGHTS[this.level];
    }

    /**
     * Create a child logger that inherits and extends contextual bindings.
     */
    child(bindings: LogContext): Logger {
        return new Logger({
            level: this.level,
            format: this.format,
            serviceVersion: this.serviceVersion,
            serviceName: this.serviceName,
            bindings: { ...this.bindings, ...bindings },
            outputStream: this.outputStream,
            errorStream: this.errorStream,
            writer: this.writer
        });
    }

    trace(msg: string | Error | unknown, context?: LogContext): void {
        this.log('trace', msg, context);
    }

    debug(msg: string | Error | unknown, context?: LogContext): void {
        this.log('debug', msg, context);
    }

    info(msg: string | Error | unknown, context?: LogContext): void {
        this.log('info', msg, context);
    }

    warn(msg: string | Error | unknown, context?: LogContext): void {
        this.log('warn', msg, context);
    }

    error(msg: string | Error | unknown, context?: LogContext): void {
        this.log('error', msg, context);
    }

    fatal(msg: string | Error | unknown, context?: LogContext): void {
        this.log('fatal', msg, context);
    }

    public log(
        level: LogLevel,
        rawMsg: string | Error | unknown,
        explicitContext?: LogContext
    ): void {
        if (!this.isLevelEnabled(level)) {
            return;
        }

        const timestamp = new Date().toISOString();
        let message = '';
        const errorData: LogContext = {};

        if (rawMsg instanceof Error) {
            message = rawMsg.message;
            errorData.errorName = rawMsg.name;
            errorData.errorMessage = rawMsg.message;
            if (rawMsg.stack) {
                errorData.errorStack = rawMsg.stack;
            }
        } else if (typeof rawMsg === 'string') {
            message = rawMsg;
        } else if (rawMsg !== null && typeof rawMsg === 'object') {
            message = JSON.stringify(redactValue(rawMsg));
        } else {
            message = String(rawMsg);
        }

        // Active trace context enrichment if available
        const activeSpan = getActiveSpan();
        const traceEnrichment: LogContext = {};
        if (activeSpan) {
            traceEnrichment.traceId = activeSpan.traceId;
            traceEnrichment.spanId = activeSpan.spanId;
        }

        // Merge bindings, trace context, and explicit context
        const rawPayload: LogContext = {
            ...this.bindings,
            ...traceEnrichment,
            ...explicitContext,
            ...errorData
        };

        // Deep central redaction
        const sanitizedContext = (redactValue(rawPayload) as LogContext) || {};

        if (this.writer) {
            const entry = {
                timestamp,
                level,
                service: this.serviceName,
                version: this.serviceVersion,
                msg: redactString(message),
                message: redactString(message),
                ...sanitizedContext
            };
            this.writer(level, JSON.stringify(entry));
            return;
        }

        if (this.format === 'json') {
            const entry = {
                timestamp,
                level,
                service: this.serviceName,
                version: this.serviceVersion,
                msg: redactString(message),
                message: redactString(message),
                ...sanitizedContext
            };
            const line = JSON.stringify(entry) + '\n';
            if (level === 'error' || level === 'fatal') {
                this.errorStream.write(line);
            } else {
                this.outputStream.write(line);
            }
        } else if (this.format === 'pretty') {
            const colorCode = this.getColorCode(level);
            const resetCode = '\x1b[0m';
            const dimCode = '\x1b[2m';
            const levelLabel = level.toUpperCase().padEnd(5);

            const contextPairs: string[] = [];
            for (const [k, v] of Object.entries(sanitizedContext)) {
                if (v !== undefined && v !== null && k !== 'errorStack') {
                    contextPairs.push(
                        `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`
                    );
                }
            }
            const contextStr = contextPairs.length
                ? ` ${dimCode}(${contextPairs.join(' ')})${resetCode}`
                : '';
            const line = `${dimCode}[${timestamp}]${resetCode} ${colorCode}${levelLabel}${resetCode} ${redactString(message)}${contextStr}\n`;

            if (level === 'error' || level === 'fatal') {
                this.errorStream.write(line);
                if (sanitizedContext.errorStack) {
                    this.errorStream.write(
                        `${dimCode}${sanitizedContext.errorStack}${resetCode}\n`
                    );
                }
            } else {
                this.outputStream.write(line);
            }
        } else {
            // Text format
            const contextStr = Object.entries(sanitizedContext)
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(' ');
            const line = `[${timestamp}] ${level.toUpperCase()}: ${message} ${contextStr}\n`;
            if (level === 'error' || level === 'fatal') {
                this.errorStream.write(line);
            } else {
                this.outputStream.write(line);
            }
        }
    }

    private getColorCode(level: LogLevel): string {
        switch (level) {
            case 'trace':
                return '\x1b[90m'; // Grey
            case 'debug':
                return '\x1b[36m'; // Cyan
            case 'info':
                return '\x1b[32m'; // Green
            case 'warn':
                return '\x1b[33m'; // Yellow
            case 'error':
                return '\x1b[31m'; // Red
            case 'fatal':
                return '\x1b[35m\x1b[1m'; // Bold Magenta
            default:
                return '\x1b[0m';
        }
    }
}

export let logger = new Logger();

export function configureLogger(opts: LoggerOptions): Logger {
    logger = new Logger(opts);
    return logger;
}

export { redactValue, redactString } from '../security/redaction.js';
