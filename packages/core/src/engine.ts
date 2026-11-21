import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  aggregateRunStatus,
  aggregateScenarioStatus,
  countCheckStatuses,
  isAbortError,
  serializeError,
  UpgradeLabError,
  type CheckResult,
  type CheckRunner,
  type CleanupReport,
  type DatabaseAdapter,
  type EnvironmentHandle,
  type EnvironmentProvider,
  type ExecutionEvent,
  type HealthcheckConfig,
  type HopReport,
  type LogEntry,
  type PreflightReport,
  type Redactor,
  type RunStatus,
  type ScenarioConfig,
  type ScenarioReport,
  type SerializedError,
  type ServiceState,
  type SetupCommandConfig,
  type SetupExecutionResult,
  type StructuredLogger,
  type UpgradeLabConfig,
  type UpgradeStepConfig,
} from '@upgradelab/contracts';
import { EvidenceCollector } from './evidence.js';
import { composeProjectName, createRunId, resolveRunRoot } from './ids.js';
import { ExecutionTimeline } from './timeline.js';
import { DatabaseSession, ScenarioAccess } from './runtime.js';
import { createDeadline, throwIfAborted, withTimeout } from './timeout.js';

const MAX_REPORT_STREAM_CHARS = 8_000;

export interface EngineOptions {
  readonly provider: EnvironmentProvider;
  readonly checkRunner: CheckRunner;
  readonly redactor: Redactor;
  readonly logger: StructuredLogger;
  readonly config: UpgradeLabConfig;
  readonly composeFile: string;
  readonly projectDirectory: string;
  readonly databaseAdapter?: DatabaseAdapter;
  /** Root for per-run scratch directories. Defaults to the OS temp directory. */
  readonly runRoot?: string;
}

export interface EngineRunRequest {
  readonly scenarios: readonly ScenarioConfig[];
  readonly configPath: string;
  readonly signal: AbortSignal;
  readonly runId?: string;
  readonly runRoot?: string;
  readonly onEvent?: (event: ExecutionEvent) => void;
  readonly onScenarioStart?: (scenario: ScenarioConfig) => void;
}

export interface EngineRunResult {
  readonly runId: string;
  readonly runDirectory: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: RunStatus;
  readonly scenarios: readonly ScenarioReport[];
  readonly preflight: PreflightReport;
  readonly cleanupFailed: boolean;
  readonly cancelled: boolean;
}

interface ScenarioState {
  readonly checks: CheckResult[];
  readonly setup: SetupExecutionResult[];
  readonly hops: HopReport[];
  evidence: EvidenceCollector;
  logs: readonly LogEntry[];
  handle?: EnvironmentHandle;
  database?: DatabaseSession;
  baselines: Record<string, unknown>;
  error?: unknown;
  forceFailed: boolean;
  cleanup: CleanupReport;
  metadata: Record<string, string>;
}

