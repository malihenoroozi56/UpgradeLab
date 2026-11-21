import { Writable } from 'node:stream';
import { stringify } from 'yaml';
import { parseConfigText } from '@upgradelab/config';
import { createRedactor, type UpgradeLabConfig } from '@upgradelab/contracts';
import { createLogger } from '@upgradelab/core';
import { createCheckRunner } from '@upgradelab/assertion-engine';
import { createReporterRegistry } from '@upgradelab/reporters';
import type { Runtime } from '@upgradelab/cli';
import {
  FakeDatabaseAdapter,
  FakeEnvironmentProvider,
  type FakeImage,
} from './fake-environment.js';

export const DEFAULT_IMAGES: Record<string, FakeImage> = {
  'app:1.0.0': { version: '1.0.0' },
  'app:1.1.0': {
    version: '1.1.0',
    migrate: (store) => {
      store.auditLog = true;
    },
  },
  'app:2.0.0': {
    version: '2.0.0',
    migrate: (store) => {
      store.auditLog = true;
      for (const user of store.users) {
        user.emailVerified = false;
      }
    },
  },
  'app:2.0.0-broken': {
    version: '2.0.0-broken',
    migrate: (store) => {
      // Data loss: drops a financial record and removes the email column.
      store.accounts = store.accounts.slice(0, 1);
      for (const user of store.users) {
        delete (user as { email?: string }).email;
      }
    },
  },
  'app:2.0.0-unhealthy': {
    version: '2.0.0-unhealthy',
    migrate: () => undefined,
    healthy: false,
  },
  'app:2.0.0-crash': { version: '2.0.0-crash', failStart: true },
  'app:1.0.0-crash': { version: '1.0.0-crash', failStart: true },
  'app:2.0.0-slow': { version: '2.0.0-slow', startDelayMs: 1_500 },
};

export const DEFAULT_INVARIANTS = [
  {
    id: 'users-preserved',
    type: 'sql',
    query: 'SELECT COUNT(*) FROM users',
    comparison: 'equal-before-after',
  },
  {
    id: 'balance-preserved',
    type: 'sql',
    query: 'SELECT COALESCE(SUM(balance), 0) FROM accounts',
    comparison: 'numeric-equal-before-after',
    tolerance: 0,
  },
  {
    id: 'email-column-present',
    type: 'sql',
    query:
      "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email'",
    comparison: 'equal',
    expected: 1,
  },
];

export const DEFAULT_ASSERTIONS = [
  { id: 'application-healthy', type: 'http', path: '/health', expectedStatus: 200 },
  { id: 'database-available', type: 'sql', query: 'SELECT 1', expected: 1 },
  { id: 'container-running', type: 'container', target: 'app', state: 'healthy' },
  { id: 'stats-users', type: 'http', path: '/stats', jsonPath: 'users', jsonEquals: 3 },
];

export interface BuildConfigOptions {
  readonly from?: string;
  readonly to?: string;
  readonly path?: readonly string[];
  readonly setup?: boolean;
  readonly invariants?: readonly unknown[];
  readonly assertions?: readonly unknown[];
  readonly scenarioTimeoutMs?: number;
  readonly healthcheck?: boolean;
  readonly database?: boolean;
  readonly extraSteps?: readonly Record<string, unknown>[];
  readonly sourceAssertions?: readonly unknown[];
  readonly setupFails?: boolean;
}

