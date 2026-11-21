import { Client } from 'pg';
import {
  UpgradeLabError,
  type DatabaseAdapter,
  type DatabaseConnection,
  type DatabaseTarget,
  type QueryOptions,
  type QueryResult,
  type SqlRow,
  type SqlScalar,
  type StructuredLogger,
} from '@upgradelab/contracts';
import { validateReadOnlySql } from './sql-guard.js';

const SESSION_IDLE_TIMEOUT_MS = 60_000;

interface PreparedProbe {
  readonly text: string;
  readonly capped: boolean;
}

/**
 * Wraps a read-only statement in an outer LIMIT so a query over a large table
 * cannot exhaust memory. Statements that cannot be used as a subquery (SHOW,
 * EXPLAIN) run as-is and are truncated client-side.
 */
export function prepareProbe(query: string, maxRows: number): PreparedProbe {
  const leading = query.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const canWrap =
    leading === 'select' || leading === 'with' || leading === 'values' || leading === 'table';
  if (!canWrap) {
    return { text: query, capped: false };
  }
  return {
    text: `SELECT * FROM (\n${query}\n) AS upgradelab_probe LIMIT ${maxRows + 1}`,
    capped: true,
  };
}

/** Converts driver values into JSON-safe scalars with stable representations. */
export function normalizeSqlValue(value: unknown): SqlScalar {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return `<binary:${value.byteLength} bytes>`;
  }
  if (Array.isArray(value) || typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

interface PostgresError extends Error {
  readonly code?: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly position?: string;
}

function translateQueryError(error: unknown): UpgradeLabError {
  if (error instanceof UpgradeLabError) {
    return error;
  }
  const pgError = error as PostgresError;
  const code = typeof pgError?.code === 'string' ? pgError.code : undefined;
  const message = pgError instanceof Error ? pgError.message : String(error);
  return new UpgradeLabError(
    `PostgreSQL query failed${code ? ` (SQLSTATE ${code})` : ''}: ${message}`,
    {
      code: 'DATABASE_QUERY_FAILED',
      details: {
        ...(code ? { sqlState: code } : {}),
        ...(pgError?.detail ? { detail: pgError.detail } : {}),
        ...(pgError?.hint ? { hint: pgError.hint } : {}),
      },
      cause: error,
    },
  );
}

class PostgresConnection implements DatabaseConnection {
  private closed = false;

  constructor(
    private readonly client: Client,
    private readonly logger: StructuredLogger,
    private readonly defaultOptions: QueryOptions,
  ) {}

  async execute(query: string, options: Partial<QueryOptions> = {}): Promise<QueryResult> {
    if (this.closed) {
      throw new UpgradeLabError('PostgreSQL connection is already closed.', {
        code: 'INTERNAL_ERROR',
      });
    }
    const statement = validateReadOnlySql(query);
    const maxRows = options.maxRows ?? this.defaultOptions.maxRows;
    const statementTimeoutMs = options.statementTimeoutMs ?? this.defaultOptions.statementTimeoutMs;
    const probe = prepareProbe(statement, maxRows);
    const startedMs = Date.now();
    let inTransaction = false;
    try {
      await this.client.query('BEGIN TRANSACTION READ ONLY');
      inTransaction = true;
      await this.client.query(`SELECT set_config('statement_timeout', $1, true)`, [
        `${statementTimeoutMs}ms`,
      ]);
      const result = await this.client.query({
        text: probe.text,
        rowMode: 'array',
      });
      await this.client.query('ROLLBACK');
      inTransaction = false;
      const columns = result.fields.map((field) => field.name);
      const limitedRows = result.rows.slice(0, maxRows);
      const rows: SqlRow[] = limitedRows.map((row) => {
        const record: Record<string, SqlScalar> = {};
        columns.forEach((column, index) => {
          record[column] = normalizeSqlValue(row[index]);
        });
        return record;
      });
      const values = limitedRows.map((row) => normalizeSqlValue(row[0]));
      const durationMs = Date.now() - startedMs;
      this.logger.debug('Read-only SQL query completed.', {
        durationMs,
        rowCount: rows.length,
        truncated: probe.capped && result.rows.length > maxRows,
      });
      return {
        columns,
        rows,
        rowCount: rows.length,
        values,
        truncated: probe.capped && result.rows.length > maxRows,
        durationMs,
        executedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (inTransaction) {
        try {
          await this.client.query('ROLLBACK');
        } catch {
          // The connection is already unusable; dispose() will close it.
        }
      }
      throw translateQueryError(error);
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.client.end();
    } catch (error) {
      this.logger.debug('Error while closing PostgreSQL connection.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export interface PostgresAdapterOptions {
  /** Optional SSL mode override, never inferred from configuration files. */
  readonly applicationName?: string;
}

/**
 * PostgreSQL adapter.
 *
 * Every verification query runs inside a `READ ONLY` transaction with a
 * statement timeout, and is validated as a single read-only statement first.
 * Writes are therefore rejected by PostgreSQL itself, not only by UpgradeLab.
 */
export class PostgresAdapter implements DatabaseAdapter {
  readonly id = 'postgres';
  readonly description = 'PostgreSQL (read-only verification sessions)';

  constructor(private readonly options: PostgresAdapterOptions = {}) {}

  validateReadOnlyQuery(query: string): void {
    validateReadOnlySql(query);
  }

  async connect(
    target: DatabaseTarget,
    options: QueryOptions & { connectionTimeoutMs: number; logger: StructuredLogger },
  ): Promise<DatabaseConnection> {
    if (target.adapter !== this.id) {
      throw new UpgradeLabError(`PostgresAdapter cannot connect to adapter "${target.adapter}".`, {
        code: 'INTERNAL_ERROR',
      });
    }
    const client = new Client({
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.user,
      password: target.password,
      ssl: target.ssl ? { rejectUnauthorized: true } : undefined,
      connectionTimeoutMillis: options.connectionTimeoutMs,
      application_name: this.options.applicationName ?? 'upgradelab',
    });

    try {
      await client.connect();
      await client.query(`SELECT set_config('default_transaction_read_only', 'on', false)`);
      await client.query(`SELECT set_config('statement_timeout', $1, false)`, [
        `${options.statementTimeoutMs}ms`,
      ]);
      await client.query(`SELECT set_config('idle_in_transaction_session_timeout', $1, false)`, [
        `${SESSION_IDLE_TIMEOUT_MS}ms`,
      ]);
    } catch (error) {
      try {
        await client.end();
      } catch {
        // Ignore cleanup errors for a connection that never succeeded.
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UpgradeLabError(
        `Unable to connect to PostgreSQL at ${target.host}:${target.port}: ${message}`,
        {
          code: 'DATABASE_CONNECTION_FAILED',
          details: {
            host: target.host,
            port: target.port,
            database: target.database,
            user: target.user,
          },
          cause: error,
        },
      );
    }

    options.logger.debug('Opened read-only PostgreSQL session.', {
      host: target.host,
      port: target.port,
      database: target.database,
    });

    return new PostgresConnection(client, options.logger, {
      statementTimeoutMs: options.statementTimeoutMs,
      maxRows: options.maxRows,
    });
  }
}

export function createPostgresAdapter(options: PostgresAdapterOptions = {}): PostgresAdapter {
  return new PostgresAdapter(options);
}
