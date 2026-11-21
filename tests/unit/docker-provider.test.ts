import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DockerComposeProvider,
  type CommandOutput,
  type CommandRunner,
  type CommandSpec,
  type ComposeConfig,
} from '@upgradelab/docker-compose-provider';
import {
  DEFAULTS,
  UpgradeLabError,
  type EnvironmentConfig,
  type SecurityConfig,
} from '@upgradelab/contracts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'upgradelab-provider-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function output(overrides: Partial<CommandOutput> = {}): CommandOutput {
  return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, ...overrides };
}

class ScriptedRunner implements CommandRunner {
  readonly calls: CommandSpec[] = [];

  constructor(
    private readonly handler: (spec: CommandSpec) => CommandOutput | Promise<CommandOutput>,
  ) {}

  async run(spec: CommandSpec): Promise<CommandOutput> {
    this.calls.push(spec);
    return this.handler(spec);
  }

  count(predicate: (spec: CommandSpec) => boolean): number {
    return this.calls.filter(predicate).length;
  }
}

const userCompose: ComposeConfig = {
  name: 'user-project',
  services: {
    app: {
      image: 'app:1.0.0',
      container_name: 'user-app',
      volumes: [{ type: 'volume', source: 'app-data', target: '/data' }],
    },
    db: { image: 'postgres:16-alpine' },
  },
  networks: { default: {} },
};

function hasArg(spec: CommandSpec, value: string): boolean {
  return spec.args.includes(value);
}

function isComposeCall(spec: CommandSpec): boolean {
  return spec.args[0] === 'compose';
}

function isProjectComposeCall(spec: CommandSpec): boolean {
  return isComposeCall(spec) && hasArg(spec, '-p');
}

interface RunnerState {
  upCalls: number;
  downCalls: number;
  psCalls: number;
  failFirstUp?: boolean;
  labels?: Record<string, string>;
}

function defaultRunner(state: RunnerState = { upCalls: 0, downCalls: 0, psCalls: 0 }): {
  runner: ScriptedRunner;
  state: RunnerState;
} {
  const runner = new ScriptedRunner((spec) => {
    const { args } = spec;
    if (args.join(' ') === '--version') {
      return output({ stdout: 'Docker version 27.0.0, build deadbeef\n' });
    }
    if (args.join(' ') === 'compose version --short') {
      return output({ stdout: '2.30.1\n' });
    }
    if (args[0] === 'info') {
      return output({ stdout: '27.0.0\n' });
    }
    if (isComposeCall(spec) && !hasArg(spec, '-p') && args.includes('config')) {
      return output({ stdout: JSON.stringify(userCompose) });
    }
    if (isProjectComposeCall(spec) && args.includes('up')) {
      state.upCalls += 1;
      if (state.failFirstUp && state.upCalls === 1) {
        return output({ exitCode: 1, stderr: 'bind: port is already allocated' });
      }
      return output({ stdout: 'started' });
    }
    if (isProjectComposeCall(spec) && hasArg(spec, 'ps') && args.includes('json')) {
      return output({
        stdout: JSON.stringify([
          { Service: 'app', State: 'running', Health: 'healthy', ID: 'container-1', Status: 'Up' },
        ]),
      });
    }
    if (isProjectComposeCall(spec) && hasArg(spec, 'ps')) {
      state.psCalls += 1;
      return output({ stdout: state.psCalls > 1 ? '' : 'container-1\n' });
    }
    if (args[0] === 'ps') {
      state.psCalls += 1;
      return output({ stdout: state.psCalls > 1 ? '' : 'container-1\n' });
    }
    if (args[0] === 'inspect') {
      return output({
        stdout: JSON.stringify(
          state.labels ?? {
            'upgradelab.managed': 'true',
            'upgradelab.run-id': 'run-1',
            'upgradelab.scenario-id': 'scenario-1',
          },
        ),
      });
    }
    if (isProjectComposeCall(spec) && hasArg(spec, 'port')) {
      return output({ stdout: '127.0.0.1:49153\n' });
    }
    if (isProjectComposeCall(spec) && hasArg(spec, 'logs')) {
      return output({
        stdout: 'app  | 2024-01-01T00:00:00.000Z database migration applied\n',
      });
    }
    if (isProjectComposeCall(spec) && hasArg(spec, 'down')) {
      state.downCalls += 1;
      return output();
    }
    if (args[0] === 'volume' || args[0] === 'network') {
      return output();
    }
    return output();
  });
  return { runner, state };
}

