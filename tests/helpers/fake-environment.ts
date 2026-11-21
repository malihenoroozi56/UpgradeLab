import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  UpgradeLabError,
  type CleanupReport,
  type CommandResult,
  type CreateEnvironmentRequest,
  type DatabaseAdapter,
  type DatabaseConnection,
  type DatabaseTarget,
  type QueryOptions,
  type Endpoint,
  type EnvironmentHandle,
  type EnvironmentProvider,
  type HealthcheckConfig,
  type LogEntry,
  type LogCollectionRequest,
  type PreflightReport,
  type QueryResult,
  type ReadinessResult,
  type RunCommandRequest,
  type ServiceReplacementRequest,
  type ServiceState,
  type SqlScalar,
  type StartServiceRequest,
  type StartServiceResult,
  type StructuredLogger,
} from '@upgradelab/contracts';

/**
 * In-memory environment provider used by integration and end-to-end tests.
 *
 * It is a real provider implementation: containers are simulated, but HTTP
 * endpoints, data persistence across "container replacement", readiness,
 * commands, logs and cleanup behave like the Docker provider's contract. This
 * makes orchestration, verification and reporting testable without a daemon.
 */

export interface FakeUser {
  id: number;
  email: string;
  emailVerified?: boolean;
}

export interface FakeAccount {
  id: number;
  userId: number;
  balance: number;
}

export interface FakeStore {
  users: FakeUser[];
  accounts: FakeAccount[];
  auditLog: boolean;
}

export type FakeMigration = (store: FakeStore) => void;

export interface FakeImage {
  readonly version: string;
  readonly migrate?: FakeMigration;
  readonly healthy?: boolean;
  readonly failStart?: boolean;
  readonly startDelayMs?: number;
}

export interface FakeProviderOptions {
  readonly images: Readonly<Record<string, FakeImage>>;
  readonly logLines?: readonly string[];
  readonly destroyFails?: boolean;
}

interface EnvironmentState {
  readonly handle: EnvironmentHandle;
  store: FakeStore;
  server: http.Server;
  port: number;
  version: string;
  healthy: boolean;
}

export function emptyStore(): FakeStore {
  return { users: [], accounts: [], auditLog: false };
}

export function seededStore(): FakeStore {
  return {
    users: [
      { id: 1, email: 'ada@example.test' },
      { id: 2, email: 'grace@example.test' },
      { id: 3, email: 'linus@example.test' },
    ],
    accounts: [
      { id: 1, userId: 1, balance: 600 },
      { id: 2, userId: 2, balance: 400 },
    ],
    auditLog: false,
  };
}

function sumBalance(store: FakeStore): number {
  return store.accounts.reduce((total, account) => total + account.balance, 0);
}

export class FakeEnvironmentProvider implements EnvironmentProvider {
  readonly id = 'docker-compose';
  readonly description = 'In-memory test provider';

  private readonly envs = new Map<string, EnvironmentState>();
  private readonly options: FakeProviderOptions;
  private readonly logLines: readonly string[];
  destroyCount = 0;
  startedImages: string[] = [];
  seedCount = 0;
  commands: string[][] = [];

  constructor(options: FakeProviderOptions) {
    this.options = options;
    this.logLines = options.logLines ?? [];
  }

  currentStore(): FakeStore {
    const states = [...this.envs.values()];
    const state = states[states.length - 1];
    if (!state) {
      throw new UpgradeLabError('No fake environment exists.', { code: 'INTERNAL_ERROR' });
    }
    return state.store;
  }

  currentVersion(): string {
    const states = [...this.envs.values()];
    return states[states.length - 1]?.version ?? 'none';
  }

  async preflight(_logger: StructuredLogger, _signal: AbortSignal): Promise<PreflightReport> {
    return {
      ok: true,
      providerId: this.id,
      checks: [{ id: 'fake-provider', status: 'PASSED', message: 'Fake provider is ready.' }],
      metadata: { provider: 'fake' },
    };
  }

