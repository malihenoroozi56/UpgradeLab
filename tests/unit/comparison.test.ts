import { describe, expect, it } from 'vitest';
import type { QueryResult, SqlRow, SqlScalar } from '@upgradelab/contracts';
import { UpgradeLabError } from '@upgradelab/contracts';
import { compareSqlResult, comparableValue, type SqlBaseline } from '@upgradelab/assertion-engine';

function result(values: SqlScalar[], rows?: SqlRow[]): QueryResult {
  return {
    columns: ['value'],
    rows: rows ?? values.map((value) => ({ value })),
    rowCount: (rows ?? values).length,
    values,
    truncated: false,
    durationMs: 1,
    executedAt: '2024-01-01T00:00:00.000Z',
  };
}

function baseline(values: SqlScalar[]): SqlBaseline {
  return {
    columns: ['value'],
    rows: values.map((value) => ({ value })),
    values,
    rowCount: values.length,
    capturedAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('SQL comparison strategies', () => {
  it('extracts single or multiple comparable values', () => {
    expect(comparableValue([3])).toBe(3);
    expect(comparableValue([1, 2])).toEqual([1, 2]);
    expect(comparableValue([])).toBeUndefined();
  });

  it('compares with equal', () => {
    expect(
      compareSqlResult({ comparison: 'equal', expected: 3, current: result([3]) }).passed,
    ).toBe(true);
    const mismatch = compareSqlResult({ comparison: 'equal', expected: 3, current: result([2]) });
    expect(mismatch.passed).toBe(false);
    expect(mismatch.message).toContain('Expected 3, got 2');
  });

  it('allows numeric tolerance for equal', () => {
    const outcome = compareSqlResult({
      comparison: 'equal',
      expected: 100.5,
      tolerance: 1,
      current: result([100.2]),
    });
    expect(outcome.passed).toBe(true);
  });

  it('compares against the pre-upgrade baseline', () => {
    const unchanged = compareSqlResult({
      comparison: 'equal-before-after',
      expected: undefined,
      baseline: baseline([3]),
      current: result([3]),
    });
    expect(unchanged.passed).toBe(true);
    expect(unchanged.message).toContain('unchanged');

    const changed = compareSqlResult({
      comparison: 'equal-before-after',
      expected: undefined,
      baseline: baseline([3]),
      current: result([2]),
    });
    expect(changed.passed).toBe(false);
    expect(changed.message).toContain('before 3, after 2');
  });

  it('fails safely when no baseline is available', () => {
    const outcome = compareSqlResult({
      comparison: 'equal-before-after',
      expected: undefined,
      current: result([3]),
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.message).toContain('No pre-upgrade baseline');
  });

  it('compares numeric baselines with tolerance', () => {
    const outcome = compareSqlResult({
      comparison: 'numeric-equal-before-after',
      expected: undefined,
      tolerance: 0.01,
      baseline: baseline([1000]),
      current: result([1000.005]),
    });
    expect(outcome.passed).toBe(true);
  });

  it('requires numeric values for numeric comparisons', () => {
    const outcome = compareSqlResult({
      comparison: 'numeric-equal-before-after',
      expected: undefined,
      baseline: baseline(['not-a-number']),
      current: result(['also-not']),
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.message).toContain('requires numeric values');
  });

  it('supports empty and non-empty row checks', () => {
    expect(
      compareSqlResult({ comparison: 'non-empty', expected: undefined, current: result([3]) })
        .passed,
    ).toBe(true);
    expect(
      compareSqlResult({ comparison: 'non-empty', expected: undefined, current: result([], []) })
        .passed,
    ).toBe(false);
    expect(
      compareSqlResult({ comparison: 'empty', expected: undefined, current: result([], []) })
        .passed,
    ).toBe(true);
  });

  it('supports at-least and at-most', () => {
    expect(
      compareSqlResult({ comparison: 'at-least', expected: 3, current: result([3]) }).passed,
    ).toBe(true);
    expect(
      compareSqlResult({ comparison: 'at-least', expected: 4, current: result([3]) }).passed,
    ).toBe(false);
    expect(
      compareSqlResult({ comparison: 'at-most', expected: 3, current: result([3]) }).passed,
    ).toBe(true);
    expect(
      compareSqlResult({ comparison: 'at-most', expected: 2, current: result([3]) }).passed,
    ).toBe(false);
  });

  it('supports regular expression matching', () => {
    expect(
      compareSqlResult({
        comparison: 'matches',
        expected: '^v2\\.',
        current: result(['v2.1.0']),
      }).passed,
    ).toBe(true);
    expect(
      compareSqlResult({
        comparison: 'matches',
        expected: '^v3\\.',
        current: result(['v2.1.0']),
      }).passed,
    ).toBe(false);
  });

  it('rejects invalid regular expressions with an assertion error', () => {
    expect(() =>
      compareSqlResult({
        comparison: 'matches',
        expected: '[unclosed',
        current: result(['x']),
      }),
    ).toThrowError(UpgradeLabError);
  });
});