const security: SecurityConfig = {
  allowNonLoopbackPorts: false,
  allowConfigPlugins: false,
  extraMountRoots: [],
};

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

const environment: EnvironmentConfig = {
  provider: 'docker-compose',
  composeFile: '/workspace/app/docker-compose.yml',
  application: {
    service: 'app',
    port: 3000,
    healthcheck: { type: 'http', path: '/health', intervalMs: 1_000, timeoutMs: 30_000 },
  },
  database: {
    service: 'db',
    adapter: 'postgres',
    port: 5432,
    database: 'upgradelab',
    user: 'upgradelab',
    password: 'upgradelab',
    ssl: false,
    connectionTimeoutMs: 10_000,
    statementTimeoutMs: 5_000,
    maxRows: 100,
  },
  resources: { memoryLimit: '1g', cpus: 1, pidsLimit: 128 },
  network: { bindAddress: '127.0.0.1', internal: false },
  timeouts: { startMs: 60_000, readinessMs: 60_000, stopMs: 10_000, commandMs: 30_000 },
  composeEnv: {},
};

function createRequest(runDirectory: string, overrides: { environment?: EnvironmentConfig } = {}) {
  return {
    runId: 'run-1',
    scenarioId: 'scenario-1',
    projectName: 'upgradelab-run-1-scenario-1',
    runDirectory,
    composeFile: '/workspace/app/docker-compose.yml',
    projectDirectory: '/workspace/app',
    environment: overrides.environment ?? environment,
    security,
    defaults: DEFAULTS,
    signal: new AbortController().signal,
    logger,
  };
}

