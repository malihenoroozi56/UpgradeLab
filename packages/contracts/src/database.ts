import type { UpgradeLabError } from './errors.js';
import type { StructuredLogger } from './execution.js';

/** JSON-safe scalar returned by database adapters. */
export type SqlScalar = string | number | boolean | null;

/** One row, keyed by column name. Values are normalized to JSON-safe scalars. */
export type SqlRow = Readonly<Record<string, SqlScalar>>;

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly SqlRow[];
  /** Number of rows returned after client-side truncation. */
  readonly rowCount: number;
  /** Scalar values of the first column of every row; convenient for invariants. */
  readonly values: readonly SqlScalar[];
  /** True when the adapter truncated the result at `maxRows`. */
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly executedAt: string;
}

export interface DatabaseTarget {
  readonly adapter: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: boolean;
}

export interface QueryOptions {
  readonly statementTimeoutMs: number;
  readonly maxRows: number;
  readonly signal?: AbortSignal;
}

/**
 * A read-only database session.
 *
 * Implementations must enforce read-only behaviour at the database level, not
 * only by inspecting SQL text.
 */
export interface DatabaseConnection {
  execute(query: string, options?: Partial<QueryOptions>): Promise<QueryResult>;
  dispose(): Promise<void>;
}

export interface DatabaseAdapter {
  readonly id: string;
  readonly description: string;

  /**
   * Rejects queries that cannot be executed safely as read-only statements.
   * Throws UpgradeLabError(ASSERTION_UNSAFE_QUERY) when rejected.
   */
  validateReadOnlyQuery(query: string): void;

  connect(
    target: DatabaseTarget,
    options: QueryOptions & { connectionTimeoutMs: number; logger: StructuredLogger },
  ): Promise<DatabaseConnection>;
}

/** Collects the result of a baseline capture for later comparison. */
export interface BaselineSnapshot {
  readonly checkId: string;
  readonly query: string;
  readonly result: QueryResult;
  readonly capturedAt: string;
}

/** Port used by the assertion layer to run verified, read-only SQL. */
export interface SqlExecutor {
  execute(query: string): Promise<QueryResult>;
  readonly target: Omit<DatabaseTarget, 'password'>;
}

export type { UpgradeLabError };
