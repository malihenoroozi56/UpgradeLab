import type { QueryResult, SqlComparison, SqlRow, SqlScalar } from '@upgradelab/contracts';
import { UpgradeLabError } from '@upgradelab/contracts';
import { compileRegex, deepEqual, formatValue } from './support.js';

export interface SqlBaseline {
  readonly columns: readonly string[];
  readonly rows: readonly SqlRow[];
  readonly values: readonly SqlScalar[];
  readonly rowCount: number;
  readonly capturedAt: string;
}

export interface SqlComparisonInput {
  readonly comparison: SqlComparison;
  readonly expected: unknown;
  readonly tolerance?: number;
  readonly baseline?: unknown;
  readonly current: QueryResult;
}

export interface SqlComparisonOutcome {
  readonly passed: boolean;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly baseline?: unknown;
}

/** Extracts the comparable value from a query result. */
export function comparableValue(values: readonly SqlScalar[]): SqlScalar | SqlScalar[] | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.length === 1 ? values[0] : [...values];
}

function isSqlBaseline(value: unknown): value is SqlBaseline {
  return (
    value !== null &&
    typeof value === 'object' &&
    'values' in value &&
    Array.isArray((value as SqlBaseline).values)
  );
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function numericComparison(
  current: unknown,
  reference: unknown,
  tolerance: number,
  label: string,
): SqlComparisonOutcome {
  const a = numeric(current);
  const b = numeric(reference);
  if (a === undefined || b === undefined) {
    return {
      passed: false,
      message: `${label} requires numeric values; received ${formatValue(current)} and ${formatValue(reference)}.`,
      expected: reference,
      actual: current,
    };
  }
  const passed = Math.abs(a - b) <= tolerance;
  return {
    passed,
    message: passed
      ? `${label} satisfied: ${formatValue(current)} is within ${tolerance} of ${formatValue(reference)}.`
      : `${label} violated: expected ${formatValue(reference)} ± ${tolerance}, got ${formatValue(current)}.`,
    expected: reference,
    actual: current,
  };
}

/**
 * Applies a declarative comparison strategy to a SQL result.
 *
 * The strategies are documented in docs/configuration/assertions.md; they are
 * intentionally simple and never evaluate user-provided code.
 */
export function compareSqlResult(input: SqlComparisonInput): SqlComparisonOutcome {
  const { current, comparison, expected, tolerance = 0 } = input;
  const actual = comparableValue(current.values);
  const rowCount = current.rows.length;

  switch (comparison) {
    case 'non-empty': {
      const passed = rowCount > 0;
      return {
        passed,
        message: passed
          ? `Query returned ${rowCount} row(s).`
          : 'Query returned no rows, but a non-empty result was required.',
        actual: { rowCount },
      };
    }
    case 'empty': {
      const passed = rowCount === 0;
      return {
        passed,
        message: passed
          ? 'Query returned no rows as expected.'
          : `Query returned ${rowCount} row(s), but an empty result was required.`,
        actual: { rowCount },
      };
    }
    case 'matches': {
      if (typeof expected !== 'string') {
        throw new UpgradeLabError(
          '"matches" requires a regular expression string as expected value.',
          {
            code: 'ASSERTION_ERROR',
          },
        );
      }
      const regex = compileRegex(expected, 'comparison.expected');
      const passed = regex.test(formatValue(actual));
      return {
        passed,
        message: passed
          ? `Value ${formatValue(actual)} matches /${expected}/.`
          : `Value ${formatValue(actual)} does not match /${expected}/.`,
        expected,
        actual,
      };
    }
    case 'at-least':
    case 'at-most': {
      const a = numeric(actual);
      const b = numeric(expected);
      if (a === undefined || b === undefined) {
        throw new UpgradeLabError(
          `Comparison "${comparison}" requires numeric values; received ${formatValue(actual)} and ${formatValue(expected)}.`,
          { code: 'ASSERTION_ERROR', details: { comparison, actual, expected } },
        );
      }
      const passed = comparison === 'at-least' ? a >= b : a <= b;
      return {
        passed,
        message: passed
          ? `${a} satisfies ${comparison} ${b}.`
          : `${a} violates ${comparison} ${b}.`,
        expected,
        actual,
      };
    }
    case 'equal': {
      if (tolerance > 0) {
        return numericComparison(actual, expected, tolerance, 'Numeric equality');
      }
      const passed = deepEqual(actual, expected);
      return {
        passed,
        message: passed
          ? `Value equals ${formatValue(expected)}.`
          : `Expected ${formatValue(expected)}, got ${formatValue(actual)}.`,
        expected,
        actual,
      };
    }
    case 'equal-before-after': {
      if (!isSqlBaseline(input.baseline)) {
        return {
          passed: false,
          message: 'No pre-upgrade baseline is available for this invariant.',
          actual,
        };
      }
      const baselineValue =
        input.baseline.values.length === 1 ? input.baseline.values[0] : [...input.baseline.values];
      const passed = deepEqual(actual, baselineValue);
      return {
        passed,
        message: passed
          ? `Value is unchanged from the pre-upgrade baseline (${formatValue(actual)}).`
          : `Value changed during the upgrade: before ${formatValue(baselineValue)}, after ${formatValue(actual)}.`,
        expected: baselineValue,
        actual,
        baseline: baselineValue,
      };
    }
    case 'numeric-equal-before-after': {
      if (!isSqlBaseline(input.baseline)) {
        return {
          passed: false,
          message: 'No pre-upgrade baseline is available for this numeric invariant.',
          actual,
        };
      }
      const baselineValue =
        input.baseline.values.length === 1 ? input.baseline.values[0] : [...input.baseline.values];
      return {
        ...numericComparison(actual, baselineValue, tolerance, 'Numeric equality with baseline'),
        baseline: baselineValue,
      };
    }
    default: {
      const exhaustive: never = comparison;
      throw new UpgradeLabError(`Unsupported SQL comparison "${String(exhaustive)}".`, {
        code: 'ASSERTION_ERROR',
      });
    }
  }
}
