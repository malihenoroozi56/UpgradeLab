import { describe, expect, it, vi } from 'vitest';
import { ExecutionTimeline } from '@upgradelab/core';
import { UpgradeLabError } from '@upgradelab/contracts';

describe('execution timeline', () => {
  it('records a complete successful lifecycle in order', () => {
    const timeline = new ExecutionTimeline();
    timeline.transition('preflight', 'validate');
    timeline.transition('environment-created', 'created');
    timeline.transition('source-started', 'source ready');
    timeline.transition('seeded', 'seeded');
    timeline.transition('baseline-captured', 'baseline');
    timeline.transition('hop-started', 'upgrade');
    timeline.transition('target-started', 'target ready');
    timeline.transition('verified', 'verified');
    timeline.transition('cleaned-up', 'cleaned');
    timeline.transition('completed', 'done');
    expect(timeline.phase).toBe('completed');
    expect(timeline.events.map((event) => event.phase)).toEqual([
      'preflight',
      'environment-created',
      'source-started',
      'seeded',
      'baseline-captured',
      'hop-started',
      'target-started',
      'verified',
      'cleaned-up',
      'completed',
    ]);
    expect(timeline.events[0]?.sequence).toBe(1);
    expect(timeline.events.at(-1)?.sequence).toBe(10);
  });

  it('rejects illegal transitions instead of silently skipping a phase', () => {
    const timeline = new ExecutionTimeline();
    expect(() => timeline.transition('source-started', 'skipped checks')).toThrowError(
      UpgradeLabError,
    );
    try {
      timeline.transition('verified', 'nope');
    } catch (error) {
      expect((error as UpgradeLabError).code).toBe('INTERNAL_ERROR');
    }
    expect(timeline.phase).toBe('created');
  });

  it('supports failure and cancellation paths with cleanup', () => {
    const failed = new ExecutionTimeline();
    failed.transition('preflight', 'start');
    failed.transition('failed', 'boom');
    failed.transition('cleaned-up', 'cleanup');
    failed.transition('failed', 'finished');
    expect(failed.phase).toBe('failed');

    const cancelled = new ExecutionTimeline();
    cancelled.transition('cancelled', 'cancelled');
    cancelled.transition('cleaned-up', 'cleanup');
    cancelled.transition('cancelled', 'finished');
    expect(cancelled.phase).toBe('cancelled');
  });

  it('notifies listeners for every event', () => {
    const listener = vi.fn();
    const timeline = new ExecutionTimeline(listener);
    timeline.transition('preflight', 'hello');
    timeline.warning('careful');
    timeline.check('checked', { id: 'x' });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls[1]?.[0]).toMatchObject({ type: 'warning', message: 'careful' });
  });

  it('rejects transitions from a terminal phase', () => {
    const timeline = new ExecutionTimeline();
    timeline.transition('preflight', 'start');
    timeline.transition('failed', 'boom');
    timeline.transition('cleaned-up', 'cleanup');
    timeline.transition('completed', 'done');
    expect(() => timeline.info === undefined).not.toThrow();
    expect(() => timeline.transition('preflight', 'again')).toThrow();
  });
});
