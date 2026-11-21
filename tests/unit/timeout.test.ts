import { describe, expect, it } from 'vitest';
import { UpgradeLabError } from '@upgradelab/contracts';
import { createDeadline, throwIfAborted, withTimeout } from '@upgradelab/core';

describe('deadlines and timeouts', () => {
  it('resolves a fast operation and disposes cleanly', async () => {
    const result = await withTimeout(async () => 'done', 1_000);
    expect(result).toBe('done');
  });

  it('rejects with EXECUTION_TIMEOUT when the budget elapses', async () => {
    await expect(
      withTimeout(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        30,
        undefined,
        'slow operation',
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT' });
  });

  it('propagates parent cancellation rather than reporting a timeout', async () => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new UpgradeLabError('cancelled', { code: 'EXECUTION_CANCELLED' })),
      20,
    );
    timer.unref();
    try {
      await withTimeout(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        5_000,
        controller.signal,
        'cancellable',
      );
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as UpgradeLabError).code).toBe('EXECUTION_CANCELLED');
    }
  });

  it('distinguishes timeout from cancellation on the deadline object', () => {
    const deadline = createDeadline(10);
    expect(deadline.timedOut()).toBe(false);
    deadline.dispose();
    const parent = new AbortController();
    const child = createDeadline(5_000, parent.signal);
    parent.abort();
    expect(child.cancelled()).toBe(true);
    expect(child.timedOut()).toBe(false);
    child.dispose();
  });

  it('throws an aborted signal reason', () => {
    const controller = new AbortController();
    const error = new UpgradeLabError('stop', { code: 'EXECUTION_CANCELLED' });
    controller.abort(error);
    expect(() => throwIfAborted(controller.signal)).toThrow(error);
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });
});
