import type { AssertionConfig, HealthcheckConfig, InvariantConfig } from './config.js';
import type { SqlExecutor } from './database.js';
import type {
  CheckResult,
  CommandResult,
  Endpoint,
  EvidenceKind,
  EvidenceReference,
  LogEntry,
  ServiceState,
  StructuredLogger,
} from './execution.js';
import type { SerializedError } from './errors.js';

/** Collects evidence while a scenario runs and assigns stable ids. */
export interface EvidenceSink {
  add(
    kind: EvidenceKind,
    description: string,
    content: string,
    options?: { readonly mediaType?: string },
  ): EvidenceReference;
}

export interface ApplicationAccess {
  readonly service: string;
  readonly containerPort?: number;
  /** Healthcheck configured for the application, when one exists. */
  readonly healthcheck?: HealthcheckConfig;
  /** Base URL of the currently running application container. */
  endpoint(): Promise<Endpoint>;
  /** Base URL for an arbitrary container port exposed by the app service. */
  endpointFor(containerPort: number): Promise<Endpoint>;
}

export interface EnvironmentAccess {
  serviceState(service: string): Promise<ServiceState>;
  runCommand(request: {
    readonly service: string;
    readonly command: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  }): Promise<CommandResult>;
  collectLogs(request: {
    readonly services?: readonly string[];
    readonly tailLines: number;
  }): Promise<readonly LogEntry[]>;
}

/**
 * Everything a built-in or plugin assertion may use.
 *
 * The context intentionally exposes only read access to the environment. It is
 * scoped to one check, so plugin code cannot reuse a context to mutate state
 * outside its assertion.
 */
export interface CheckContext {
  readonly scenarioId: string;
  readonly stepIndex: number;
  readonly signal: AbortSignal;
  readonly logger: StructuredLogger;
  readonly application: ApplicationAccess;
  readonly environment: EnvironmentAccess;
  readonly database?: SqlExecutor;
  readonly evidence: EvidenceSink;
  readonly defaultTimeoutMs: number;
}

export interface AssertionExecutionResult {
  readonly passed: boolean;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  /** Pre-upgrade value, for invariants compared against a baseline. */
  readonly baseline?: unknown;
  readonly evidenceIds?: readonly string[];
  readonly error?: SerializedError;
}

export interface AssertionHandler {
  readonly type: string;
  readonly description: string;
  execute(assertion: AssertionConfig, context: CheckContext): Promise<AssertionExecutionResult>;
}

export interface InvariantHandler {
  readonly type: string;
  readonly description: string;
  capture(
    invariant: InvariantConfig,
    context: CheckContext,
  ): Promise<{ readonly baseline: unknown; readonly evidenceIds: readonly string[] }>;
  evaluate(
    invariant: InvariantConfig,
    baseline: unknown,
    context: CheckContext,
  ): Promise<AssertionExecutionResult>;
}

export interface BaselineCaptureResult {
  readonly baselines: Readonly<Record<string, unknown>>;
  readonly checks: readonly CheckResult[];
}

export interface CheckRunResult {
  readonly checks: readonly CheckResult[];
}

/**
 * Verification port consumed by the execution engine.
 *
 * The engine does not know how SQL, HTTP or plugin assertions work; it only
 * sequences phases and decides the verdict from the returned check results.
 */
export interface CheckRunner {
  /** Rejects unsupported assertion types before any environment is created. */
  validateAssertions(assertions: readonly AssertionConfig[]): void;
  captureBaseline(
    invariants: readonly InvariantConfig[],
    context: CheckContext,
  ): Promise<BaselineCaptureResult>;
  runAssertions(
    assertions: readonly AssertionConfig[],
    context: CheckContext,
  ): Promise<CheckRunResult>;
  runInvariants(
    invariants: readonly InvariantConfig[],
    baselines: Readonly<Record<string, unknown>>,
    context: CheckContext,
  ): Promise<CheckRunResult>;
}

export interface AssertionHandlerRegistration {
  readonly handler: AssertionHandler;
  /** Rejects invalid plugin parameters before the environment starts. */
  validate?(assertion: AssertionConfig): void;
}