  async createEnvironment(request: CreateEnvironmentRequest): Promise<EnvironmentHandle> {
    const server = http.createServer((req, res) => {
      const state = this.envs.get(request.projectName);
      if (!state) {
        res.statusCode = 500;
        res.end('no state');
        return;
      }
      const url = req.url ?? '/';
      if (url === '/health') {
        res.statusCode = state.healthy ? 200 : 503;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ status: state.healthy ? 'ok' : 'degraded', version: state.version }),
        );
        return;
      }
      if (url === '/stats') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            users: state.store.users.length,
            balance: sumBalance(state.store),
            auditLog: state.store.auditLog,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const handle: EnvironmentHandle = {
      runId: request.runId,
      scenarioId: request.scenarioId,
      projectName: request.projectName,
      providerId: this.id,
      runDirectory: request.runDirectory,
      appService: 'app',
      databaseService: 'db',
      services: { app: { name: 'app' }, db: { name: 'db' } },
      metadata: { provider: 'fake' },
    };
    this.envs.set(request.projectName, {
      handle,
      store: emptyStore(),
      server,
      port: address.port,
      version: 'unstarted',
      healthy: true,
    });
    return handle;
  }

  private requireEnv(handle: EnvironmentHandle): EnvironmentState {
    const state = this.envs.get(handle.projectName);
    if (!state) {
      throw new UpgradeLabError('Fake environment not found.', { code: 'INTERNAL_ERROR' });
    }
    return state;
  }

  private async applyImage(
    handle: EnvironmentHandle,
    image: string,
    healthcheck: HealthcheckConfig | undefined,
  ): Promise<StartServiceResult> {
    const state = this.requireEnv(handle);
    const definition = this.options.images[image];
    if (!definition) {
      throw new UpgradeLabError(`Unknown image "${image}" in fake provider.`, {
        code: 'ENVIRONMENT_COMPOSE_INVALID',
      });
    }
    if (definition.startDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, definition.startDelayMs));
    }
    if (definition.failStart) {
      state.version = definition.version;
      state.healthy = false;
      return {
        service: 'app',
        image,
        state: { service: 'app', state: 'exited', health: 'none', exitCode: 1 },
        readiness: {
          ready: false,
          attempts: 1,
          durationMs: 1,
          lastError: `image ${image} exited immediately`,
        },
        logs: [
          {
            at: new Date().toISOString(),
            service: 'app',
            stream: 'stderr',
            message: `failed to start ${image}`,
          },
        ],
      };
    }
    definition.migrate?.(state.store);
    state.version = definition.version;
    state.healthy = definition.healthy !== false;
    this.startedImages.push(image);
    return {
      service: 'app',
      image,
      state: { service: 'app', state: 'running', health: state.healthy ? 'healthy' : 'unhealthy' },
      endpoint: {
        host: '127.0.0.1',
        port: state.port,
        baseUrl: `http://127.0.0.1:${state.port}`,
      },
      readiness: {
        ready: state.healthy,
        attempts: 1,
        durationMs: 1,
        ...(state.healthy ? {} : { lastError: 'health endpoint returned 503' }),
        ...(healthcheck ? { healthcheck } : {}),
      },
      logs: [
        {
          at: new Date().toISOString(),
          service: 'app',
          stream: 'stdout',
          message: `started ${image}`,
        },
      ],
    };
  }

  async startService(
    handle: EnvironmentHandle,
    request: StartServiceRequest,
  ): Promise<StartServiceResult> {
    return this.applyImage(handle, request.image, request.healthcheck);
  }

  async replaceService(
    handle: EnvironmentHandle,
    request: ServiceReplacementRequest,
  ): Promise<StartServiceResult> {
    return this.applyImage(handle, request.image, request.healthcheck);
  }

  async getServiceState(
    handle: EnvironmentHandle,
    service: string,
    _signal: AbortSignal,
  ): Promise<ServiceState> {
    const state = this.requireEnv(handle);
    if (state.version === 'unstarted') {
      return { service, state: 'created', health: 'none' };
    }
    return {
      service,
      state: 'running',
      health: state.healthy ? 'healthy' : 'unhealthy',
    };
  }

  async getEndpoint(
    handle: EnvironmentHandle,
    _service: string,
    _containerPort: number,
    _signal: AbortSignal,
  ): Promise<Endpoint> {
    const state = this.requireEnv(handle);
    return {
      host: '127.0.0.1',
      port: state.port,
      baseUrl: `http://127.0.0.1:${state.port}`,
    };
  }

  async waitForReadiness(
    handle: EnvironmentHandle,
    _service: string,
    healthcheck: HealthcheckConfig,
    _containerPort: number | undefined,
    _timeoutMs: number,
    _signal: AbortSignal,
  ): Promise<ReadinessResult> {
    const state = this.requireEnv(handle);
    return {
      ready: state.healthy,
      attempts: 1,
      durationMs: 1,
      ...(state.healthy ? {} : { lastError: 'health endpoint returned 503' }),
      healthcheck,
    };
  }

  async runCommand(handle: EnvironmentHandle, request: RunCommandRequest): Promise<CommandResult> {
    const state = this.requireEnv(handle);
    this.commands.push([...request.command]);
    const commandText = request.command.join(' ');
    if (commandText.startsWith('fail')) {
      return {
        command: request.command,
        exitCode: 1,
        stdout: '',
        stderr: 'command failed by request',
        durationMs: 1,
        timedOut: false,
        truncated: false,
      };
    }
    if (commandText.includes('seed.mjs')) {
      state.store = seededStore();
      this.seedCount += 1;
      return {
        command: request.command,
        exitCode: 0,
        stdout: `seeded ${state.store.users.length} users`,
        stderr: '',
        durationMs: 1,
        timedOut: false,
        truncated: false,
      };
    }
    return {
      command: request.command,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false,
    };
  }

  async collectLogs(handle: EnvironmentHandle, request: LogCollectionRequest): Promise<LogEntry[]> {
    this.requireEnv(handle);
    const lines = [
      ...this.logLines,
      `database migration applied for ${this.currentVersion()}`,
      'application started',
    ];
    return lines.slice(-request.tailLines).map((message) => ({
      at: new Date().toISOString(),
      service: 'app',
      stream: 'stdout',
      message,
    }));
  }

  async describeEnvironment(handle: EnvironmentHandle): Promise<Readonly<Record<string, string>>> {
    this.requireEnv(handle);
    return { provider: 'fake', version: this.currentVersion() };
  }

  async destroyEnvironment(
    handle: EnvironmentHandle,
    _logger: StructuredLogger,
    _signal?: AbortSignal,
  ): Promise<CleanupReport> {
    const state = this.envs.get(handle.projectName);
    if (!state) {
      return { attempted: false, succeeded: true, removed: [], durationMs: 0, warnings: [] };
    }
    this.destroyCount += 1;
    await new Promise<void>((resolve) => state.server.close(() => resolve()));
    this.envs.delete(handle.projectName);
    if (this.options.destroyFails) {
      return {
        attempted: true,
        succeeded: false,
        removed: [],
        durationMs: 1,
        warnings: ['simulated cleanup failure'],
      };
    }
    return {
      attempted: true,
      succeeded: true,
      removed: [`project:${handle.projectName}`],
      durationMs: 1,
      warnings: [],
    };
  }
}

