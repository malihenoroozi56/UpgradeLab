import {
  UpgradeLabError,
  type ExecutionEvent,
  type ExecutionEventType,
  type LifecyclePhase,
} from '@upgradelab/contracts';

const ALLOWED_TRANSITIONS: Record<LifecyclePhase, readonly LifecyclePhase[]> = {
  created: ['preflight', 'failed', 'cancelled'],
  preflight: ['environment-created', 'failed', 'cancelled'],
  'environment-created': ['source-started', 'failed', 'cancelled'],
  'source-started': ['seeded', 'failed', 'cancelled'],
  seeded: ['baseline-captured', 'failed', 'cancelled', 'cleaned-up'],
  'baseline-captured': ['hop-started', 'verified', 'failed', 'cancelled'],
  'hop-started': ['hop-completed', 'target-started', 'failed', 'cancelled'],
  'hop-completed': ['hop-started', 'target-started', 'failed', 'cancelled'],
  'target-started': ['verified', 'failed', 'cancelled'],
  verified: ['cleaned-up', 'failed', 'cancelled'],
  'cleaned-up': ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['cleaned-up'],
  cancelled: ['cleaned-up'],
};

/**
 * Records the ordered lifecycle of one scenario.
 *
 * Illegal transitions throw an internal error: the engine must never silently
 * skip a phase, because a skipped phase is exactly how a broken upgrade would
 * be misreported as a success.
 */
export class ExecutionTimeline {
  private currentPhase: LifecyclePhase = 'created';
  private sequence = 0;
  private readonly recorded: ExecutionEvent[] = [];
  private readonly listener: ((event: ExecutionEvent) => void) | undefined;

  constructor(listener?: (event: ExecutionEvent) => void) {
    this.listener = listener;
  }

  get phase(): LifecyclePhase {
    return this.currentPhase;
  }

  get events(): readonly ExecutionEvent[] {
    return [...this.recorded];
  }

  transition(
    phase: LifecyclePhase,
    message: string,
    data?: Record<string, unknown>,
  ): ExecutionEvent {
    const allowed = ALLOWED_TRANSITIONS[this.currentPhase];
    if (!allowed.includes(phase)) {
      throw new UpgradeLabError(`Invalid lifecycle transition ${this.currentPhase} -> ${phase}.`, {
        code: 'INTERNAL_ERROR',
        details: { from: this.currentPhase, to: phase },
      });
    }
    this.currentPhase = phase;
    return this.record('phase', message, data);
  }

  info(message: string, data?: Record<string, unknown>): ExecutionEvent {
    return this.record('info', message, data);
  }

  warning(message: string, data?: Record<string, unknown>): ExecutionEvent {
    return this.record('warning', message, data);
  }

  error(message: string, data?: Record<string, unknown>): ExecutionEvent {
    return this.record('error', message, data);
  }

  check(message: string, data?: Record<string, unknown>): ExecutionEvent {
    return this.record('check', message, data);
  }

  command(message: string, data?: Record<string, unknown>): ExecutionEvent {
    return this.record('command', message, data);
  }

  cleanup(message: string, data?: Record<string, unknown>): ExecutionEvent {
    return this.record('cleanup', message, data);
  }

  private record(
    type: ExecutionEventType,
    message: string,
    data?: Record<string, unknown>,
  ): ExecutionEvent {
    this.sequence += 1;
    const event: ExecutionEvent = {
      sequence: this.sequence,
      at: new Date().toISOString(),
      phase: this.currentPhase,
      type,
      message,
      ...(data ? { data } : {}),
    };
    this.recorded.push(event);
    this.listener?.(event);
    return event;
  }
}
