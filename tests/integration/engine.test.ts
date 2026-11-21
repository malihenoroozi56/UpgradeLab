import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ExecutionEngine } from '@upgradelab/core';
import type { EngineRunResult } from '@upgradelab/core';
import type { FakeEnvironmentProvider, FakeImage } from '../helpers/fake-environment.js';
import {
  buildConfigYaml,
  buildTestRuntime,
  type BuildConfigOptions,
} from '../helpers/test-runtime.js';

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface RunOptions extends BuildConfigOptions {
  readonly images?: Record<string, FakeImage>;
  readonly failQueries?: readonly string[];
  readonly failQueriesAfterUpgrade?: boolean;
  readonly logLines?: readonly string[];
  readonly abortAfterMs?: number;
  readonly destroyFails?: boolean;
  readonly setupFails?: boolean;
}

async function runScenario(options: RunOptions = {}): Promise<{
  result: EngineRunResult;
  provider: FakeEnvironmentProvider;
}> {
  const configYaml = buildConfigYaml(options);
  const test = buildTestRuntime({
    configYaml,
    ...(options.images ? { images: options.images } : {}),
    ...(options.failQueries ? { failQueries: options.failQueries } : {}),
    ...(options.failQueriesAfterUpgrade ? { failQueriesAfterUpgrade: true } : {}),
    ...(options.destroyFails ? { destroyFails: true } : {}),
    ...(options.logLines ? { logLines: options.logLines } : {}),
  });
  const runRoot = await mkdtemp(path.join(os.tmpdir(), 'upgradelab-engine-'));
  temporaryDirectories.push(runRoot);
  const engine = new ExecutionEngine({
    provider: test.provider,
    checkRunner: test.runtime.checkRunner,
    redactor: test.runtime.redactor,
    logger: test.runtime.logger,
    config: test.runtime.config,
    composeFile: test.runtime.loaded.composeFile,
    projectDirectory: test.runtime.loaded.projectDirectory,
    ...(test.runtime.databaseAdapter ? { databaseAdapter: test.runtime.databaseAdapter } : {}),
    runRoot,
  });
  const controller = new AbortController();
  if (options.abortAfterMs !== undefined) {
    setTimeout(() => {
      controller.abort(new Error('test cancellation'));
    }, options.abortAfterMs).unref();
  }
  const result = await engine.run({
    scenarios: test.runtime.config.scenarios,
    configPath: test.runtime.loaded.configPath,
    signal: controller.signal,
    runId: 'run-test',
  });
  return { result, provider: test.provider };
}

function checkById(result: EngineRunResult, id: string) {
  const scenario = result.scenarios[0];
  const check = scenario?.checks.find((entry) => entry.id === id);
  if (!check) {
    throw new Error(`Check ${id} not found`);
  }
  return check;
}

