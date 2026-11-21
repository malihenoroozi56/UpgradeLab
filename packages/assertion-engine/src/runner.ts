import {
  UpgradeLabError,
  serializeError,
  type AssertionConfig,
  type AssertionExecutionResult,
  type AssertionHandlerRegistration,
  type BaselineCaptureResult,
  type CheckResult,
  type CheckRunner,
  type CheckRunResult,
  type CheckContext,
  type CheckStatus,
  type InvariantConfig,
  type InvariantHandler,
} from '@upgradelab/contracts';
import { builtinAssertionHandlers, sqlAssertionHandler, sqlInvariantHandler } from './handlers.js';

export interface CheckRunnerOptions {
  /** Additional assertion handlers, usually supplied by plugins. */
  readonly assertionHandlers?: readonly AssertionHandlerRegistration[];
  /** Additional invariant handlers. SQL is always available. */
  readonly invariantHandlers?: readonly InvariantHandler[];
}

export interface CheckRunnerInstance extends CheckRunner {
  readonly assertionTypes: readonly string[];
  readonly invariantTypes: readonly string[];
}

function validateBuiltinSqlAssertion(assertion: AssertionConfig): void {
  if (assertion.type !== 'sql' || 'params' in assertion) {
    return;
  }
  if (
    assertion.comparison === 'equal-before-after' ||
    assertion.comparison === 'numeric-equal-before-after'
  ) {
    throw new UpgradeLabError(
      `SQL assertion "${assertion.id}" uses comparison "${assertion.comparison}", which is only available for invariants.`,
      {
        code: 'CONFIG_VALIDATION_ERROR',
        details: { assertion: assertion.id, comparison: assertion.comparison },
        hint: 'Move the check to "invariants" so a pre-upgrade baseline is captured.',
      },
    );
  }
}

/** Runs one check with a per-check timeout that never cancels the scenario. */
async function withCheckTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal,
  label: string,
): Promise<T> {
  if (parent.aborted) {
    throw parent.reason instanceof Error
      ? parent.reason
      : new UpgradeLabError('Execution cancelled.', { code: 'EXECUTION_CANCELLED' });
  }
  const controller = new AbortController();
  const timeoutError = new UpgradeLabError(`${label} timed out after ${timeoutMs} ms.`, {
    code: 'EXECUTION_TIMEOUT',
    details: { label, timeoutMs },
  });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  timer.unref?.();
  const signal = AbortSignal.any([parent, controller.signal]);

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : timeoutError);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation(signal).then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

interface CheckOutcome {
  readonly status: CheckStatus;
  readonly outcome?: AssertionExecutionResult;
  readonly error?: unknown;
}