interface StartStepResult {
  readonly readiness: {
    readonly ready: boolean;
    readonly attempts: number;
    readonly durationMs: number;
    readonly lastError?: string;
  };
  readonly state: ServiceState;
  readonly endpoint?: { readonly baseUrl: string; readonly host: string; readonly port: number };
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(value: string, limit = MAX_REPORT_STREAM_CHARS): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n…[truncated ${value.length - limit} characters]`;
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }
  if (error instanceof UpgradeLabError) {
    return error.code === 'EXECUTION_CANCELLED';
  }
  return isAbortError(error);
}

/**
 * Executes upgrade scenarios against a provider.
 *
 * The engine owns sequencing, timeouts, cancellation, evidence collection,
 * cleanup and the final verdict. It never inspects application logs to decide
 * success: only evaluated checks can produce PASSED.
 */
export class ExecutionEngine {
  private preflightReport: PreflightReport | undefined;

  constructor(private readonly options: EngineOptions) {}

  async preflight(signal: AbortSignal): Promise<PreflightReport> {
    if (this.preflightReport) {
      return this.preflightReport;
    }
    const report = await this.options.provider.preflight(this.options.logger, signal);
    this.preflightReport = report;
    if (!report.ok) {
      const failed = report.checks.find((check) => check.status === 'FAILED');
      const code =
        failed?.id === 'docker'
          ? 'ENVIRONMENT_DOCKER_MISSING'
          : failed?.id === 'docker-compose'
            ? 'ENVIRONMENT_COMPOSE_MISSING'
            : failed?.id === 'compose-config'
              ? 'ENVIRONMENT_COMPOSE_INVALID'
              : 'ENVIRONMENT_NOT_READY';
      throw new UpgradeLabError(failed?.message ?? 'Environment preflight failed.', {
        code,
        details: { checks: report.checks },
        hint: 'Run "upgradelab doctor" for a detailed diagnosis.',
      });
    }
    return report;
  }

  async run(request: EngineRunRequest): Promise<EngineRunResult> {
    const startedAt = nowIso();
    const startedMs = Date.now();
    const runId = request.runId ?? createRunId();
    const runDirectory = path.join(resolveRunRoot(request.runRoot ?? this.options.runRoot), runId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });

    const preflight = await this.preflight(request.signal);
    const scenarios: ScenarioReport[] = [];

    for (const scenario of request.scenarios) {
      throwIfAborted(request.signal);
      request.onScenarioStart?.(scenario);
      const report = await this.runScenario({
        scenario,
        configPath: request.configPath,
        runId,
        runDirectory: path.join(runDirectory, scenario.id),
        signal: request.signal,
        ...(request.onEvent ? { onEvent: request.onEvent } : {}),
      });
      scenarios.push(report);
      if (this.options.config.defaults.failFast && report.status !== 'PASSED') {
        this.options.logger.warn('Stopping after first non-passing scenario (defaults.failFast).', {
          scenarioId: scenario.id,
          status: report.status,
        });
        break;
      }
    }

    const finishedAt = nowIso();
    const status = aggregateRunStatus(scenarios.map((scenario) => scenario.status));
    return {
      runId,
      runDirectory,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
      status,
      scenarios,
      preflight,
      cleanupFailed: scenarios.some(
        (scenario) => scenario.cleanup.attempted && !scenario.cleanup.succeeded,
      ),
      cancelled: request.signal.aborted,
    };
  }

  private async runScenario(params: {
    scenario: ScenarioConfig;
    configPath: string;
    runId: string;
    runDirectory: string;
    signal: AbortSignal;
    onEvent?: (event: ExecutionEvent) => void;
  }): Promise<ScenarioReport> {
    const config = this.options.config;
    const { scenario, signal, onEvent } = params;
    const logger = this.options.logger.child({ scenarioId: scenario.id });
    const startedAt = nowIso();
    const startedMs = Date.now();
    const timeline = new ExecutionTimeline(onEvent);
    const state: ScenarioState = {
      checks: [],
      setup: [],
      hops: [],
      evidence: new EvidenceCollector(this.options.redactor),
      logs: [],
      baselines: {},
      forceFailed: false,
      cleanup: { attempted: false, succeeded: true, removed: [], durationMs: 0, warnings: [] },
      metadata: {},
    };
    const projectName = composeProjectName(params.runId, scenario.id);
    await mkdir(params.runDirectory, { recursive: true, mode: 0o700 });
    const deadline = createDeadline(
      scenario.timeoutMs ?? config.defaults.scenarioTimeoutMs,
      signal,
    );

    try {
      timeline.transition('preflight', `Validating scenario "${scenario.id}".`);
      this.validateScenarioAssertions(scenario);
      throwIfAborted(deadline.signal);

      timeline.transition('environment-created', `Creating isolated environment ${projectName}.`, {
        projectName,
      });
      state.handle = await withTimeout(
        (operationSignal) =>
          this.options.provider.createEnvironment({
            runId: params.runId,
            scenarioId: scenario.id,
            projectName,
            composeFile: this.options.composeFile,
            projectDirectory: this.options.projectDirectory,
            runDirectory: params.runDirectory,
            environment: config.environment,
            security: config.security,
            defaults: config.defaults,
            logger,
            signal: operationSignal,
          }),
        config.environment.timeouts.startMs,
        deadline.signal,
        'create environment',
      );
      state.metadata = await this.collectMetadata(state.handle);
      state.evidence.add(
        'environment',
        'Environment metadata',
        JSON.stringify({ projectName, ...state.metadata }, null, 2),
        { mediaType: 'application/json' },
      );
      timeline.info('Environment ready.', { projectName });

      const steps = scenario.path;
      const sourceStep = steps[0];
      if (!sourceStep) {
        throw new UpgradeLabError(`Scenario "${scenario.id}" has no upgrade steps.`, {
          code: 'INTERNAL_ERROR',
        });
      }

      const sourceStart = await this.startStep({
        handle: state.handle,
        step: sourceStep,
        index: 0,
        state,
        stepCount: steps.length,
        signal: deadline.signal,
        replace: false,
        logger,
      });
      timeline.transition('source-started', `Source release ${sourceStep.image} is ready.`, {
        image: sourceStep.image,
        attempts: sourceStart.readiness.attempts,
      });
      if (!sourceStep.healthcheck && !config.environment.application.healthcheck) {
        timeline.warning(
          'No healthcheck configured: readiness only proves that the container is running, not that the application serves traffic.',
        );
      }

      await this.runSetupCommands({
        handle: state.handle,
        commands: sourceStep.setup,
        stepIndex: 0,
        signal: deadline.signal,
        state,
        timeline,
        logger,
      });
      timeline.transition('seeded', 'Source data setup completed.', {
        commands: sourceStep.setup.length,
      });

      let database: DatabaseSession | undefined;
      if (config.environment.database && this.options.databaseAdapter) {
        database = await DatabaseSession.connect({
          adapter: this.options.databaseAdapter,
          provider: this.options.provider,
          handle: state.handle,
          config,
          signal: deadline.signal,
          logger,
        });
        state.database = database;
      }

      const access = new ScenarioAccess({
        provider: this.options.provider,
        handle: state.handle,
        config,
        signal: deadline.signal,
        logger,
        evidence: state.evidence,
        ...(database ? { database } : {}),
      });

      if (scenario.invariants.length > 0) {
        const baseline = await this.options.checkRunner.captureBaseline(
          scenario.invariants,
          access.createContext(0, scenario.id),
        );
        state.baselines = { ...baseline.baselines };
        this.recordChecks(state, timeline, baseline.checks);
        timeline.info('Captured pre-upgrade baseline.', {
          invariants: Object.keys(state.baselines).length,
        });
      }
      timeline.transition('baseline-captured', 'Baseline captured.', {
        invariants: scenario.invariants.length,
      });

      // Assert the source release actually works before attributing anything to
      // the upgrade; a broken fixture must not be reported as a broken upgrade.
      if (sourceStep.assertions.length > 0) {
        const sourceChecks = await this.options.checkRunner.runAssertions(
          sourceStep.assertions,
          access.createContext(0, scenario.id),
        );
        this.recordChecks(state, timeline, sourceChecks.checks);
        if (this.hasRequiredFailure(sourceChecks.checks)) {
          throw new UpgradeLabError(
            'Pre-upgrade assertions failed: the source release is not in a verifiable state.',
            {
              code: 'ASSERTION_FAILED',
              details: { phase: 'pre-upgrade', scenarioId: scenario.id },
              hint: 'Fix the source fixture or environment before trusting upgrade results.',
            },
          );
        }
      }

      for (let index = 1; index < steps.length; index += 1) {
        const step = steps[index];
        if (!step) {
          continue;
        }
        timeline.transition('hop-started', `Upgrading to ${step.image}.`, {
          hop: index,
          image: step.image,
        });
        try {
          const replacement = await this.startStep({
            handle: state.handle,
            step,
            index,
            state,
            stepCount: steps.length,
            signal: deadline.signal,
            replace: true,
            logger,
          });
          const isTarget = index === steps.length - 1;
          if (isTarget) {
            timeline.transition('target-started', `Target release ${step.image} is ready.`, {
              image: step.image,
              attempts: replacement.readiness.attempts,
            });
          } else {
            timeline.transition('hop-completed', `Hop ${index} completed.`, {
              image: step.image,
            });
          }
        } catch (error) {
          // A target release that does not start or become ready is a genuine
          // upgrade failure. Timeouts and cancellation are not: they mean the
          // upgrade could not be evaluated, which is INCONCLUSIVE/CANCELLED.
          const aborted =
            error instanceof UpgradeLabError &&
            (error.code === 'EXECUTION_TIMEOUT' || error.code === 'EXECUTION_CANCELLED');
          if (!aborted) {
            state.forceFailed = true;
          }
          throw error;
        }

        await this.runSetupCommands({
          handle: state.handle,
          commands: step.setup,
          stepIndex: index,
          signal: deadline.signal,
          state,
          timeline,
          logger,
        });

        if (step.assertions.length > 0) {
          const stepChecks = await this.options.checkRunner.runAssertions(
            step.assertions,
            access.createContext(index, scenario.id),
          );
          this.recordChecks(state, timeline, stepChecks.checks);
          const isFinal = index === steps.length - 1;
          if (!isFinal && this.hasRequiredFailure(stepChecks.checks)) {
            throw new UpgradeLabError(
              `Post-hop assertions failed after upgrading to ${step.image}.`,
              {
                code: 'ASSERTION_FAILED',
                details: { hop: index, image: step.image },
              },
            );
          }
        }
      }

      const finalIndex = steps.length - 1;
      const finalContext = access.createContext(finalIndex, scenario.id);
      if (scenario.invariants.length > 0) {
        const invariantChecks = await this.options.checkRunner.runInvariants(
          scenario.invariants,
          state.baselines,
          finalContext,
        );
        this.recordChecks(state, timeline, invariantChecks.checks);
      }
      if (scenario.assertions.length > 0) {
        const assertionChecks = await this.options.checkRunner.runAssertions(
          scenario.assertions,
          finalContext,
        );
        this.recordChecks(state, timeline, assertionChecks.checks);
      }
      timeline.transition('verified', 'Post-upgrade verification completed.', {
        checks: state.checks.length,
      });
    } catch (error) {
      const cancelled = isCancellation(error, signal) && !deadline.timedOut();
      const effective = cancelled
        ? new UpgradeLabError('Scenario cancelled.', { code: 'EXECUTION_CANCELLED' })
        : error;
      state.error = effective;
      logger.error('Scenario execution did not complete.', {
        error: effective instanceof Error ? effective.message : String(effective),
      });
      try {
        timeline.transition(
          cancelled ? 'cancelled' : 'failed',
          cancelled ? 'Scenario cancelled.' : 'Scenario execution failed.',
          { error: serializeError(effective) },
        );
      } catch (transitionError) {
        logger.debug('Unable to record failure transition.', {
          error:
            transitionError instanceof Error ? transitionError.message : String(transitionError),
        });
      }
    } finally {
      state.cleanup = await this.cleanup(state, logger, config);
      timeline.cleanup('Environment cleanup finished.', {
        attempted: state.cleanup.attempted,
        succeeded: state.cleanup.succeeded,
        removed: state.cleanup.removed.length,
        warnings: state.cleanup.warnings.length,
      });
      try {
        timeline.transition('cleaned-up', 'Cleanup phase completed.');
      } catch (error) {
        logger.debug('Unable to record cleanup transition.', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      deadline.dispose();
    }

    const cancelled = signal.aborted && !deadline.timedOut();
    let status: RunStatus;
    if (cancelled) {
      status = 'CANCELLED';
    } else if (state.forceFailed) {
      status = 'FAILED';
    } else {
      status = aggregateScenarioStatus({
        checks: state.checks,
        cancelled: false,
        ...(state.error === undefined ? {} : { error: state.error }),
      });
    }

    try {
      timeline.transition(
        status === 'FAILED' ? 'failed' : status === 'CANCELLED' ? 'cancelled' : 'completed',
        `Scenario finished with status ${status}.`,
        { status },
      );
    } catch (error) {
      logger.debug('Unable to record final lifecycle transition.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const finishedAt = nowIso();
    return {
      id: scenario.id,
      ...(scenario.description ? { description: scenario.description } : {}),
      status,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
      sourceImage: scenario.path[0]?.image ?? '',
      targetImage: scenario.path[scenario.path.length - 1]?.image ?? '',
      imagePath: scenario.path.map((step) => step.image),
      hops: state.hops,
      setup: state.setup,
      checks: state.checks,
      counts: countCheckStatuses(state.checks),
      logs: state.logs,
      events: timeline.events,
      evidence: state.evidence.all(),
      environment: {
        provider: this.options.provider.id,
        projectName,
        composeFile: this.options.composeFile,
        metadata: state.metadata,
      },
      cleanup: state.cleanup,
      ...(state.error === undefined ? {} : { error: serializeError(state.error) }),
    };
  }

  private async startStep(params: {
    handle: EnvironmentHandle;
    step: UpgradeStepConfig;
    index: number;
    stepCount: number;
    signal: AbortSignal;
    state: ScenarioState;
    replace: boolean;
    logger: StructuredLogger;
  }): Promise<StartStepResult> {
    const config = this.options.config;
    const startedMs = Date.now();
    const healthcheck: HealthcheckConfig | undefined =
      params.step.healthcheck ?? config.environment.application.healthcheck;
    const appPort = config.environment.application.port;
    const request = {
      service: params.handle.appService,
      image: params.step.image,
      ...(appPort !== undefined ? { appPort } : {}),
      ...(healthcheck ? { healthcheck } : {}),
      readinessTimeoutMs: config.environment.timeouts.readinessMs,
    };

    const result = await withTimeout(
      (operationSignal) => {
        const withSignal = { ...request, signal: operationSignal };
        return params.replace
          ? this.options.provider.replaceService(params.handle, withSignal)
          : this.options.provider.startService(params.handle, withSignal);
      },
      config.environment.timeouts.startMs,
      params.signal,
      params.replace ? 'replace service' : 'start service',
    );

    params.state.hops.push({
      index: params.index,
      image: params.step.image,
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: nowIso(),
      durationMs: Date.now() - startedMs,
      ready: result.readiness.ready,
      readinessAttempts: result.readiness.attempts,
      serviceState: result.state,
      ...(result.endpoint ? { endpoint: result.endpoint.baseUrl } : {}),
    });

    params.state.evidence.add(
      'container',
      `Service state after starting ${params.step.image}`,
      JSON.stringify(
        { state: result.state, readiness: result.readiness, endpoint: result.endpoint },
        null,
        2,
      ),
      { mediaType: 'application/json' },
    );

    if (!result.readiness.ready) {
      const lastError = result.readiness.lastError ?? 'readiness checks did not pass';
      throw new UpgradeLabError(
        `Service did not become ready after ${result.readiness.durationMs} ms: ${lastError}`,
        {
          code: 'ENVIRONMENT_NOT_READY',
          details: {
            scenarioId: params.handle.scenarioId,
            image: params.step.image,
            service: params.handle.appService,
            readinessAttempts: result.readiness.attempts,
          },
          hint: 'Check collected container logs and the healthcheck configuration.',
        },
      );
    }

    return {
      readiness: result.readiness,
      state: result.state,
      ...(result.endpoint ? { endpoint: result.endpoint } : {}),
    };
  }

  private async runSetupCommands(params: {
    handle: EnvironmentHandle;
    commands: readonly SetupCommandConfig[];
    stepIndex: number;
    signal: AbortSignal;
    state: ScenarioState;
    timeline: ExecutionTimeline;
    logger: StructuredLogger;
  }): Promise<void> {
    for (const [index, command] of params.commands.entries()) {
      throwIfAborted(params.signal);
      const timeoutMs = command.timeoutMs ?? this.options.config.environment.timeouts.commandMs;
      params.logger.info('Running setup command.', {
        service: command.target,
        command: command.command,
      });
      const result = await this.options.provider.runCommand(params.handle, {
        service: command.target,
        command: command.command,
        ...(command.env ? { env: command.env } : {}),
        timeoutMs,
        signal: params.signal,
      });
      const passed = result.exitCode === command.expectedExitCode && !result.timedOut;
      const evidence = params.state.evidence.add(
        'command',
        `Setup command ${index + 1} on ${command.target}`,
        [
          `$ ${command.command.join(' ')}`,
          `exitCode: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`,
          '--- stdout ---',
          result.stdout,
          '--- stderr ---',
          result.stderr,
        ].join('\n'),
      );
      params.state.setup.push({
        id: `step-${params.stepIndex}-setup-${index + 1}`,
        target: command.target,
        command: command.command,
        status: passed ? 'PASSED' : 'FAILED',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: truncate(result.stdout),
        stderr: truncate(result.stderr),
        evidenceIds: [evidence.id],
      });
      params.timeline.command(
        `Setup command ${passed ? 'succeeded' : 'failed'}: ${command.command[0] ?? ''}`,
        { exitCode: result.exitCode, durationMs: result.durationMs },
      );
      if (!passed) {
        throw new UpgradeLabError(
          `Setup command failed on service "${command.target}" with exit code ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}.`,
          {
            code: 'PROVIDER_COMMAND_FAILED',
            details: {
              stepIndex: params.stepIndex,
              command: command.command,
              expectedExitCode: command.expectedExitCode,
              actualExitCode: result.exitCode,
            },
            hint: 'Setup commands must succeed; upgrade verification cannot run against an unseeded environment.',
          },
        );
      }
    }
  }

  private recordChecks(
    state: ScenarioState,
    timeline: ExecutionTimeline,
    checks: readonly CheckResult[],
  ): void {
    for (const check of checks) {
      state.checks.push(check);
      timeline.check(
        `${check.kind === 'invariant' ? 'Invariant' : 'Assertion'} "${check.id}" ${check.status.toLowerCase()}.`,
        { id: check.id, status: check.status, message: check.message ?? '' },
      );
      if (check.required && check.status === 'FAILED') {
        timeline.error(`Required check "${check.id}" failed.`, {
          expected: check.expected,
          actual: check.actual,
        });
      }
    }
  }

  private hasRequiredFailure(checks: readonly CheckResult[]): boolean {
    return checks.some(
      (check) => check.required && (check.status === 'FAILED' || check.status === 'ERROR'),
    );
  }

  private validateScenarioAssertions(scenario: ScenarioConfig): void {
    const assertions = [
      ...scenario.assertions,
      ...scenario.path.flatMap((step) => step.assertions),
    ];
    this.options.checkRunner.validateAssertions?.(assertions);
  }

  private async cleanup(
    state: ScenarioState,
    logger: StructuredLogger,
    config: UpgradeLabConfig,
  ): Promise<CleanupReport> {
    const startedMs = Date.now();
    const warnings: string[] = [];
    const removed: string[] = [];
    if (!state.handle) {
      return { attempted: false, succeeded: true, removed, durationMs: 0, warnings };
    }
    // Cleanup must always run, even after cancellation: it uses an independent
    // timeout signal so a cancelled scenario cannot leak containers or volumes.
    const cleanupSignal = AbortSignal.timeout(
      Math.max(30_000, config.environment.timeouts.stopMs * 2),
    );
    try {
      const logs = await this.options.provider.collectLogs(state.handle, {
        tailLines: config.defaults.logTailLines,
        signal: cleanupSignal,
      });
      state.logs = logs;
      const content =
        logs.length === 0
          ? 'No log output was collected.'
          : logs
              .map((entry) => `[${entry.at}] [${entry.service}/${entry.stream}] ${entry.message}`)
              .join('\n');
      state.evidence.add('log', 'Container logs', content, { mediaType: 'text/plain' });
    } catch (error) {
      warnings.push(
        `Log collection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      logger.warn('Log collection failed.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (state.database) {
      await state.database.dispose();
    }
    try {
      const report = await this.options.provider.destroyEnvironment(
        state.handle,
        logger,
        cleanupSignal,
      );
      removed.push(...report.removed);
      warnings.push(...report.warnings);
      return {
        attempted: report.attempted,
        succeeded: report.succeeded,
        removed,
        durationMs: Date.now() - startedMs,
        warnings,
        ...(report.error ? { error: report.error } : {}),
      };
    } catch (error) {
      const serialized: SerializedError = serializeError(error);
      warnings.push('Environment cleanup failed; resources may still exist.');
      logger.error('Environment cleanup failed.', { error: serialized.message });
      return {
        attempted: true,
        succeeded: false,
        removed,
        durationMs: Date.now() - startedMs,
        warnings,
        error: serialized,
      };
    }
  }

  private async collectMetadata(handle: EnvironmentHandle): Promise<Record<string, string>> {
    try {
      return { ...(await this.options.provider.describeEnvironment(handle)) };
    } catch (error) {
      this.options.logger.debug('Unable to describe environment metadata.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }
}
