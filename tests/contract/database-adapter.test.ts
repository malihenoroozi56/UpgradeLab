import { describe, expect, it } from 'vitest';
import type { DatabaseTarget, StructuredLogger } from '@upgradelab/contracts';
import { PostgresAdapter, validateReadOnlySql } from '@upgradelab/database-postgres';

const logger: StructuredLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

const liveUrl = process.env['UPGRADELAB_TEST_POSTGRES_URL'];

function targetFromUrl(value: string): DatabaseTarget {
  const url = new URL(value);
  return {
    adapter: 'postgres',
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
    user: decodeURIComponent(url.username) || 'postgres',
    password: decodeURIComponent(url.password),
    ssl: url.searchParams.get('sslmode') === 'require',
  };
}

describe('database adapter contract (offline)', () => {
  it('is identifiable and declares PostgreSQL', () => {
    const adapter = new PostgresAdapter();
    expect(adapter.id).toBe('postgres');
    expect(adapter.description).toContain('PostgreSQL');
  });

  it('delegates read-only validation to the SQL guard', () => {
    const adapter = new PostgresAdapter();
    expect(() => adapter.validateReadOnlyQuery('SELECT 1')).not.toThrow();
    expect(() => adapter.validateReadOnlyQuery('DELETE FROM users')).toThrow();
    expect(() => validateReadOnlySql('DELETE FROM users')).toThrow();
  });

  it('refuses a target that belongs to another adapter', async () => {
    const adapter = new PostgresAdapter();
    await expect(
      adapter.connect(
        { ...targetFromUrl('postgres://user:pass@127.0.0.1:5432/db'), adapter: 'mysql' },
        {
          connectionTimeoutMs: 1_000,
          statementTimeoutMs: 1_000,
          maxRows: 10,
          logger,
        },
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

if (liveUrl) {
  describe('database adapter contract (live PostgreSQL)', () => {
    it('runs read-only queries and caps rows', async () => {
      const adapter = new PostgresAdapter({ applicationName: 'upgradelab-contract-test' });
      const connection = await adapter.connect(targetFromUrl(liveUrl), {
        connectionTimeoutMs: 5_000,
        statementTimeoutMs: 5_000,
        maxRows: 2,
        logger,
      });
      try {
        const result = await connection.execute('SELECT 1 AS value');
        expect(result.columns).toEqual(['value']);
        expect(result.values).toEqual([1]);
        expect(result.rowCount).toBe(1);

        const capped = await connection.execute('SELECT generate_series(1, 10) AS value');
        expect(capped.rowCount).toBe(2);
        expect(capped.truncated).toBe(true);

        await expect(
          connection.execute('DROP TABLE IF EXISTS should_not_exist'),
        ).rejects.toMatchObject({ code: 'ASSERTION_UNSAFE_QUERY' });
      } finally {
        await connection.dispose();
      }
    });
  });
} else {
  describe('database adapter contract (live PostgreSQL)', () => {
    it.skip('NOT RUN: set UPGRADELAB_TEST_POSTGRES_URL to exercise a live database', () => {
      // Deliberately empty: this records the gap without claiming coverage.
    });
  });
}
