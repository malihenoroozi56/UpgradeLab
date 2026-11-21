import { rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { stringify } from 'yaml';
import {
  DEFAULTS,
  UpgradeLabError,
  type CleanupReport,
  type CommandResult,
  type CreateEnvironmentRequest,
  type DefaultsConfig,
  type Endpoint,
  type EnvironmentConfig,
  type EnvironmentHandle,
  type EnvironmentProvider,
  type HealthcheckConfig,
  type LogEntry,
  type LogCollectionRequest,
  type PreflightCheck,
  type PreflightReport,
  type ProviderLogger,
  type ReadinessResult,
  type RunCommandRequest,
  type SecurityConfig,
  type ServiceReplacementRequest,
  type ServiceState,
  type StartServiceRequest,
  type StartServiceResult,
  type StructuredLogger,
  serializeError,
} from '@upgradelab/contracts';
import {
  escapeComposeInterpolation,
  parseComposeConfig,
  parseComposePs,
  type ComposeConfig,
  type ComposeService,
} from './compose-types.js';
import { canonicalizeComposeConfig } from './canonicalize.js';
import { ExecaCommandRunner, type CommandOutput, type CommandRunner } from './exec.js';
import { waitForReadiness } from './readiness.js';
import { analyzeComposeSecurity, type SecurityIssue } from './security.js';

const MIN_COMPOSE_VERSION = { major: 2, minor: 20 };
const LABEL_MANAGED = 'upgradelab.managed';
const LABEL_RUN_ID = 'upgradelab.run-id';
const LABEL_SCENARIO_ID = 'upgradelab.scenario-id';
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

export interface DockerComposeProviderOptions {
  readonly composeFile: string;
  readonly projectDirectory: string;
  readonly composeEnv?: Readonly<Record<string, string>>;
  readonly security?: SecurityConfig;
  readonly environment?: EnvironmentConfig;
  readonly defaults?: DefaultsConfig;
  readonly runner?: CommandRunner;
  readonly dockerCommand?: string;
}

interface EnvironmentContext {
  readonly projectName: string;
  readonly runId: string;
  readonly scenarioId: string;
  readonly appService: string;
  readonly databaseService?: string;
  readonly runDirectory: string;
  readonly configFile: string;
  readonly baseConfig: ComposeConfig;
  readonly environment: EnvironmentConfig;
  readonly security: SecurityConfig;
  readonly defaults: DefaultsConfig;
  readonly composeEnv: Readonly<Record<string, string | undefined>>;
  readonly labels: Record<string, string>;
  readonly ports: Map<string, number>;
  readonly images: Map<string, string>;
  config?: ComposeConfig;
}

function truncate(value: string, limit = 8_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`;
}

function parseComposeVersion(
  output: string,
): { major: number; minor: number; patch: number } | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function parsePortOutput(output: string): { host: string; port: number } | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.reverse()) {
    const ipv6 = /^\[([^\]]+)\]:(\d+)$/.exec(line);
    if (ipv6) {
      return { host: ipv6[1] ?? '127.0.0.1', port: Number(ipv6[2]) };
    }
    const index = line.lastIndexOf(':');
    if (index <= 0) {
      continue;
    }
    const host = line.slice(0, index);
    const port = Number(line.slice(index + 1));
    if (!Number.isInteger(port) || port <= 0) {
      continue;
    }
    return { host: host === '' ? '127.0.0.1' : host, port };
  }
  return undefined;
}

function buildBaseUrl(host: string, port: number): string {
  const hostname = host.includes(':') ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

function serviceStateFromPs(entry: {
  State?: string;
  Health?: string;
  ExitCode?: number;
  ID?: string;
  Image?: string;
  Status?: string;
}): ServiceState {
  const rawState = (entry.State ?? '').toLowerCase();
  const state =
    rawState === 'running' ||
    rawState === 'exited' ||
    rawState === 'created' ||
    rawState === 'restarting' ||
    rawState === 'paused'
      ? rawState
      : 'unknown';
  const rawHealth = (entry.Health ?? '').toLowerCase();
  const health =
    rawHealth === 'healthy'
      ? 'healthy'
      : rawHealth === 'unhealthy'
        ? 'unhealthy'
        : rawHealth === 'starting'
          ? 'starting'
          : 'none';
  return {
    service: '',
    state,
    health,
    ...(entry.ID ? { containerId: entry.ID } : {}),
    ...(entry.Image ? { image: entry.Image } : {}),
    ...(typeof entry.ExitCode === 'number' ? { exitCode: entry.ExitCode } : {}),
    ...(entry.Status ? { statusText: entry.Status } : {}),
  };
}

/**
 * Docker Compose environment provider.
 *
 * Isolation model:
 * - one generated Compose project per scenario execution, named `upgradelab-*`;
 * - the user's Compose file is resolved once, then rewritten into a hardened
 *   run-owned file with loopback ports, resource limits and ownership labels;
 * - only resources labelled with this run id are ever removed.
 */
export class DockerComposeProvider implements EnvironmentProvider {
  readonly id = 'docker-compose';
  readonly description = 'Isolated Docker Compose environments (generated per run)';

  private readonly runner: CommandRunner;
  private readonly dockerCommand: string;
  private readonly contexts = new Map<string, EnvironmentContext>();
  private preflightMetadata: Record<string, string> = {};

  constructor(private readonly options: DockerComposeProviderOptions) {
    this.runner = options.runner ?? new ExecaCommandRunner();
    this.dockerCommand = options.dockerCommand ?? 'docker';
  }

  async preflight(logger: ProviderLogger, signal: AbortSignal): Promise<PreflightReport> {
    const checks: PreflightCheck[] = [];
    const metadata: Record<string, string> = {};
    const addCheck = (check: PreflightCheck): void => {
      checks.push(check);
      if (check.status === 'FAILED') {
        logger.error(check.message, check.details ?? {});
      } else {
        logger.debug(check.message);
      }
    };

    const dockerVersion = await this.tryCommand(['--version'], signal, 20_000);
    if (!dockerVersion.ok) {
      addCheck({
        id: 'docker',
        status: 'FAILED',
        message: 'Docker CLI is not available on PATH.',
        details: { error: dockerVersion.error },
      });
      return { ok: false, providerId: this.id, checks, metadata };
    }
    metadata['dockerVersion'] = dockerVersion.stdout.trim();
    addCheck({
      id: 'docker',
      status: 'PASSED',
      message: `Docker CLI available: ${dockerVersion.stdout.trim()}`,
    });

    const composeVersion = await this.tryCommand(['compose', 'version', '--short'], signal, 20_000);
    if (!composeVersion.ok) {
      addCheck({
        id: 'docker-compose',
        status: 'FAILED',
        message: 'Docker Compose plugin is not available (run "docker compose version").',
        details: { error: composeVersion.error, stderr: truncate(composeVersion.stderr) },
      });
      return { ok: false, providerId: this.id, checks, metadata };
    }
    const versionText = composeVersion.stdout.trim();
    metadata['composeVersion'] = versionText;
    const parsed = parseComposeVersion(versionText);
    if (
      !parsed ||
      parsed.major < MIN_COMPOSE_VERSION.major ||
      (parsed.major === MIN_COMPOSE_VERSION.major && parsed.minor < MIN_COMPOSE_VERSION.minor)
    ) {
      addCheck({
        id: 'docker-compose',
        status: 'FAILED',
        message: `Docker Compose ${versionText} is too old; UpgradeLab requires Compose ${MIN_COMPOSE_VERSION.major}.${MIN_COMPOSE_VERSION.minor}+ (for "config --format json").`,
        details: { version: versionText },
      });
    } else {
      addCheck({
        id: 'docker-compose',
        status: 'PASSED',
        message: `Docker Compose available: ${versionText}`,
      });
    }

    const server = await this.tryCommand(
      ['info', '--format', '{{.ServerVersion}}'],
      signal,
      30_000,
    );
    if (!server.ok) {
      addCheck({
        id: 'docker-daemon',
        status: 'FAILED',
        message: 'Docker daemon is not reachable.',
        details: { error: server.error, stderr: truncate(server.stderr) },
      });
    } else {
      metadata['serverVersion'] = server.stdout.trim();
      addCheck({
        id: 'docker-daemon',
        status: 'PASSED',
        message: `Docker daemon reachable (server ${server.stdout.trim()}).`,
      });
    }

    if (this.options.composeFile && server.ok) {
      try {
        const config = await this.resolveCanonicalConfig(
          this.options.composeFile,
          this.options.projectDirectory,
          this.options.composeEnv ?? {},
          signal,
        );
        addCheck({
          id: 'compose-config',
          status: 'PASSED',
          message: `Compose configuration is valid (${Object.keys(config.services).length} services).`,
        });
        const issues = analyzeComposeSecurity(config, {
          projectDirectory: this.options.projectDirectory,
          allowedMountRoots: this.options.security?.extraMountRoots ?? [],
          allowNonLoopbackPorts: this.options.security?.allowNonLoopbackPorts ?? false,
        });
        if (issues.length > 0) {
          addCheck({
            id: 'compose-security',
            status: 'FAILED',
            message: `Compose configuration is unsafe: ${issues[0]?.message ?? 'unknown issue'}`,
            details: { issues },
          });
        } else {
          addCheck({
            id: 'compose-security',
            status: 'PASSED',
            message: 'Compose configuration passed security checks.',
          });
        }
      } catch (error) {
        addCheck({
          id: 'compose-config',
          status: 'FAILED',
          message:
            error instanceof UpgradeLabError
              ? error.message
              : `Compose configuration is invalid: ${String(error)}`,
          details: {
            ...(error instanceof UpgradeLabError
              ? { code: error.code, details: error.details }
              : {}),
          },
        });
      }
    }

    this.preflightMetadata = metadata;
    return {
      ok: checks.every((check) => check.status !== 'FAILED'),
      providerId: this.id,
      checks,
      metadata,
    };
  }

  async createEnvironment(request: CreateEnvironmentRequest): Promise<EnvironmentHandle> {
    const environment = request.environment;
    const security = request.security;
    if (!request.composeFile || !request.projectDirectory) {
      throw new UpgradeLabError('Compose file and project directory are required.', {
        code: 'INTERNAL_ERROR',
      });
    }
    if (!request.projectName.startsWith('upgradelab-')) {
      throw new UpgradeLabError(
        `Refusing to create an environment with unsafe project name "${request.projectName}".`,
        {
          code: 'PROVIDER_OWNERSHIP_VIOLATION',
          details: { projectName: request.projectName },
          hint: 'UpgradeLab only manages projects whose names start with "upgradelab-".',
        },
      );
    }

    const baseConfig = await this.resolveCanonicalConfig(
      request.composeFile,
      request.projectDirectory,
      environment.composeEnv,
      request.signal,
    );
    const issues = analyzeComposeSecurity(baseConfig, {
      projectDirectory: request.projectDirectory,
      allowedMountRoots: [request.runDirectory, ...security.extraMountRoots],
      allowNonLoopbackPorts: security.allowNonLoopbackPorts,
    });
    if (issues.length > 0) {
      throw new UpgradeLabError(
        `Compose configuration violates UpgradeLab security rules: ${issues[0]?.message ?? 'unknown issue'}`,
        {
          code: 'ENVIRONMENT_UNSAFE_COMPOSE_CONFIG',
          details: { issues },
          hint: 'See SECURITY.md and docs/security/compose-hardening.md for the required configuration.',
        },
      );
    }

    const appService = environment.application.service;
    if (!baseConfig.services[appService]) {
      throw new UpgradeLabError(
        `Compose service "${appService}" configured as environment.application.service does not exist.`,
        {
          code: 'ENVIRONMENT_COMPOSE_INVALID',
          details: { service: appService, available: Object.keys(baseConfig.services) },
        },
      );
    }
    const databaseService = environment.database?.service;
    if (databaseService && !baseConfig.services[databaseService]) {
      throw new UpgradeLabError(
        `Compose service "${databaseService}" configured as environment.database.service does not exist.`,
        {
          code: 'ENVIRONMENT_COMPOSE_INVALID',
          details: { service: databaseService, available: Object.keys(baseConfig.services) },
        },
      );
    }

    const context: EnvironmentContext = {
      projectName: request.projectName,
      runId: request.runId,
      scenarioId: request.scenarioId,
      appService,
      ...(databaseService ? { databaseService } : {}),
      runDirectory: request.runDirectory,
      configFile: path.join(request.runDirectory, 'compose.generated.yaml'),
      baseConfig,
      environment,
      security,
      defaults: request.defaults,
      composeEnv: { ...environment.composeEnv },
      labels: {
        [LABEL_MANAGED]: 'true',
        [LABEL_RUN_ID]: request.runId,
        [LABEL_SCENARIO_ID]: request.scenarioId,
      },
      ports: new Map(),
      images: new Map(),
    };
    this.contexts.set(context.projectName, context);

    await this.writeGeneratedConfig(context);
    await this.composeOk(
      context,
      ['config', '--quiet'],
      {
        timeoutMs: 60_000,
        signal: request.signal,
      },
      'validate generated Compose configuration',
    );

    const services: Record<string, { name: string }> = {};
    for (const name of Object.keys(baseConfig.services)) {
      services[name] = { name };
    }
    request.logger.info('Created isolated Compose environment.', {
      projectName: context.projectName,
      services: Object.keys(services),
    });
    return {
      runId: request.runId,
      scenarioId: request.scenarioId,
      projectName: context.projectName,
      providerId: this.id,
      runDirectory: request.runDirectory,
      appService,
      ...(databaseService ? { databaseService } : {}),
      services,
      metadata: {
        composeFile: request.composeFile,
        generatedComposeFile: context.configFile,
        ...(environment.network.internal ? { network: 'internal' } : {}),
      },
    };
  }

  async startService(
    handle: EnvironmentHandle,
    request: StartServiceRequest,
  ): Promise<StartServiceResult> {
    // The first start may bring up dependencies (for example the database)
    // declared with depends_on. Later hops use replaceService so the running
    // database is never recreated between upgrades.
    return this.applyImageAndStart(handle, request, true);
  }

  async replaceService(
    handle: EnvironmentHandle,
    request: ServiceReplacementRequest,
  ): Promise<StartServiceResult> {
    return this.applyImageAndStart(handle, request, false);
  }

  private async applyImageAndStart(
    handle: EnvironmentHandle,
    request: {
      service: string;
      image: string;
      appPort?: number;
      healthcheck?: HealthcheckConfig;
      readinessTimeoutMs: number;
      signal: AbortSignal;
    },
    includeDependencies: boolean,
  ): Promise<StartServiceResult> {
    const context = this.requireContext(handle);
    if (!context.baseConfig.services[request.service]) {
      throw new UpgradeLabError(`Unknown Compose service "${request.service}".`, {
        code: 'ENVIRONMENT_COMPOSE_INVALID',
        details: { service: request.service },
      });
    }
    context.images.set(request.service, request.image);
    await this.writeGeneratedConfig(context);

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.composeOk(
          context,
          [
            'up',
            '-d',
            ...(includeDependencies ? [] : ['--no-deps']),
            '--force-recreate',
            '--pull',
            'missing',
            request.service,
          ],
          { timeoutMs: request.readinessTimeoutMs + 120_000, signal: request.signal },
          `start service "${request.service}"`,
        );
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const portConflict = /port is already allocated|address already in use/i.test(message);
        if (!portConflict || attempt === 2) {
          throw error;
        }
        this.releaseServicePorts(context, request.service);
        await this.writeGeneratedConfig(context);
      }
    }
    if (lastError) {
      throw lastError;
    }

    const containerPort = request.appPort;
    const readiness = await waitForReadiness({
      service: request.service,
      ...(request.healthcheck ? { healthcheck: request.healthcheck } : {}),
      ...(containerPort !== undefined ? { containerPort } : {}),
      timeoutMs: request.readinessTimeoutMs,
      signal: request.signal,
      getState: () => this.getServiceState(handle, request.service, request.signal),
      getEndpoint: () =>
        containerPort !== undefined
          ? this.getEndpoint(handle, request.service, containerPort, request.signal)
          : Promise.reject(new Error('no container port configured for endpoint resolution')),
      runCommand: (command, timeoutMs) =>
        this.runner.run({
          command: this.dockerCommand,
          args: [...this.composeBase(context), 'exec', '-T', request.service, ...command],
          env: context.composeEnv,
          timeoutMs,
          signal: request.signal,
        }),
    });

    const state = await this.getServiceState(handle, request.service, request.signal);
    let endpoint: Endpoint | undefined;
    if (containerPort !== undefined) {
      try {
        endpoint = await this.getEndpoint(handle, request.service, containerPort, request.signal);
      } catch {
        endpoint = undefined;
      }
    }
    const logs = await this.collectLogsSafe(context, request.service, 100, request.signal);
    return {
      service: request.service,
      image: request.image,
      ...(state.containerId ? { containerId: state.containerId } : {}),
      state,
      ...(endpoint ? { endpoint } : {}),
      readiness,
      logs,
    };
  }

  async getServiceState(
    handle: EnvironmentHandle,
    service: string,
    signal: AbortSignal,
  ): Promise<ServiceState> {
    const context = this.requireContext(handle);
    const output = await this.composeOk(
      context,
      ['ps', '--all', '--format', 'json', service],
      { timeoutMs: 30_000, signal },
      `inspect service "${service}"`,
    );
    const entries = parseComposePs(output.stdout).filter(
      (entry) => !entry.Service || entry.Service === service,
    );
    const entry = entries[0];
    if (!entry) {
      return { service, state: 'unknown', health: 'none' };
    }
    return { ...serviceStateFromPs(entry), service };
  }

  async getEndpoint(
    handle: EnvironmentHandle,
    service: string,
    containerPort: number,
    signal: AbortSignal,
  ): Promise<Endpoint> {
    const context = this.requireContext(handle);
    const output = await this.composeRaw(context, ['port', service, String(containerPort)], {
      timeoutMs: 20_000,
      signal,
    });
    if (output.exitCode !== 0) {
      throw new UpgradeLabError(
        `Unable to resolve published port ${containerPort} for service "${service}": ${truncate(output.stderr)}`,
        {
          code: 'ENVIRONMENT_CONNECTION_FAILED',
          details: { service, containerPort, exitCode: output.exitCode },
        },
      );
    }
    const parsed = parsePortOutput(output.stdout);
    if (!parsed) {
      throw new UpgradeLabError(
        `Service "${service}" does not publish container port ${containerPort}.`,
        {
          code: 'ENVIRONMENT_CONNECTION_FAILED',
          details: { service, containerPort, output: truncate(output.stdout) },
          hint: 'UpgradeLab publishes the configured application and database ports automatically; check that the service exposes them.',
        },
      );
    }
    const host =
      isLoopback(parsed.host) || parsed.host === '0.0.0.0' || parsed.host === '::'
        ? '127.0.0.1'
        : parsed.host;
    return { host, port: parsed.port, baseUrl: buildBaseUrl(host, parsed.port) };
  }

  async waitForReadiness(
    handle: EnvironmentHandle,
    service: string,
    healthcheck: HealthcheckConfig,
    containerPort: number | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ReadinessResult> {
    return waitForReadiness({
      service,
      healthcheck,
      ...(containerPort !== undefined ? { containerPort } : {}),
      timeoutMs,
      signal,
      getState: () => this.getServiceState(handle, service, signal),
      getEndpoint: () =>
        containerPort !== undefined
          ? this.getEndpoint(handle, service, containerPort, signal)
          : Promise.reject(new Error('no container port configured for endpoint resolution')),
      runCommand: (command, timeout) =>
        this.runCommand(handle, {
          service,
          command,
          timeoutMs: timeout,
          signal,
        }).then((result) => ({
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
        })),
    });
  }

  async runCommand(handle: EnvironmentHandle, request: RunCommandRequest): Promise<CommandResult> {
    const context = this.requireContext(handle);
    if (!request.command || request.command.length === 0) {
      throw new UpgradeLabError('Command must contain at least one argument.', {
        code: 'INTERNAL_ERROR',
      });
    }
    const envArgs = Object.entries(request.env ?? {}).flatMap(([key, value]) => [
      '-e',
      `${key}=${value}`,
    ]);
    const output = await this.composeRaw(
      context,
      ['exec', '-T', ...envArgs, request.service, ...request.command],
      { timeoutMs: request.timeoutMs, signal: request.signal },
    );
    return {
      command: request.command,
      exitCode: output.exitCode < 0 ? 1 : output.exitCode,
      stdout: truncate(output.stdout),
      stderr: truncate(output.stderr),
      durationMs: output.durationMs,
      timedOut: output.timedOut,
      truncated: output.stdout.length > 8_000 || output.stderr.length > 8_000,
    };
  }

  async collectLogs(handle: EnvironmentHandle, request: LogCollectionRequest): Promise<LogEntry[]> {
    const context = this.requireContext(handle);
    const output = await this.composeRaw(
      context,
      [
        'logs',
        '--no-color',
        '--timestamps',
        '--tail',
        String(request.tailLines),
        ...(request.services ?? []),
      ],
      { timeoutMs: 60_000, signal: request.signal },
    );
    if (output.exitCode !== 0) {
      throw new UpgradeLabError(`Unable to collect container logs: ${truncate(output.stderr)}`, {
        code: 'PROVIDER_COMMAND_FAILED',
        details: { exitCode: output.exitCode },
      });
    }
    return this.parseLogs(output.stdout, context);
  }

  async describeEnvironment(handle: EnvironmentHandle): Promise<Readonly<Record<string, string>>> {
    const context = this.requireContext(handle);
    return {
      ...this.preflightMetadata,
      projectName: context.projectName,
      generatedComposeFile: context.configFile,
      services: Object.keys(context.baseConfig.services).join(','),
      networkMode: context.environment.network.internal ? 'internal' : 'default',
      bindAddress: context.environment.network.bindAddress,
    };
  }

  async destroyEnvironment(
    handle: EnvironmentHandle,
    logger: ProviderLogger,
    signal?: AbortSignal,
  ): Promise<CleanupReport> {
    const startedMs = Date.now();
    const context = this.contexts.get(handle.projectName);
    if (!context) {
      return { attempted: false, succeeded: true, removed: [], durationMs: 0, warnings: [] };
    }
    const warnings: string[] = [];
    const removed: string[] = [];
    const cleanupSignal = signal ?? AbortSignal.timeout(120_000);

    if (!context.projectName.startsWith('upgradelab-')) {
      return {
        attempted: false,
        succeeded: false,
        removed,
        durationMs: Date.now() - startedMs,
        warnings: [
          'Refusing to clean up a Compose project whose name is not managed by UpgradeLab.',
        ],
        error: serializeError(
          new UpgradeLabError('Refusing to clean up an unmanaged Compose project.', {
            code: 'PROVIDER_OWNERSHIP_VIOLATION',
            details: { projectName: context.projectName },
          }),
        ),
      };
    }

    const ownership = await this.verifyOwnership(context, cleanupSignal);
    if (!ownership.ok) {
      logger.error('Refusing to clean up Compose project: ownership verification failed.', {
        projectName: context.projectName,
        reason: ownership.reason,
      });
      return {
        attempted: false,
        succeeded: false,
        removed,
        durationMs: Date.now() - startedMs,
        warnings: [ownership.reason],
        error: serializeError(
          new UpgradeLabError(`Refusing cleanup: ${ownership.reason}`, {
            code: 'PROVIDER_OWNERSHIP_VIOLATION',
            details: { projectName: context.projectName },
          }),
        ),
      };
    }

    const down = await this.composeRaw(
      context,
      [
        'down',
        '--volumes',
        '--remove-orphans',
        '--timeout',
        String(Math.ceil(context.environment.timeouts.stopMs / 1000)),
      ],
      { timeoutMs: context.environment.timeouts.stopMs + 60_000, signal: cleanupSignal },
    );
    removed.push(`compose-project:${context.projectName}`);
    if (down.exitCode !== 0) {
      warnings.push(`docker compose down exited with ${down.exitCode}: ${truncate(down.stderr)}`);
    }

    const leftovers = await this.verifyOwnership(context, cleanupSignal);
    if (!leftovers.ok) {
      warnings.push(`Cleanup verification failed: ${leftovers.reason}`);
    }

    const volumes = await this.removeOwnedVolumes(context, cleanupSignal);
    removed.push(...volumes.removed);
    warnings.push(...volumes.warnings);

    const networks = await this.removeOwnedNetworks(context, cleanupSignal);
    removed.push(...networks.removed);
    warnings.push(...networks.warnings);

    this.contexts.delete(context.projectName);
    const succeeded = down.exitCode === 0 && warnings.length === 0;
    return {
      attempted: true,
      succeeded,
      removed,
      durationMs: Date.now() - startedMs,
      warnings,
      ...(succeeded
        ? {}
        : {
            error: serializeError(
              new UpgradeLabError('Container cleanup did not fully succeed.', {
                code: 'PROVIDER_CLEANUP_FAILED',
                details: { projectName: context.projectName },
              }),
            ),
          }),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireContext(handle: EnvironmentHandle): EnvironmentContext {
    const context = this.contexts.get(handle.projectName);
    if (!context) {
      throw new UpgradeLabError(
        `No active environment found for project "${handle.projectName}".`,
        { code: 'INTERNAL_ERROR' },
      );
    }
    return context;
  }

  private composeBase(context: EnvironmentContext): string[] {
    return [
      'compose',
      '-p',
      context.projectName,
      '-f',
      context.configFile,
      '--project-directory',
      context.runDirectory,
    ];
  }

  private async composeRaw(
    context: EnvironmentContext,
    args: readonly string[],
    options: { timeoutMs: number; signal: AbortSignal },
  ): Promise<CommandOutput> {
    return this.runner.run({
      command: this.dockerCommand,
      args: [...this.composeBase(context), ...args],
      env: { ...context.composeEnv },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  }

  private async composeOk(
    context: EnvironmentContext,
    args: readonly string[],
    options: { timeoutMs: number; signal: AbortSignal },
    operation: string,
  ): Promise<CommandOutput> {
    const output = await this.composeRaw(context, args, options);
    if (output.timedOut) {
      throw new UpgradeLabError(`Timed out while trying to ${operation}.`, {
        code: 'EXECUTION_TIMEOUT',
        details: { operation, timeoutMs: options.timeoutMs },
      });
    }
    if (output.exitCode !== 0) {
      throw new UpgradeLabError(
        `Failed to ${operation} (exit code ${output.exitCode}): ${truncate(output.stderr) || truncate(output.stdout)}`,
        {
          code: 'PROVIDER_COMMAND_FAILED',
          details: { operation, exitCode: output.exitCode },
          hint: 'Run the same scenario with --verbose to inspect Docker output.',
        },
      );
    }
    return output;
  }

  private async tryCommand(
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    try {
      const output = await this.runner.run({
        command: this.dockerCommand,
        args,
        timeoutMs,
        signal,
      });
      return {
        ok: output.exitCode === 0 && !output.timedOut,
        stdout: output.stdout,
        stderr: output.stderr,
        ...(output.exitCode === 0 && !output.timedOut
          ? {}
          : { error: truncate(output.stderr) || `exit code ${output.exitCode}` }),
      };
    } catch (error) {
      return {
        ok: false,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async resolveCanonicalConfig(
    composeFile: string,
    projectDirectory: string,
    composeEnv: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<ComposeConfig> {
    const output = await this.runner.run({
      command: this.dockerCommand,
      args: [
        'compose',
        '--project-directory',
        projectDirectory,
        '-f',
        composeFile,
        'config',
        '--format',
        'json',
      ],
      env: { ...composeEnv },
      timeoutMs: 120_000,
      signal,
    });
    if (output.timedOut) {
      throw new UpgradeLabError('Timed out while validating the Docker Compose configuration.', {
        code: 'EXECUTION_TIMEOUT',
        details: { composeFile },
      });
    }
    if (output.exitCode !== 0) {
      throw new UpgradeLabError(
        `Invalid Docker Compose configuration: ${truncate(output.stderr) || truncate(output.stdout)}`,
        {
          code: 'ENVIRONMENT_COMPOSE_INVALID',
          details: { composeFile, exitCode: output.exitCode },
        },
      );
    }
    return parseComposeConfig(output.stdout, composeFile);
  }

  private requiredPorts(context: EnvironmentContext): { service: string; target: number }[] {
    const required: { service: string; target: number }[] = [];
    const appPort =
      context.environment.application.port ??
      context.environment.application.healthcheck?.port ??
      DEFAULTS.applicationPort;
    required.push({ service: context.appService, target: appPort });
    if (context.databaseService) {
      required.push({
        service: context.databaseService,
        target: context.environment.database?.port ?? DEFAULTS.databasePort,
      });
    }
    return required;
  }

  private async portFor(
    context: EnvironmentContext,
    service: string,
    target: number,
    protocol: string,
  ): Promise<number> {
    const key = `${service}:${target}/${protocol}`;
    const existing = context.ports.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const port = await this.allocateHostPort(context.environment.network.bindAddress);
    context.ports.set(key, port);
    return port;
  }

  private allocateHostPort(bindAddress: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const host = bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress;
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen({ host, port: 0 }, () => {
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        server.close(() => {
          if (port > 0) {
            resolve(port);
          } else {
            reject(new Error('Unable to allocate a host port.'));
          }
        });
      });
    });
  }

  private releaseServicePorts(context: EnvironmentContext, service: string): void {
    for (const key of [...context.ports.keys()]) {
      if (key.startsWith(`${service}:`)) {
        context.ports.delete(key);
      }
    }
  }

  private async buildGeneratedConfig(context: EnvironmentContext): Promise<ComposeConfig> {
    const config = await canonicalizeComposeConfig(context.baseConfig, {
      bindAddress: context.environment.network.bindAddress,
      resources: context.environment.resources,
      internalNetwork: context.environment.network.internal,
      labels: context.labels,
      requiredPorts: this.requiredPorts(context),
      dropBuildFor: [...context.images.keys()],
      resolvePort: (service, target, protocol) => this.portFor(context, service, target, protocol),
    });
    for (const [service, image] of context.images) {
      const target = config.services[service];
      if (target) {
        target.image = image;
        delete (target as ComposeService).build;
      }
    }
    context.config = config;
    return config;
  }

  private async writeGeneratedConfig(context: EnvironmentContext): Promise<void> {
    const config = await this.buildGeneratedConfig(context);
    const text = stringify(escapeComposeInterpolation(config), { lineWidth: 0 });
    const temporary = `${context.configFile}.tmp`;
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, context.configFile);
  }

  private parseLogs(output: string, context: EnvironmentContext): LogEntry[] {
    const entries: LogEntry[] = [];
    const knownServices = Object.keys(context.baseConfig.services).sort(
      (a, b) => b.length - a.length,
    );
    for (const rawLine of output.split(/\r?\n/)) {
      if (rawLine.length === 0) {
        continue;
      }
      const prefixMatch = /^([A-Za-z0-9_.-]+)\s+\|\s?(.*)$/.exec(rawLine);
      let service = 'unknown';
      let rest = rawLine;
      if (prefixMatch) {
        const prefix = prefixMatch[1] ?? '';
        rest = prefixMatch[2] ?? '';
        service =
          knownServices.find((name) => prefix === name || prefix.startsWith(`${name}-`)) ?? prefix;
      }
      const timestampMatch = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/.exec(rest);
      const at = timestampMatch?.[1] ?? new Date().toISOString();
      const message = timestampMatch?.[2] ?? rest;
      entries.push({ at, service, stream: 'stdout', message });
    }
    return entries;
  }

  private async collectLogsSafe(
    context: EnvironmentContext,
    service: string,
    tailLines: number,
    signal: AbortSignal,
  ): Promise<LogEntry[]> {
    try {
      const output = await this.composeRaw(
        context,
        ['logs', '--no-color', '--timestamps', '--tail', String(tailLines), service],
        { timeoutMs: 30_000, signal },
      );
      if (output.exitCode !== 0) {
        return [];
      }
      return this.parseLogs(output.stdout, context);
    } catch {
      return [];
    }
  }

  private async verifyOwnership(
    context: EnvironmentContext,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; reason: string }> {
    const list = await this.runner.run({
      command: this.dockerCommand,
      args: [
        'ps',
        '-a',
        '--filter',
        `label=${COMPOSE_PROJECT_LABEL}=${context.projectName}`,
        '--format',
        '{{.ID}}',
      ],
      timeoutMs: 30_000,
      signal,
    });
    if (list.exitCode !== 0) {
      return {
        ok: false,
        reason: `Unable to verify container ownership (docker ps exited with ${list.exitCode}).`,
      };
    }
    const ids = list.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const id of ids) {
      const inspect = await this.runner.run({
        command: this.dockerCommand,
        args: ['inspect', '--format', '{{json .Config.Labels}}', id],
        timeoutMs: 20_000,
        signal,
      });
      if (inspect.exitCode !== 0) {
        return { ok: false, reason: `Unable to inspect container ${id}.` };
      }
      let labels: Record<string, string> = {};
      try {
        labels = JSON.parse(inspect.stdout) as Record<string, string>;
      } catch {
        return { ok: false, reason: `Container ${id} has unreadable labels.` };
      }
      if (labels[LABEL_MANAGED] !== 'true' || labels[LABEL_RUN_ID] !== context.runId) {
        return {
          ok: false,
          reason: `Container ${id} belongs to project "${context.projectName}" but is not labelled for run "${context.runId}".`,
        };
      }
    }
    return { ok: true, reason: ids.length === 0 ? 'no containers remain' : 'ownership verified' };
  }

  private async removeOwnedVolumes(
    context: EnvironmentContext,
    signal: AbortSignal,
  ): Promise<{ removed: string[]; warnings: string[] }> {
    const removed: string[] = [];
    const warnings: string[] = [];
    const list = await this.runner.run({
      command: this.dockerCommand,
      args: [
        'volume',
        'ls',
        '--filter',
        `label=${COMPOSE_PROJECT_LABEL}=${context.projectName}`,
        '--format',
        '{{.Name}}',
      ],
      timeoutMs: 30_000,
      signal,
    });
    if (list.exitCode !== 0) {
      warnings.push('Unable to list leftover project volumes.');
      return { removed, warnings };
    }
    for (const name of list.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      const inspect = await this.runner.run({
        command: this.dockerCommand,
        args: ['volume', 'inspect', '--format', '{{json .Labels}}', name],
        timeoutMs: 20_000,
        signal,
      });
      if (inspect.exitCode !== 0) {
        warnings.push(`Unable to inspect volume ${name}; leaving it in place.`);
        continue;
      }
      let labels: Record<string, string> = {};
      try {
        labels = JSON.parse(inspect.stdout) as Record<string, string>;
      } catch {
        warnings.push(`Volume ${name} has unreadable labels; leaving it in place.`);
        continue;
      }
      if (labels[LABEL_RUN_ID] !== context.runId) {
        warnings.push(`Volume ${name} is not owned by this run; leaving it in place.`);
        continue;
      }
      const removal = await this.runner.run({
        command: this.dockerCommand,
        args: ['volume', 'rm', name],
        timeoutMs: 30_000,
        signal,
      });
      if (removal.exitCode === 0) {
        removed.push(`volume:${name}`);
      } else {
        warnings.push(`Unable to remove volume ${name}.`);
      }
    }
    return { removed, warnings };
  }

  private async removeOwnedNetworks(
    context: EnvironmentContext,
    signal: AbortSignal,
  ): Promise<{ removed: string[]; warnings: string[] }> {
    const removed: string[] = [];
    const warnings: string[] = [];
    const list = await this.runner.run({
      command: this.dockerCommand,
      args: [
        'network',
        'ls',
        '--filter',
        `label=${COMPOSE_PROJECT_LABEL}=${context.projectName}`,
        '--format',
        '{{.Name}}',
      ],
      timeoutMs: 30_000,
      signal,
    });
    if (list.exitCode !== 0) {
      return { removed, warnings };
    }
    for (const name of list.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      const removal = await this.runner.run({
        command: this.dockerCommand,
        args: ['network', 'rm', name],
        timeoutMs: 30_000,
        signal,
      });
      if (removal.exitCode === 0) {
        removed.push(`network:${name}`);
      } else {
        warnings.push(`Unable to remove network ${name}; it may already be gone.`);
      }
    }
    return { removed, warnings };
  }
}

export function createDockerComposeProvider(
  options: DockerComposeProviderOptions,
): DockerComposeProvider {
  return new DockerComposeProvider(options);
}

export type { SecurityIssue, StructuredLogger };
