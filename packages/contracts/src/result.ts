import type { CheckStatus, CheckResult, RunStatus } from './execution.js';

export interface StatusAggregationInput {
  readonly checks: readonly CheckResult[];
  readonly cancelled: boolean;
  readonly error?: unknown;
}

/**
 * Aggregates check results into a scenario status.
 *
 * Rules (documented in docs/concepts/verdicts.md):
 * - Cancellation always wins: partial evidence never yields PASSED.
 * - A failed required check yields FAILED.
 * - An errored or skipped required check yields INCONCLUSIVE, never PASSED.
 * - Only a run where every required check was evaluated and passed is PASSED.
 * - No checks at all is INCONCLUSIVE: a successful container start is not proof.
 * - Fatal orchestration errors are INCONCLUSIVE unless a check already failed.
 */
export function aggregateScenarioStatus(input: StatusAggregationInput): RunStatus {
  if (input.cancelled) {
    return 'CANCELLED';
  }
  const required = input.checks.filter((check) => check.required);
  const failed = required.some((check) => check.status === 'FAILED');
  if (failed) {
    return 'FAILED';
  }
  if (input.error !== undefined) {
    return 'INCONCLUSIVE';
  }
  if (required.length === 0) {
    return 'INCONCLUSIVE';
  }
  const incomplete = required.some(
    (check) => check.status === 'ERROR' || check.status === 'SKIPPED',
  );
  if (incomplete) {
    return 'INCONCLUSIVE';
  }
  return 'PASSED';
}

/** Aggregates scenario statuses into the run status. */
export function aggregateRunStatus(statuses: readonly RunStatus[]): RunStatus {
  if (statuses.length === 0) {
    return 'INCONCLUSIVE';
  }
  if (statuses.includes('CANCELLED')) {
    return statuses.every((status) => status === 'CANCELLED') ? 'CANCELLED' : 'FAILED';
  }
  if (statuses.includes('FAILED')) {
    return 'FAILED';
  }
  if (statuses.includes('INCONCLUSIVE')) {
    return 'INCONCLUSIVE';
  }
  return 'PASSED';
}

export function isCheckSuccessful(status: CheckStatus): boolean {
  return status === 'PASSED';
}

export function countChecks(checks: readonly CheckResult[]): {
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  total: number;
} {
  return {
    passed: checks.filter((check) => check.status === 'PASSED').length,
    failed: checks.filter((check) => check.status === 'FAILED').length,
    skipped: checks.filter((check) => check.status === 'SKIPPED').length,
    errored: checks.filter((check) => check.status === 'ERROR').length,
    total: checks.length,
  };
}