describe('execution engine with a real provider contract', () => {
  it('passes a valid upgrade and preserves data across container replacement', async () => {
    const { result, provider } = await runScenario({
      logLines: ['migration 002 applied successfully'],
    });
    expect(result.status).toBe('PASSED');
    expect(result.scenarios).toHaveLength(1);
    const scenario = result.scenarios[0];
    expect(scenario?.status).toBe('PASSED');
    expect(scenario?.sourceImage).toBe('app:1.0.0');
    expect(scenario?.targetImage).toBe('app:2.0.0');
    expect(scenario?.counts.failed).toBe(0);
    expect(scenario?.counts.total).toBe(7);
    expect(provider.seedCount).toBe(1);
    expect(provider.startedImages).toEqual(['app:1.0.0', 'app:2.0.0']);
    expect(provider.destroyCount).toBe(1);
    // The target migration really ran on the seeded data.
    expect(checkById(result, 'email-column-present').status).toBe('PASSED');
    expect(scenario?.logs.some((entry) => entry.message.includes('migration'))).toBe(true);
    expect(scenario?.evidence.length).toBeGreaterThan(0);
    expect(scenario?.cleanup.succeeded).toBe(true);
    // A baseline was captured and compared.
    const balance = checkById(result, 'balance-preserved');
    expect(balance.kind).toBe('invariant');
    expect(balance.baseline).toBe(1000);
    expect(balance.actual).toBe(1000);
  });

  it('detects a data-loss migration and reports it as FAILED', async () => {
    const { result, provider } = await runScenario({ to: 'app:2.0.0-broken' });
    expect(result.status).toBe('FAILED');
    const scenario = result.scenarios[0];
    expect(scenario?.status).toBe('FAILED');
    const balance = checkById(result, 'balance-preserved');
    expect(balance.status).toBe('FAILED');
    expect(balance.message).toContain('violated');
    expect(balance.expected).toBe(1000);
    expect(balance.actual).toBe(600);
    const email = checkById(result, 'email-column-present');
    expect(email.status).toBe('FAILED');
    expect(email.expected).toBe(1);
    expect(email.actual).toBe(0);
    // Users survived, so the surviving-data check still passes: the report
    // pinpoints exactly which invariant broke.
    expect(checkById(result, 'users-preserved').status).toBe('PASSED');
    // The application still served /health, proving startup is not proof.
    expect(checkById(result, 'application-healthy').status).toBe('PASSED');
    expect(provider.destroyCount).toBe(1);
  });

  it('treats a target release that cannot start as FAILED', async () => {
    const { result } = await runScenario({ to: 'app:2.0.0-crash' });
    expect(result.status).toBe('FAILED');
    expect(result.scenarios[0]?.error?.code).toBe('ENVIRONMENT_NOT_READY');
  });

  it('treats a source release that cannot start as INCONCLUSIVE', async () => {
    const { result } = await runScenario({ from: 'app:1.0.0-crash' });
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.scenarios[0]?.error?.code).toBe('ENVIRONMENT_NOT_READY');
  });

  it('never reports PASSED when no checks were evaluated', async () => {
    const { result } = await runScenario({ invariants: [], assertions: [] });
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.scenarios[0]?.checks).toHaveLength(0);
  });

  it('returns INCONCLUSIVE on scenario timeout and still cleans up', async () => {
    const { result, provider } = await runScenario({
      to: 'app:2.0.0-slow',
      scenarioTimeoutMs: 250,
    });
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.scenarios[0]?.error?.code).toBe('EXECUTION_TIMEOUT');
    expect(provider.destroyCount).toBe(1);
    expect(result.scenarios[0]?.cleanup.succeeded).toBe(true);
  });

  it('returns CANCELLED when the caller aborts', async () => {
    const { result, provider } = await runScenario({
      to: 'app:2.0.0-slow',
      abortAfterMs: 150,
    });
    expect(result.status).toBe('CANCELLED');
    expect(result.cancelled).toBe(true);
    expect(provider.destroyCount).toBe(1);
  });

  it('reports setup command failure as INCONCLUSIVE', async () => {
    const { result, provider } = await runScenario({ setupFails: true });
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.scenarios[0]?.error?.code).toBe('PROVIDER_COMMAND_FAILED');
    expect(provider.startedImages).toEqual(['app:1.0.0']);
  });

  it('stops before upgrading when a pre-upgrade assertion fails', async () => {
    const { result, provider } = await runScenario({
      sourceAssertions: [{ id: 'source-healthy', type: 'http', path: '/missing' }],
    });
    expect(result.status).toBe('FAILED');
    expect(provider.startedImages).toEqual(['app:1.0.0']);
    expect(result.scenarios[0]?.error?.code).toBe('ASSERTION_FAILED');
  });

  it('runs a multi-hop path and keeps data through every hop', async () => {
    const { result, provider } = await runScenario({
      path: ['app:1.0.0', 'app:1.1.0', 'app:2.0.0'],
    });
    expect(result.status).toBe('PASSED');
    expect(result.scenarios[0]?.imagePath).toEqual(['app:1.0.0', 'app:1.1.0', 'app:2.0.0']);
    expect(provider.startedImages).toEqual(['app:1.0.0', 'app:1.1.0', 'app:2.0.0']);
    expect(result.scenarios[0]?.hops).toHaveLength(3);
    expect(result.scenarios[0]?.hops[2]?.ready).toBe(true);
  });

  it('classifies an unhealthy target as FAILED', async () => {
    const { result } = await runScenario({ to: 'app:2.0.0-unhealthy' });
    expect(result.status).toBe('FAILED');
    expect(result.scenarios[0]?.error?.code).toBe('ENVIRONMENT_NOT_READY');
  });

  it('marks an invariant FAILED when its SQL breaks after the upgrade', async () => {
    const { result } = await runScenario({
      to: 'app:2.0.0-broken',
      failQueries: ['information_schema'],
      failQueriesAfterUpgrade: true,
    });
    const email = checkById(result, 'email-column-present');
    expect(email.status).toBe('FAILED');
    expect(email.message).toContain('failed after the upgrade');
    expect(result.status).toBe('FAILED');
  });

  it('records an ERROR check when the baseline query fails', async () => {
    const { result } = await runScenario({ failQueries: ['sum(balance)'] });
    const balance = checkById(result, 'balance-preserved');
    expect(balance.status).toBe('ERROR');
    expect(result.status).toBe('INCONCLUSIVE');
  });

  it('surfaces cleanup failure in the report without hiding the verdict', async () => {
    const { result } = await runScenario({ destroyFails: true });
    expect(result.status).toBe('PASSED');
    expect(result.cleanupFailed).toBe(true);
    expect(result.scenarios[0]?.cleanup.succeeded).toBe(false);
    expect(result.scenarios[0]?.cleanup.warnings).toContain('simulated cleanup failure');
  });

  it('runs without a database for HTTP-only verification', async () => {
    const { result } = await runScenario({
      database: false,
      invariants: [],
      assertions: [{ id: 'health-only', type: 'health' }],
    });
    expect(result.status).toBe('PASSED');
    expect(result.scenarios[0]?.checks).toHaveLength(1);
  });
});

describe('scenario status aggregation through the engine', () => {
  it('keeps optional failing assertions from failing the run', async () => {
    const { result } = await runScenario({
      assertions: [
        { id: 'optional-check', type: 'http', path: '/missing', required: false },
        { id: 'health', type: 'health' },
      ],
    });
    expect(result.status).toBe('PASSED');
    expect(checkById(result, 'optional-check').status).toBe('FAILED');
    expect(checkById(result, 'optional-check').required).toBe(false);
  });
});
