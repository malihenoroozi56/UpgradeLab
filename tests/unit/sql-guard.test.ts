import { describe, expect, it } from 'vitest';
import { UpgradeLabError } from '@upgradelab/contracts';
import { prepareProbe, stripSqlNoise, validateReadOnlySql } from '@upgradelab/database-postgres';

const allowed = [
  'SELECT COUNT(*) FROM users',
  'WITH recent AS (SELECT * FROM users) SELECT * FROM recent',
  'SELECT 1;',
  "SELECT 'delete from users' AS text",
  '-- comment\nSELECT 1',
  '/* block */ SELECT 1',
  'SHOW server_version',
  'EXPLAIN SELECT 1',
  'VALUES (1)',
  'TABLE users',
];

const rejected: { query: string; reason?: string }[] = [
  { query: 'DELETE FROM users' },
  { query: 'UPDATE users SET name = 1' },
  { query: 'INSERT INTO users VALUES (1)' },
  { query: 'DROP TABLE users' },
  { query: 'SELECT 1; DELETE FROM users' },
  { query: 'SELECT * FROM users FOR UPDATE' },
  { query: 'SELECT pg_terminate_backend(1)' },
  { query: 'SELECT pg_read_file($1)' },
  { query: 'SELECT set_config($1, $2, true)' },
  { query: 'SELECT * INTO backup FROM users' },
  { query: 'SET statement_timeout = 0' },
  { query: 'BEGIN' },
  { query: 'SELECT $$; DROP TABLE users; $$' },
  { query: '' },
  { query: '   ' },
  { query: '/* only a comment */' },
];

describe('read-only SQL guard', () => {
  it.each(allowed)('accepts %s', (query) => {
    expect(() => validateReadOnlySql(query)).not.toThrow();
  });

  it.each(rejected)('rejects $query', ({ query }) => {
    try {
      validateReadOnlySql(query);
      throw new Error(`expected rejection for: ${query}`);
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeLabError);
      expect((error as UpgradeLabError).code).toBe('ASSERTION_UNSAFE_QUERY');
    }
  });

  it('strips literals, quoted identifiers and comments from analysis', () => {
    const stripped = stripSqlNoise('SELECT \'a;b\' AS "weird name" -- trailing\nFROM t');
    expect(stripped).not.toContain('a;b');
    expect(stripped).not.toContain('weird name');
    expect(stripped).not.toContain('trailing');
    expect(stripped).toContain('SELECT');
    expect(stripped).toContain('FROM t');
  });

  it('does not treat semicolons inside strings as statement separators', () => {
    expect(() => validateReadOnlySql("SELECT 'a;b'")).not.toThrow();
  });

  it('removes a trailing semicolon from the executable statement', () => {
    expect(validateReadOnlySql('SELECT 1 ; ')).toBe('SELECT 1');
  });

  it('wraps SELECT statements in a bounded probe', () => {
    const probe = prepareProbe('SELECT * FROM users', 10);
    expect(probe.capped).toBe(true);
    expect(probe.text).toContain('LIMIT 11');
    expect(probe.text).toContain('upgradelab_probe');
  });

  it('does not wrap statements that cannot be subqueries', () => {
    const probe = prepareProbe('SHOW server_version', 10);
    expect(probe.capped).toBe(false);
    expect(probe.text).toBe('SHOW server_version');
  });

  it('never allows modifying CTEs through the guard alone', () => {
    // PostgreSQL's READ ONLY transaction is the authoritative control; the
    // guard additionally rejects data-modifying keywords.
    expect(() =>
      validateReadOnlySql('WITH removed AS (DELETE FROM users RETURNING id) SELECT * FROM removed'),
    ).toThrow();
  });
});