export interface FakeDatabaseOptions {
  readonly failOn?: readonly string[];
  readonly failAfterUpgrade?: boolean;
}

/**
 * SQL executor for the fake environment.
 *
 * It understands the exact queries used by the test fixtures; any other query
 * fails loudly, so tests cannot pass by silently returning empty results.
 */
export class FakeDatabaseAdapter implements DatabaseAdapter {
  readonly id = 'postgres';
  readonly description = 'In-memory SQL executor for tests';

  constructor(
    private readonly provider: FakeEnvironmentProvider,
    private readonly options: FakeDatabaseOptions = {},
  ) {}

  validateReadOnlyQuery(query: string): void {
    if (!/^\s*(select|with)/i.test(query)) {
      throw new UpgradeLabError('Only read-only queries are allowed in tests.', {
        code: 'ASSERTION_UNSAFE_QUERY',
      });
    }
  }

  async connect(
    _target: DatabaseTarget,
    _options: QueryOptions & { connectionTimeoutMs: number; logger: StructuredLogger },
  ): Promise<DatabaseConnection> {
    const provider = this.provider;
    const adapterOptions = this.options;
    const failOn = adapterOptions.failOn ?? [];
    return {
      async execute(query: string): Promise<QueryResult> {
        const store = provider.currentStore();
        const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase();
        const failing =
          failOn.some((fragment) => normalized.includes(fragment.toLowerCase())) &&
          (!adapterOptions.failAfterUpgrade || provider.currentVersion().startsWith('2'));
        if (failing) {
          throw new UpgradeLabError('Simulated SQL failure after the upgrade.', {
            code: 'DATABASE_QUERY_FAILED',
          });
        }
        let value: SqlScalar | undefined;
        if (normalized.includes('information_schema.columns') && normalized.includes("'email'")) {
          value = store.users.length > 0 && store.users.every((user) => 'email' in user) ? 1 : 0;
        } else if (normalized.includes('count(*)') && normalized.includes('from users')) {
          value = store.users.length;
        } else if (normalized.includes('sum(balance)') && normalized.includes('from accounts')) {
          value = sumBalance(store);
        } else if (normalized.includes('count(*)') && normalized.includes('from accounts')) {
          value = store.accounts.length;
        } else if (normalized.includes('from audit_log')) {
          value = store.auditLog ? 1 : 0;
        } else if (/select\s+1\b/.test(normalized)) {
          value = 1;
        } else {
          throw new UpgradeLabError(`Fake database does not understand query: ${query}`, {
            code: 'DATABASE_QUERY_FAILED',
          });
        }
        const rows = [{ value }];
        return {
          columns: ['value'],
          rows,
          rowCount: 1,
          values: [value],
          truncated: false,
          durationMs: 1,
          executedAt: new Date().toISOString(),
        };
      },
      async dispose(): Promise<void> {
        _options.logger.debug('fake database connection closed');
      },
    };
  }
}
