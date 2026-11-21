/**
 * Structured error model shared by every UpgradeLab package.
 *
 * Errors are the only supported way for internal layers to communicate failure
 * to the CLI and the GitHub Action, because each error carries a stable code,
 * a category and a documented process exit code.
 */

export const EXIT_CODES = {
  OK: 0,
  TEST_FAILED: 1,
  CONFIG_ERROR: 2,
  ENVIRONMENT_ERROR: 3,
  CANCELLED: 4,
  INTERNAL_ERROR: 5,
  PLUGIN_ERROR: 6,
  INCONCLUSIVE: 7,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type ErrorCategory =
  | 'CONFIG'
  | 'ENVIRONMENT'
  | 'PROVIDER'
  | 'ASSERTION'
  | 'SECURITY'
  | 'PLUGIN'
  | 'AI'
  | 'CANCELLED'
  | 'INTERNAL';

export type ErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_PARSE_ERROR'
  | 'CONFIG_VALIDATION_ERROR'
  | 'CONFIG_UNSUPPORTED_VERSION'
  | 'CONFIG_SECRET_UNRESOLVED'
  | 'CONFIG_UNSAFE_PLUGIN_LOAD'
  | 'ENVIRONMENT_DOCKER_MISSING'
  | 'ENVIRONMENT_COMPOSE_MISSING'
  | 'ENVIRONMENT_COMPOSE_INVALID'
  | 'ENVIRONMENT_UNSAFE_COMPOSE_CONFIG'
  | 'ENVIRONMENT_NOT_READY'
  | 'ENVIRONMENT_CONNECTION_FAILED'
  | 'PROVIDER_COMMAND_FAILED'
  | 'PROVIDER_CLEANUP_FAILED'
  | 'PROVIDER_OWNERSHIP_VIOLATION'
  | 'ASSERTION_FAILED'
  | 'ASSERTION_ERROR'
  | 'ASSERTION_UNSUPPORTED'
  | 'ASSERTION_UNSAFE_QUERY'
  | 'DATABASE_CONNECTION_FAILED'
  | 'DATABASE_QUERY_FAILED'
  | 'PLUGIN_INVALID'
  | 'PLUGIN_LOAD_FAILED'
  | 'PLUGIN_DUPLICATE'
  | 'PLUGIN_UNTRUSTED_PATH'
  | 'AI_DISABLED'
  | 'AI_MISSING_API_KEY'
  | 'AI_PROVIDER_ERROR'
  | 'AI_RESPONSE_INVALID'
  | 'EXECUTION_TIMEOUT'
  | 'EXECUTION_CANCELLED'
  | 'REPORT_WRITE_FAILED'
  | 'INTERNAL_ERROR';

export interface SerializedError {
  readonly name: string;
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: SerializedError;
  readonly stack?: string;
}

export interface UpgradeLabErrorOptions {
  readonly code: ErrorCode;
  readonly category?: ErrorCategory;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
  readonly hint?: string;
}

const CATEGORY_BY_CODE: Record<ErrorCode, ErrorCategory> = {
  CONFIG_NOT_FOUND: 'CONFIG',
  CONFIG_PARSE_ERROR: 'CONFIG',
  CONFIG_VALIDATION_ERROR: 'CONFIG',
  CONFIG_UNSUPPORTED_VERSION: 'CONFIG',
  CONFIG_SECRET_UNRESOLVED: 'CONFIG',
  CONFIG_UNSAFE_PLUGIN_LOAD: 'CONFIG',
  ENVIRONMENT_DOCKER_MISSING: 'ENVIRONMENT',
  ENVIRONMENT_COMPOSE_MISSING: 'ENVIRONMENT',
  ENVIRONMENT_COMPOSE_INVALID: 'ENVIRONMENT',
  ENVIRONMENT_UNSAFE_COMPOSE_CONFIG: 'SECURITY',
  ENVIRONMENT_NOT_READY: 'ENVIRONMENT',
  ENVIRONMENT_CONNECTION_FAILED: 'ENVIRONMENT',
  PROVIDER_COMMAND_FAILED: 'PROVIDER',
  PROVIDER_CLEANUP_FAILED: 'PROVIDER',
  PROVIDER_OWNERSHIP_VIOLATION: 'SECURITY',
  ASSERTION_FAILED: 'ASSERTION',
  ASSERTION_ERROR: 'ASSERTION',
  ASSERTION_UNSUPPORTED: 'ASSERTION',
  ASSERTION_UNSAFE_QUERY: 'SECURITY',
  DATABASE_CONNECTION_FAILED: 'ENVIRONMENT',
  DATABASE_QUERY_FAILED: 'ASSERTION',
  PLUGIN_INVALID: 'PLUGIN',
  PLUGIN_LOAD_FAILED: 'PLUGIN',
  PLUGIN_DUPLICATE: 'PLUGIN',
  PLUGIN_UNTRUSTED_PATH: 'PLUGIN',
  AI_DISABLED: 'AI',
  AI_MISSING_API_KEY: 'AI',
  AI_PROVIDER_ERROR: 'AI',
  AI_RESPONSE_INVALID: 'AI',
  EXECUTION_TIMEOUT: 'ENVIRONMENT',
  EXECUTION_CANCELLED: 'CANCELLED',
  REPORT_WRITE_FAILED: 'INTERNAL',
  INTERNAL_ERROR: 'INTERNAL',
};

const EXIT_CODE_BY_CATEGORY: Record<ErrorCategory, ExitCode> = {
  CONFIG: EXIT_CODES.CONFIG_ERROR,
  ENVIRONMENT: EXIT_CODES.ENVIRONMENT_ERROR,
  PROVIDER: EXIT_CODES.ENVIRONMENT_ERROR,
  ASSERTION: EXIT_CODES.TEST_FAILED,
  SECURITY: EXIT_CODES.CONFIG_ERROR,
  PLUGIN: EXIT_CODES.PLUGIN_ERROR,
  AI: EXIT_CODES.INTERNAL_ERROR,
  CANCELLED: EXIT_CODES.CANCELLED,
  INTERNAL: EXIT_CODES.INTERNAL_ERROR,
};

export class UpgradeLabError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly details: Record<string, unknown>;
  readonly hint: string | undefined;
  override readonly cause: unknown;

  constructor(message: string, options: UpgradeLabErrorOptions) {
    super(message);
    this.name = 'UpgradeLabError';
    this.code = options.code;
    this.category = options.category ?? CATEGORY_BY_CODE[options.code];
    this.details = options.details ?? {};
    this.hint = options.hint;
    this.cause = options.cause;
  }

  get exitCode(): ExitCode {
    return EXIT_CODE_BY_CATEGORY[this.category];
  }

  toJSON(): SerializedError {
    const details = this.hint ? { ...this.details, hint: this.hint } : this.details;
    const serialized: SerializedError = {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      ...(Object.keys(details).length > 0 ? { details } : {}),
      ...(this.cause !== undefined ? { cause: serializeError(this.cause) } : {}),
      ...(this.stack ? { stack: this.stack } : {}),
    };
    return serialized;
  }
}

/** Normalizes any thrown value into a serializable error document. */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof UpgradeLabError) {
    return error.toJSON();
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      code: 'INTERNAL_ERROR',
      category: 'INTERNAL',
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return {
    name: 'UnknownError',
    code: 'INTERNAL_ERROR',
    category: 'INTERNAL',
    message: typeof error === 'string' ? error : JSON.stringify(error),
  };
}

/** Maps a thrown value to the CLI process exit code. */
export function exitCodeForError(error: unknown): ExitCode {
  return error instanceof UpgradeLabError ? error.exitCode : EXIT_CODES.INTERNAL_ERROR;
}

export function isUpgradeLabError(error: unknown): error is UpgradeLabError {
  return error instanceof UpgradeLabError;
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ABORT_ERR')
  );
}

export const SECURITY_ERROR_CODES: readonly ErrorCode[] = [
  'ENVIRONMENT_UNSAFE_COMPOSE_CONFIG',
  'PROVIDER_OWNERSHIP_VIOLATION',
  'ASSERTION_UNSAFE_QUERY',
  'CONFIG_UNSAFE_PLUGIN_LOAD',
  'PLUGIN_UNTRUSTED_PATH',
];
