import type {
  DefaultsConfig,
  EnvironmentConfig,
  HealthcheckConfig,
  SecurityConfig,
} from './config.js';
import type {
  CleanupReport,
  CommandResult,
  Endpoint,
  EvidenceReference,
  LogEntry,
  LogEntry as LogEntryType,
  ReadinessResult,
  ServiceState,
  StructuredLogger,
} from './execution.js';
import type { SerializedError } from './errors.js';

export type ProviderLogger = StructuredLogger;

export interface PreflightCheck {
  readonly id: string;
  readonly status: 'PASSED' | 'FAILED' | 'WARNING';
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PreflightReport {
  readonly ok: boolean;
  readonly providerId: string;
  readonly checks: readonly PreflightCheck[];
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ServiceHandle {
  readonly name: string;
  readonly containerPort?: number;
  readonly endpoint?: Endpoint;
  readonly containerId?: string;
}

export interface EnvironmentHandle {
  readonly runId: string;
  readonly scenarioId: string;
  readonly projectName: string;
  readonly providerId: string;
  /** Absolute path of the per-run scratch directory owned by this run. */
  readonly runDirectory: string;
  readonly appService: string;
  readonly databaseService?: string;
  readonly services: Readonly<Record<string, ServiceHandle>>;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CreateEnvironmentRequest {
  readonly runId: string;
  readonly scenarioId: string;
  readonly projectName: string;
  readonly composeFile: string;
  readonly projectDirectory: string;
  readonly runDirectory: string;
  readonly environment: EnvironmentConfig;
  readonly security: SecurityConfig;
  readonly defaults: DefaultsConfig;
  readonly logger: ProviderLogger;
  readonly signal: AbortSignal;
}

export interface StartServiceRequest {
  readonly service: string;
  readonly image: string;
  readonly appPort?: number;
  readonly healthcheck?: HealthcheckConfig;
  readonly readinessTimeoutMs: number;
  readonly signal: AbortSignal;
}

export interface StartServiceResult {
  readonly service: string;
  readonly image: string;
  readonly containerId?: string;
  readonly state: ServiceState;
  readonly endpoint?: Endpoint;
  readonly readiness: ReadinessResult;
  readonly logs: readonly LogEntry[];
}

export interface RunCommandRequest {
  readonly service: string;
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface LogCollectionRequest {
  readonly services?: readonly string[];
  readonly tailLines: number;
  readonly signal: AbortSignal;
}

export interface ServiceReplacementRequest {
  readonly service: string;
  readonly image: string;
  readonly appPort?: number;
  readonly healthcheck?: HealthcheckConfig;
  readonly readinessTimeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * Contract implemented by every environment provider.
 *
 * Providers own all provider-specific behaviour (Docker, Compose, future
 * Kubernetes/Podman backends). The execution engine only uses this interface,
 * which keeps the engine provider-independent and contract-testable.
 */
export interface EnvironmentProvider {
  readonly id: string;
  readonly description: string;

  preflight(logger: ProviderLogger, signal: AbortSignal): Promise<PreflightReport>;

  createEnvironment(request: CreateEnvironmentRequest): Promise<EnvironmentHandle>;

  /** Starts a service, replacing the container if one already exists. */
  startService(
    handle: EnvironmentHandle,
    request: StartServiceRequest,
  ): Promise<StartServiceResult>;

  /**
   * Replaces only the requested service with a new image while preserving
   * named volumes, networks and every other service in the environment.
   */
  replaceService(
    handle: EnvironmentHandle,
    request: ServiceReplacementRequest,
  ): Promise<StartServiceResult>;

  getServiceState(
    handle: EnvironmentHandle,
    service: string,
    signal: AbortSignal,
  ): Promise<ServiceState>;

  getEndpoint(
    handle: EnvironmentHandle,
    service: string,
    containerPort: number,
    signal: AbortSignal,
  ): Promise<Endpoint>;

  waitForReadiness(
    handle: EnvironmentHandle,
    service: string,
    healthcheck: HealthcheckConfig,
    containerPort: number | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ReadinessResult>;

  runCommand(handle: EnvironmentHandle, request: RunCommandRequest): Promise<CommandResult>;

  collectLogs(handle: EnvironmentHandle, request: LogCollectionRequest): Promise<LogEntry[]>;

  /** Collects provider-level metadata recorded in reports (no secrets). */
  describeEnvironment(handle: EnvironmentHandle): Promise<Readonly<Record<string, string>>>;

  /** Removes only resources owned by this run. Must be idempotent. */
  destroyEnvironment(
    handle: EnvironmentHandle,
    logger: ProviderLogger,
    signal?: AbortSignal,
  ): Promise<CleanupReport>;
}

export interface ProviderCapabilities {
  readonly id: string;
  readonly supportsServiceReplacement: boolean;
  readonly supportsReadOnlySql: boolean;
  readonly supportsEgressRestriction: boolean;
}

export interface ProviderErrorContext {
  readonly providerId: string;
  readonly runId: string;
  readonly operation: string;
  readonly error?: SerializedError;
}

export type { LogEntryType };
export type { EvidenceReference };
