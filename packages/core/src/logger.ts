import { pino, type Logger } from 'pino';
import type { Redactor, StructuredLogger } from '@upgradelab/contracts';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly redactor: Redactor;
  readonly destination?: NodeJS.WritableStream;
  /** Adds static bindings to every record, e.g. runId. */
  readonly bindings?: Record<string, unknown>;
}

/**
 * Pino-backed structured logger.
 *
 * Every message and data payload is redacted before it reaches Pino, so no
 * transport or destination can accidentally persist a secret. Logs go to
 * stderr by default, keeping stdout free for machine-readable CLI output.
 */
export function createLogger(options: LoggerOptions): StructuredLogger {
  const { redactor } = options;
  const pinoLogger: Logger = pino(
    {
      level: options.level ?? 'info',
      base: { tool: 'upgradelab', ...options.bindings },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination ?? process.stderr,
  );

  const wrap = (target: Logger): StructuredLogger => ({
    debug(message, data) {
      target.debug(data ? redactor.redactDeep(data) : {}, redactor.redact(message));
    },
    info(message, data) {
      target.info(data ? redactor.redactDeep(data) : {}, redactor.redact(message));
    },
    warn(message, data) {
      target.warn(data ? redactor.redactDeep(data) : {}, redactor.redact(message));
    },
    error(message, data) {
      target.error(data ? redactor.redactDeep(data) : {}, redactor.redact(message));
    },
    child(bindings) {
      return wrap(target.child(redactor.redactDeep(bindings)));
    },
  });

  return wrap(pinoLogger);
}

/** Logger that discards everything; used until configuration is loaded. */
export function createNullLogger(): StructuredLogger {
  const noop = (): void => {};
  const logger: StructuredLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