/** Builds a valid configuration document as YAML for tests. */
export function buildConfigYaml(options: BuildConfigOptions = {}): string {
  const fromImage = options.from ?? 'app:1.0.0';
  const toImage = options.to ?? 'app:2.0.0';
  const usePath = options.path !== undefined;
  const setup =
    options.setup === false
      ? []
      : [
          {
            target: 'app',
            command: options.setupFails ? ['fail-seed'] : ['node', 'scripts/seed.mjs'],
          },
        ];

  const scenario: Record<string, unknown> = {
    id: 'upgrade-1-to-2',
    description: 'Test upgrade from the source release to the target release.',
    ...(options.scenarioTimeoutMs ? { timeoutMs: options.scenarioTimeoutMs } : {}),
    ...(usePath
      ? {
          path: options.path.map((image, index) => ({
            image,
            ...(index === 0 && setup.length > 0 ? { setup } : {}),
          })),
        }
      : {
          from: {
            image: fromImage,
            ...(setup.length > 0 ? { setup } : {}),
            ...(options.sourceAssertions ? { assertions: options.sourceAssertions } : {}),
          },
          to: {
            image: toImage,
            ...(options.extraSteps?.[0] ?? {}),
          },
        }),
    invariants: options.invariants ?? DEFAULT_INVARIANTS,
    assertions: options.assertions ?? DEFAULT_ASSERTIONS,
  };

  const config: Record<string, unknown> = {
    schemaVersion: 1,
    project: { name: 'test-app' },
    environment: {
      provider: 'docker-compose',
      composeFile: './docker-compose.yml',
      application: {
        service: 'app',
        port: 3000,
        ...(options.healthcheck === false
          ? {}
          : {
              healthcheck: {
                type: 'http',
                path: '/health',
                timeoutMs: 1_000,
                intervalMs: 100,
              },
            }),
      },
      ...(options.database === false
        ? {}
        : { database: { service: 'db', adapter: 'postgres', maxRows: 100 } }),
      resources: { memoryLimit: '1g', cpus: 1, pidsLimit: 128 },
    },
    defaults: {
      scenarioTimeoutMs: options.scenarioTimeoutMs ?? 15_000,
      assertionTimeoutMs: 5_000,
      logTailLines: 100,
    },
    scenarios: [scenario],
  };
  return stringify(config, { lineWidth: 0 });
}

const silentStream = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

export interface TestRuntimeOptions {
  readonly configYaml: string;
  readonly images?: Record<string, FakeImage>;
  readonly failQueries?: readonly string[];
  readonly failQueriesAfterUpgrade?: boolean;
  readonly destroyFails?: boolean;
  readonly logLines?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface TestRuntime {
  readonly runtime: Runtime;
  readonly provider: FakeEnvironmentProvider;
  readonly adapter: FakeDatabaseAdapter;
  readonly config: UpgradeLabConfig;
}

/** Builds a Runtime wired to the in-memory provider and SQL executor. */
export function buildTestRuntime(options: TestRuntimeOptions): TestRuntime {
  const parsed = parseConfigText(options.configYaml, {
    sourcePath: 'tests/fixtures/upgradelab.test.yaml',
    env: options.env ?? {},
  });
  const redactor = createRedactor({ secrets: parsed.secrets });
  const logger = createLogger({
    level: 'silent',
    redactor,
    destination: silentStream,
  });
  const provider = new FakeEnvironmentProvider({
    images: options.images ?? DEFAULT_IMAGES,
    ...(options.logLines ? { logLines: options.logLines } : {}),
    ...(options.destroyFails ? { destroyFails: options.destroyFails } : {}),
  });
  const adapter = new FakeDatabaseAdapter(provider, {
    ...(options.failQueries ? { failOn: options.failQueries } : {}),
    ...(options.failQueriesAfterUpgrade ? { failAfterUpgrade: true } : {}),
  });
  const config = parsed.config;
  const runtime: Runtime = {
    config,
    loaded: {
      config,
      configPath: 'tests/fixtures/upgradelab.test.yaml',
      configDirectory: process.cwd(),
      composeFile: 'tests/fixtures/docker-compose.fixture.yml',
      projectDirectory: process.cwd(),
      secrets: parsed.secrets,
      configHash: 'test-config-hash',
      rawText: options.configYaml,
      warnings: parsed.warnings,
    },
    logger,
    redactor,
    plugins: {
      loaded: [],
      assertionHandlers: [],
      databaseAdapters: [],
      environmentProviders: [],
      reporters: [],
    },
    reporters: createReporterRegistry(),
    provider,
    databaseAdapter: config.environment.database ? adapter : undefined,
    checkRunner: createCheckRunner(),
  };
  return { runtime, provider, adapter, config };
}
