import { describe, expect, it } from 'vitest';
import {
  aggregateRunStatus,
  aggregateScenarioStatus,
  countChecks,
  type CheckResult,
} from '@upgradelab/contracts';

function check(id: string, status: CheckResult['status'], required = true): CheckResult {
  return {
    id,
    kind: 'assertion',
    type: 'http',
    required,
    status,
    startedAt: '2024-01-01T00:00:00.000Z',
    finishedAt: '2024-01-01T00:00:01.000Z',
    durationMs: 1000,
    evidenceIds: [],
  };
}

describe('verdict aggregation', () => {
  it('passes only when every required check passed', () => {
    expect(
      aggregateScenarioStatus({
        checks: [check('a', 'PASSED'), check('b', 'PASSED', false)],
        cancelled: false,
      }),
    ).toBe('PASSED');
  });

  it('fails when a required check failed', () => {
    expect(
      aggregateScenarioStatus({
        checks: [check('a', 'PASSED'), check('b', 'FAILED')],
        cancelled: false,
      }),
    ).toBe('FAILED');
  });

  it('ignores failing optional checks', () => {
    expect(
      aggregateScenarioStatus({
        checks: [check('a', 'PASSED'), check('b', 'FAILED', false)],
        cancelled: false,
      }),
    ).toBe('PASSED');
  });

  it('is inconclusive when a required check was skipped or errored', () => {
    expect(aggregateScenarioStatus({ checks: [check('a', 'SKIPPED')], cancelled: false })).toBe(
      'INCONCLUSIVE',
    );
    expect(aggregateScenarioStatus({ checks: [check('a', 'ERROR')], cancelled: false })).toBe(
      'INCONCLUSIVE',
    );
  });

  it('is inconclusive when nothing was evaluated', () => {
    expect(aggregateScenarioStatus({ checks: [], cancelled: false })).toBe('INCONCLUSIVE');
    expect(
      aggregateScenarioStatus({ checks: [check('optional', 'PASSED', false)], cancelled: false }),
    ).toBe('INCONCLUSIVE');
  });

  it('is inconclusive on orchestration errors unless a check failed', () => {
    const error = new Error('boom');
    expect(
      aggregateScenarioStatus({ checks: [check('a', 'PASSED')], cancelled: false, error }),
    ).toBe('INCONCLUSIVE');
    expect(
      aggregateScenarioStatus({ checks: [check('a', 'FAILED')], cancelled: false, error }),
    ).toBe('FAILED');
  });

  it('cancellation always wins', () => {
    expect(aggregateScenarioStatus({ checks: [check('a', 'PASSED')], cancelled: true })).toBe(
      'CANCELLED',
    );
  });
});

describe('run aggregation', () => {
  it('fails the run if any scenario failed', () => {
    expect(aggregateRunStatus(['PASSED', 'FAILED'])).toBe('FAILED');
    expect(aggregateRunStatus(['PASSED', 'INCONCLUSIVE'])).toBe('INCONCLUSIVE');
    expect(aggregateRunStatus(['PASSED', 'PASSED'])).toBe('PASSED');
    expect(aggregateRunStatus([])).toBe('INCONCLUSIVE');
    expect(aggregateRunStatus(['CANCELLED'])).toBe('CANCELLED');
    expect(aggregateRunStatus(['CANCELLED', 'PASSED'])).toBe('FAILED');
  });

  it('counts check statuses', () => {
    const counts = countChecks([
      check('a', 'PASSED'),
      check('b', 'FAILED'),
      check('c', 'SKIPPED'),
      check('d', 'ERROR'),
    ]);
    expect(counts).toEqual({ total: 4, passed: 1, failed: 1, skipped: 1, errored: 1 });
  });
});