export function createCheckRunner(options: CheckRunnerOptions = {}): CheckRunnerInstance {
  const assertionHandlers = new Map<string, AssertionHandlerRegistration>();
  for (const handler of builtinAssertionHandlers) {
    assertionHandlers.set(handler.type, { handler });
  }
  assertionHandlers.set('sql', {
    handler: sqlAssertionHandler,
    validate: validateBuiltinSqlAssertion,
  });
  for (const registration of options.assertionHandlers ?? []) {
    if (assertionHandlers.has(registration.handler.type)) {
      throw new UpgradeLabError(
        `Assertion type "${registration.handler.type}" is already registered.`,
        {
          code: 'PLUGIN_DUPLICATE',
          details: { type: registration.handler.type },
          hint: 'Plugin assertion types must not override built-in types.',
        },
      );
    }
    assertionHandlers.set(registration.handler.type, registration);
  }

  const invariantHandlers = new Map<string, InvariantHandler>();
  invariantHandlers.set(sqlInvariantHandler.type, sqlInvariantHandler);
  for (const handler of options.invariantHandlers ?? []) {
    if (invariantHandlers.has(handler.type)) {
      throw new UpgradeLabError(`Invariant type "${handler.type}" is already registered.`, {
        code: 'PLUGIN_DUPLICATE',
        details: { type: handler.type },
      });
    }
    invariantHandlers.set(handler.type, handler);
  }

  function buildCheck(params: {
    assertion: { id: string; type: string; description?: string; required: boolean };
    kind: 'assertion' | 'invariant';
    startedAt: string;
    startedMs: number;
    outcome: CheckOutcome;
  }): CheckResult {
    const finishedAt = new Date().toISOString();
    const result = params.outcome.outcome;
    return {
      id: params.assertion.id,
      kind: params.kind,
      type: params.assertion.type,
      ...(params.assertion.description ? { description: params.assertion.description } : {}),
      required: params.assertion.required,
      status: params.outcome.status,
      startedAt: params.startedAt,
      finishedAt,
      durationMs: Date.now() - params.startedMs,
      ...(result?.expected !== undefined ? { expected: result.expected } : {}),
      ...(result?.actual !== undefined ? { actual: result.actual } : {}),
      ...(result?.baseline !== undefined ? { baseline: result.baseline } : {}),
      message: result?.message ?? errorMessage(params.outcome.error),
      evidenceIds: result?.evidenceIds ?? [],
      ...(params.outcome.error !== undefined && params.outcome.status === 'ERROR'
        ? { error: serializeError(params.outcome.error) }
        : {}),
    };
  }

  async function executeAssertion(
    assertion: AssertionConfig,
    context: CheckContext,
  ): Promise<CheckResult> {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const registration = assertionHandlers.get(assertion.type);
    if (!registration) {
      return buildCheck({
        assertion,
        kind: 'assertion',
        startedAt,
        startedMs,
        outcome: {
          status: 'ERROR',
          error: new UpgradeLabError(`Assertion type "${assertion.type}" is not registered.`, {
            code: 'ASSERTION_UNSUPPORTED',
            details: { type: assertion.type },
          }),
        },
      });
    }
    const timeoutMs = assertion.timeoutMs ?? context.defaultTimeoutMs;
    const outcome = await runCheck(
      (signal) =>
        registration.handler.execute(assertion, {
          ...context,
          signal,
        }),
      timeoutMs,
      context.signal,
      `assertion "${assertion.id}"`,
    );
    return buildCheck({ assertion, kind: 'assertion', startedAt, startedMs, outcome });
  }

  async function runCheck(
    operation: (signal: AbortSignal) => Promise<AssertionExecutionResult>,
    timeoutMs: number,
    parent: AbortSignal,
    label: string,
  ): Promise<CheckOutcome> {
    try {
      const outcome = await withCheckTimeout(operation, timeoutMs, parent, label);
      return {
        status: outcome.passed ? 'PASSED' : 'FAILED',
        outcome,
      };
    } catch (error) {
      if (parent.aborted) {
        throw parent.reason instanceof Error
          ? parent.reason
          : new UpgradeLabError('Execution cancelled.', { code: 'EXECUTION_CANCELLED' });
      }
      if (error instanceof UpgradeLabError && error.code === 'EXECUTION_TIMEOUT') {
        return {
          status: 'FAILED',
          outcome: { passed: false, message: error.message },
        };
      }
      if (error instanceof UpgradeLabError && error.code === 'EXECUTION_CANCELLED') {
        throw error;
      }
      return { status: 'ERROR', error };
    }
  }

  const captureFailureKey = '__upgradelabCaptureError';

  return {
    assertionTypes: [...assertionHandlers.keys()].sort(),
    invariantTypes: [...invariantHandlers.keys()].sort(),

    validateAssertions(assertions: readonly AssertionConfig[]): void {
      for (const assertion of assertions) {
        const registration = assertionHandlers.get(assertion.type);
        if (!registration) {
          throw new UpgradeLabError(
            `Assertion type "${assertion.type}" is not supported by this build or by any loaded plugin.`,
            {
              code: 'ASSERTION_UNSUPPORTED',
              details: {
                assertionId: assertion.id,
                type: assertion.type,
                available: [...assertionHandlers.keys()].sort(),
              },
              hint: 'Remove the assertion or load a plugin that registers this type with --plugin.',
            },
          );
        }
        registration.validate?.(assertion);
      }
    },

    async captureBaseline(
      invariants: readonly InvariantConfig[],
      context,
    ): Promise<BaselineCaptureResult> {
      const baselines: Record<string, unknown> = {};
      const checks: CheckResult[] = [];
      for (const invariant of invariants) {
        const startedAt = new Date().toISOString();
        const startedMs = Date.now();
        const handler = invariantHandlers.get(invariant.type);
        if (!handler) {
          checks.push(
            buildCheck({
              assertion: invariant,
              kind: 'invariant',
              startedAt,
              startedMs,
              outcome: {
                status: 'ERROR',
                error: new UpgradeLabError(
                  `Invariant type "${invariant.type}" is not registered.`,
                  { code: 'ASSERTION_UNSUPPORTED' },
                ),
              },
            }),
          );
          continue;
        }
        try {
          const timeoutMs = invariant.timeoutMs ?? context.defaultTimeoutMs;
          const captured = await withCheckTimeout(
            (signal) => handler.capture(invariant, { ...context, signal }),
            timeoutMs,
            context.signal,
            `baseline for invariant "${invariant.id}"`,
          );
          baselines[invariant.id] = captured.baseline;
        } catch (error) {
          if (context.signal.aborted) {
            throw error;
          }
          // The post-upgrade evaluation reports this as one ERROR check, so a
          // failed baseline does not produce duplicate results for the same id.
          baselines[invariant.id] = { [captureFailureKey]: error };
        }
      }
      return { baselines, checks };
    },

    async runAssertions(assertions: readonly AssertionConfig[], context): Promise<CheckRunResult> {
      const checks: CheckResult[] = [];
      for (const assertion of assertions) {
        checks.push(await executeAssertion(assertion, context));
        if (context.signal.aborted) {
          break;
        }
      }
      return { checks };
    },

    async runInvariants(
      invariants: readonly InvariantConfig[],
      baselines: Readonly<Record<string, unknown>>,
      context,
    ): Promise<CheckRunResult> {
      const checks: CheckResult[] = [];
      for (const invariant of invariants) {
        const startedAt = new Date().toISOString();
        const startedMs = Date.now();
        const baseline = baselines[invariant.id];
        const captureFailure =
          baseline !== null && typeof baseline === 'object' && captureFailureKey in baseline
            ? (baseline as Record<string, unknown>)[captureFailureKey]
            : undefined;
        if (captureFailure !== undefined) {
          checks.push(
            buildCheck({
              assertion: invariant,
              kind: 'invariant',
              startedAt,
              startedMs,
              outcome: {
                status: 'ERROR',
                error:
                  captureFailure instanceof UpgradeLabError
                    ? new UpgradeLabError(
                        `Pre-upgrade baseline could not be captured: ${captureFailure.message}`,
                        {
                          code: captureFailure.code,
                          details: { invariant: invariant.id },
                          cause: captureFailure,
                        },
                      )
                    : captureFailure,
              },
            }),
          );
          continue;
        }
        if (baseline === undefined) {
          checks.push(
            buildCheck({
              assertion: invariant,
              kind: 'invariant',
              startedAt,
              startedMs,
              outcome: {
                status: 'ERROR',
                error: new UpgradeLabError(
                  `No pre-upgrade baseline was captured for invariant "${invariant.id}".`,
                  {
                    code: 'ASSERTION_ERROR',
                    details: { invariant: invariant.id },
                    hint: 'The baseline query failed before the upgrade; see the earlier check error.',
                  },
                ),
              },
            }),
          );
          continue;
        }
        const handler = invariantHandlers.get(invariant.type);
        if (!handler) {
          checks.push(
            buildCheck({
              assertion: invariant,
              kind: 'invariant',
              startedAt,
              startedMs,
              outcome: {
                status: 'ERROR',
                error: new UpgradeLabError(
                  `Invariant type "${invariant.type}" is not registered.`,
                  { code: 'ASSERTION_UNSUPPORTED' },
                ),
              },
            }),
          );
          continue;
        }
        const timeoutMs = invariant.timeoutMs ?? context.defaultTimeoutMs;
        const outcome = await runCheck(
          (signal) => handler.evaluate(invariant, baseline, { ...context, signal }),
          timeoutMs,
          context.signal,
          `invariant "${invariant.id}"`,
        );
        checks.push(
          buildCheck({ assertion: invariant, kind: 'invariant', startedAt, startedMs, outcome }),
        );
      }
      return { checks };
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown error');
}