describe('docker compose provider', () => {
  it('passes preflight only when Docker, Compose 2.20+ and a daemon are available', async () => {
    const { runner } = defaultRunner();
    const provider = new DockerComposeProvider({
      composeFile: '/workspace/app/docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    const report = await provider.preflight(logger, new AbortController().signal);
    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.status === 'PASSED')).toBe(true);
    expect(report.metadata['composeVersion']).toBe('2.30.1');
    expect(runner.calls.every((call) => call.command === 'docker')).toBe(true);
  });

  it('fails preflight with an actionable message when Docker is missing', async () => {
    const runner = new ScriptedRunner(() => {
      throw new UpgradeLabError('docker not found', { code: 'ENVIRONMENT_DOCKER_MISSING' });
    });
    const provider = new DockerComposeProvider({
      composeFile: 'docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    const report = await provider.preflight(logger, new AbortController().signal);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.id).toBe('docker');
    expect(report.checks[0]?.status).toBe('FAILED');
  });

  it('rejects Compose versions without JSON config support', async () => {
    const runner = new ScriptedRunner((spec) => {
      if (spec.args.join(' ') === '--version') {
        return output({ stdout: 'Docker version 25.0.0' });
      }
      if (spec.args.join(' ') === 'compose version --short') {
        return output({ stdout: '2.19.0' });
      }
      return output({ stdout: '25.0.0' });
    });
    const provider = new DockerComposeProvider({
      composeFile: 'docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    const report = await provider.preflight(logger, new AbortController().signal);
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'docker-compose')?.status).toBe('FAILED');
  });

  it('creates a hardened, run-owned compose file', async () => {
    const { runner } = defaultRunner();
    const runDirectory = await temporaryDirectory();
    const provider = new DockerComposeProvider({
      composeFile: '/workspace/app/docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    const handle = await provider.createEnvironment(createRequest(runDirectory));
    const generatedPath = handle.metadata['generatedComposeFile'] ?? '';
    expect(generatedPath).toBe(path.join(runDirectory, 'compose.generated.yaml'));
    const generated = parseYaml(await readFile(generatedPath, 'utf8')) as ComposeConfig;
    const app = generated.services['app'];
    expect(app?.container_name).toBeUndefined();
    expect(app?.labels).toMatchObject({
      'upgradelab.managed': 'true',
      'upgradelab.run-id': 'run-1',
      'upgradelab.scenario-id': 'scenario-1',
    });
    expect(app?.mem_limit).toBe('1g');
    expect(app?.pids_limit).toBe(128);
    expect(app?.security_opt).toContain('no-new-privileges:true');
    expect(app?.ports?.[0]).toMatchObject({ target: 3000, host_ip: '127.0.0.1' });
    expect(generated.services['db']?.ports?.[0]).toMatchObject({
      target: 5432,
      host_ip: '127.0.0.1',
    });
    const projectCalls = runner.calls.filter(isProjectComposeCall);
    expect(projectCalls.length).toBeGreaterThan(0);
    expect(projectCalls.every((call) => call.args.includes('upgradelab-run-1-scenario-1'))).toBe(
      true,
    );
  });

  it('starts a service, resolves its endpoint and collects logs', async () => {
    const { runner } = defaultRunner();
    const runDirectory = await temporaryDirectory();
    const provider = new DockerComposeProvider({
      composeFile: '/workspace/app/docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    const handle = await provider.createEnvironment(createRequest(runDirectory));
    const started = await provider.startService(handle, {
      service: 'app',
      image: 'app:2.0.0',
      appPort: 3000,
      readinessTimeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(started.state.state).toBe('running');
    expect(started.state.health).toBe('healthy');
    expect(started.readiness.ready).toBe(true);
    expect(started.endpoint).toEqual({
      host: '127.0.0.1',
      port: 49_153,
      baseUrl: 'http://127.0.0.1:49153',
    });
    expect(started.logs[0]?.message).toContain('database migration applied');
    const up = runner.calls.find((call) => isProjectComposeCall(call) && call.args.includes('up'));
    expect(up?.args).toContain('--force-recreate');
    expect(up?.args).not.toContain('--no-deps');
    expect(up?.args.slice(-1)).toEqual(['app']);
    const generated = parseYaml(
      await readFile(handle.metadata['generatedComposeFile'] ?? '', 'utf8'),
    ) as ComposeConfig;
    expect(generated.services['app']?.image).toBe('app:2.0.0');
    expect(generated.services['app']?.build).toBeUndefined();
  });

  it('starts dependencies with the source and never recreates them on a hop', async () => {
    const { runner } = defaultRunner();
    const runDirectory = await temporaryDirectory();
    const provider = new DockerComposeProvider({
      composeFile: '/workspace/app/docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    const handle = await provider.createEnvironment(createRequest(runDirectory));
    await provider.startService(handle, {
      service: 'app',
      image: 'app:1.0.0',
      readinessTimeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    await provider.replaceService(handle, {
      service: 'app',
      image: 'app:2.0.0',
      readinessTimeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    const ups = runner.calls.filter(
      (call) => isProjectComposeCall(call) && call.args.includes('up'),
    );
    expect(ups).toHaveLength(2);
    expect(ups[0]?.args).not.toContain('--no-deps');
    expect(ups[1]?.args).toContain('--no-deps');
  });

  it('retries once when a host port is allocated concurrently', async () => {
    const { runner, state } = defaultRunner();
    state.failFirstUp = true;
    const runDirectory = await temporaryDirectory();
    const provider = new DockerComposeProvider({
      composeFile: '/workspace/app/docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    const handle = await provider.createEnvironment(createRequest(runDirectory));
    const started = await provider.startService(handle, {
      service: 'app',
      image: 'app:1.0.0',
      readinessTimeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(started.state.state).toBe('running');
    expect(state.upCalls).toBe(2);
  });

  it('passes command arguments as an argument array and never through a shell', async () => {
    const { runner } = defaultRunner();
    const runDirectory = await temporaryDirectory();
    const provider = new DockerComposeProvider({
      composeFile: '/workspace/app/docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    const handle = await provider.createEnvironment(createRequest(runDirectory));
    await provider.runCommand(handle, {
      service: 'app',
      command: ['sh', '-c', 'echo hi; rm -rf /tmp/upgradelab'],
      env: { FOO: 'bar; rm -rf /' },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    const exec = runner.calls.find(
      (call) => isProjectComposeCall(call) && call.args.includes('exec'),
    );
    expect(exec?.args).toEqual([
      'compose',
      '-p',
      'upgradelab-run-1-scenario-1',
      '-f',
      handle.metadata['generatedComposeFile'],
      '--project-directory',
      runDirectory,
      'exec',
      '-T',
      '-e',
      'FOO=bar; rm -rf /',
      'app',
      'sh',
      '-c',
      'echo hi; rm -rf /tmp/upgradelab',
    ]);
    expect(exec?.command).toBe('docker');
  });

  it('removes only resources whose labels prove ownership', async () => {
    const { runner, state } = defaultRunner();
    const runDirectory = await temporaryDirectory();
    const provider = new DockerComposeProvider({
      composeFile: '/workspace/app/docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    const handle = await provider.createEnvironment(createRequest(runDirectory));
    await provider.startService(handle, {
      service: 'app',
      image: 'app:1.0.0',
      readinessTimeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    const cleanup = await provider.destroyEnvironment(handle, logger);
    expect(cleanup.succeeded).toBe(true);
    expect(cleanup.removed).toContain('compose-project:upgradelab-run-1-scenario-1');
    expect(state.downCalls).toBe(1);
    const down = runner.calls.find(
      (call) => isProjectComposeCall(call) && call.args.includes('down'),
    );
    expect(down?.args).toContain('--volumes');
    expect(down?.args).toContain('--remove-orphans');
  });

  it('refuses cleanup when container labels do not match the run', async () => {
    const { runner, state } = defaultRunner({
      upCalls: 0,
      downCalls: 0,
      psCalls: 0,
      labels: { 'upgradelab.managed': 'true', 'upgradelab.run-id': 'another-run' },
    });
    const runDirectory = await temporaryDirectory();
    const provider = new DockerComposeProvider({
      composeFile: '/workspace/app/docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    const handle = await provider.createEnvironment(createRequest(runDirectory));
    const cleanup = await provider.destroyEnvironment(handle, logger);
    expect(cleanup.succeeded).toBe(false);
    expect(cleanup.attempted).toBe(false);
    expect(cleanup.error?.code).toBe('PROVIDER_OWNERSHIP_VIOLATION');
    expect(state.downCalls).toBe(0);
  });

  it('refuses to create environments for unmanaged project names', async () => {
    const { runner } = defaultRunner();
    const provider = new DockerComposeProvider({
      composeFile: '/workspace/app/docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    await expect(
      provider.createEnvironment({
        ...createRequest(await temporaryDirectory()),
        projectName: 'user-project',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_OWNERSHIP_VIOLATION' });
  });

  it('rejects unsafe Compose configurations before starting anything', async () => {
    const runner = new ScriptedRunner((spec) => {
      if (isComposeCall(spec) && !hasArg(spec, '-p')) {
        return output({
          stdout: JSON.stringify({
            services: {
              app: { image: 'app:1.0.0', privileged: true },
              db: { image: 'postgres:16' },
            },
          }),
        });
      }
      return output();
    });
    const runDirectory = await temporaryDirectory();
    const provider = new DockerComposeProvider({
      composeFile: '/workspace/app/docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    await expect(provider.createEnvironment(createRequest(runDirectory))).rejects.toMatchObject({
      code: 'ENVIRONMENT_UNSAFE_COMPOSE_CONFIG',
    });
    expect(runner.count((call) => call.args.includes('up'))).toBe(0);
  });

  it('rejects a missing application service with the available service names', async () => {
    const { runner } = defaultRunner();
    const provider = new DockerComposeProvider({
      composeFile: '/workspace/app/docker-compose.yml',
      projectDirectory: '/workspace/app',
      runner,
    });
    try {
      await provider.createEnvironment(
        createRequest(await temporaryDirectory(), {
          environment: { ...environment, application: { service: 'missing' } },
        }),
      );
      throw new Error('expected failure');
    } catch (error) {
      expect((error as UpgradeLabError).code).toBe('ENVIRONMENT_COMPOSE_INVALID');
      expect((error as UpgradeLabError).details).toMatchObject({ available: ['app', 'db'] });
    }
  });
});
