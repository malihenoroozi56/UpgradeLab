import type { SerializedError } from './errors.js';
import type { HealthcheckConfig } from './config.js';

/** Terminal status of a scenario or of an entire run. */
export const RUN_STATUSES = ['PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELLED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Status of an individual check (assertion or invariant). */
export const CHECK_STATUSES = ['PASSED', 'FAILED', 'SKIPPED', 'ERROR'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** Ordered lifecycle of a scenario execution. */
export const LIFECYCLE_PHASES = [
  'created',
  'preflight',
  'environment-created',
  'source-started',
  'seeded',
  'baseline-captured',
  'hop-started',
  'hop-completed',
  'target-started',
  'verified',
  'cleaned-up',
  'completed',
  'failed',
  'cancelled',
] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export type ExecutionEventType =
  'phase' | 'info' | 'warning' | 'error' | 'check' | 'command' | 'cleanup';

export interface ExecutionEvent {
  readonly sequence: number;
  readonly at: string;
  readonly phase: LifecyclePhase;
  readonly type: ExecutionEventType;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export type CheckKind = 'assertion' | 'invariant';

export interface CheckResult {
  readonly id: string;
  readonly kind: CheckKind;
  readonly type: string;
  readonly description?: string;
  readonly required: boolean;
  readonly status: CheckStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly baseline?: unknown;
  readonly message?: string;
  readonly evidenceIds: readonly string[];
  readonly error?: SerializedError;
}

export interface CommandResult {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export type ServiceRuntimeState =
  'running' | 'exited' | 'created' | 'restarting' | 'paused' | 'unknown';
export type ServiceHealth = 'healthy' | 'unhealthy' | 'starting' | 'none';

export interface ServiceState {
  readonly service: string;
  readonly state: ServiceRuntimeState;
  readonly health: ServiceHealth;
  readonly containerId?: string;
  readonly image?: string;
  readonly exitCode?: number;
  readonly startedAt?: string;
  readonly statusText?: string;
}

export interface Endpoint {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
}

export type EvidenceKind =
  'log' | 'command' | 'http' | 'query' | 'container' | 'environment' | 'file';

export interface EvidenceReference {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly description: string;
  readonly createdAt: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly inline?: string;
  readonly path?: string;
  readonly mediaType?: string;
}

export interface LogEntry {
  readonly at: string;
  readonly service: string;
  readonly stream: 'stdout' | 'stderr' | 'system';
  readonly message: string;
}

export interface CleanupReport {
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly removed: readonly string[];
  readonly durationMs: number;
  readonly warnings: readonly string[];
  readonly error?: SerializedError;
}

export interface StructuredLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): StructuredLogger;
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly attempts: number;
  readonly durationMs: number;
  readonly lastError?: string;
  readonly healthcheck?: HealthcheckConfig;
}

export interface ExecutionCounters {
  readonly assertions: number;
  readonly invariants: number;
  readonly commands: number;
}
