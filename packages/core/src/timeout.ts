import { UpgradeLabError, isAbortError } from '@upgradelab/contracts';

export interface Deadline {
  readonly signal: AbortSignal;
  /** True when the deadline elapsed (as opposed to a parent cancellation). */
  readonly timedOut: () => boolean;
  readonly cancelled: () => boolean;
  readonly dispose: () => void;
}

/**
 * Combines a parent cancellation signal with a hard deadline.
 *
 * The returned signal aborts with an UpgradeLabError cause, so providers can
 * distinguish "user pressed Ctrl+C" from "scenario timed out" without parsing
 * messages.
 */
export function createDeadline(timeoutMs: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new UpgradeLabError(`Operation timed out after ${timeoutMs} ms.`, {
        code: 'EXECUTION_TIMEOUT',
        details: { timeoutMs },
      }),
    );
  }, timeoutMs);
  // Long timers must not keep the process alive on their own.
  timer.unref?.();

  const onParentAbort = (): void => {
    controller.abort(
      parent?.reason ??
        new UpgradeLabError('Execution cancelled by the caller.', {
          code: 'EXECUTION_CANCELLED',
        }),
    );
  };
  if (parent) {
    if (parent.aborted) {
      onParentAbort();
    } else {
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancelled: () => Boolean(parent?.aborted) && !timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** Throws the abort reason when the signal is already aborted. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    throw new UpgradeLabError('Execution cancelled.', { code: 'EXECUTION_CANCELLED' });
  }
}

/** Normalizes an aborted operation into a typed cancellation error. */
export function toCancellationError(signal: AbortSignal): UpgradeLabError {
  const reason: unknown = signal.reason;
  if (reason instanceof UpgradeLabError) {
    return reason;
  }
  return new UpgradeLabError('Execution cancelled.', {
    code: 'EXECUTION_CANCELLED',
    ...(reason === undefined ? {} : { details: { reason: String(reason) } }),
  });
}

/**
 * Runs an async operation with an AbortSignal-aware timeout.
 *
 * The operation must honour the provided signal; this helper additionally
 * rejects if the operation settles after the deadline, ensuring a hung promise
 * can never stall a run.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
  label = 'operation',
): Promise<T> {
  const deadline = createDeadline(timeoutMs, parent);
  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        reject(
          deadline.timedOut()
            ? new UpgradeLabError(`${label} timed out after ${timeoutMs} ms.`, {
                code: 'EXECUTION_TIMEOUT',
                details: { label, timeoutMs },
              })
            : toCancellationError(deadline.signal),
        );
      };
      if (deadline.signal.aborted) {
        onAbort();
        return;
      }
      deadline.signal.addEventListener('abort', onAbort, { once: true });
      operation(deadline.signal).then(
        (value) => {
          deadline.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          deadline.signal.removeEventListener('abort', onAbort);
          reject(isAbortError(error) ? toCancellationError(deadline.signal) : error);
        },
      );
    });
  } finally {
    deadline.dispose();
  }
}
