import {
  countCheckStatuses,
  type CheckResult,
  type ReportDocument,
  type ScenarioReport,
} from '@upgradelab/contracts';
import { buildReportDocument, emptyAiSection } from '@upgradelab/reporters';

export function sampleCheck(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: 'users-preserved',
    kind: 'invariant',
    type: 'sql',
    required: true,
    status: 'PASSED',
    startedAt: '2024-01-01T00:00:00.000Z',
    finishedAt: '2024-01-01T00:00:01.000Z',
    durationMs: 42,
    evidenceIds: [],
    message: 'Value is unchanged from the pre-upgrade baseline (3).',
    ...overrides,
  };
}

export function sampleScenario(overrides: Partial<ScenarioReport> = {}): ScenarioReport {
  const checks = overrides.checks ?? [
    sampleCheck(),
    sampleCheck({
      id: 'application-healthy',
      kind: 'assertion',
      type: 'http',
      message: 'HTTP GET http://127.0.0.1:49152/health returned 200 as expected.',
    }),
    sampleCheck({
      id: 'container-running',
      kind: 'assertion',
      type: 'container',
      message: 'Service "app" is healthy.',
    }),
  ];
  return {
    id: 'upgrade-1-to-2',
    description: 'Upgrade from 1.0.0 to 2.0.0',
    status: 'PASSED',
    startedAt: '2024-01-01T00:00:00.000Z',
    finishedAt: '2024-01-01T00:00:10.000Z',
    durationMs: 10_000,
    sourceImage: 'app:1.0.0',
    targetImage: 'app:2.0.0',
    imagePath: ['app:1.0.0', 'app:2.0.0'],
    hops: [
      {
        index: 1,
        image: 'app:2.0.0',
        startedAt: '2024-01-01T00:00:05.000Z',
        finishedAt: '2024-01-01T00:00:08.000Z',
        durationMs: 3000,
        ready: true,
        readinessAttempts: 2,
        endpoint: 'http://127.0.0.1:49152',
      },
    ],
    setup: [
      {
        id: 'setup-1',
        target: 'source',
        command: ['node', 'scripts/seed.mjs'],
        status: 'PASSED',
        exitCode: 0,
        durationMs: 100,
        stdout: 'seeded 3 users',
        stderr: '',
        evidenceIds: [],
      },
    ],
    checks,
    counts: countCheckStatuses(checks),
    logs: [
      {
        at: '2024-01-01T00:00:06.000Z',
        service: 'app',
        stream: 'stdout',
        message: 'database migration applied for 2.0.0',
      },
    ],
    events: [
      {
        at: '2024-01-01T00:00:00.000Z',
        sequence: 1,
        type: 'phase',
        phase: 'preflight',
        message: 'starting',
      },
      {
        at: '2024-01-01T00:00:10.000Z',
        sequence: 2,
        type: 'phase',
        phase: 'completed',
        message: 'done',
      },
    ],
    evidence: [
      {
        id: 'ev-1',
        kind: 'log',
        description: 'target application log',
        inline: 'database migration applied for 2.0.0',
        truncated: false,
        bytes: 36,
        createdAt: '2024-01-01T00:00:09.000Z',
      },
    ],
    environment: {
      provider: 'docker-compose',
      projectName: 'upgradelab-run-1-upgrade-1-to-2',
      composeFile: 'docker-compose.yml',
      metadata: { generatedComposeFile: '/tmp/run/compose.generated.yaml' },
    },
    cleanup: {
      attempted: true,
      succeeded: true,
      removed: ['compose-project:upgradelab-run-1-upgrade-1-to-2'],
      durationMs: 500,
      warnings: [],
    },
    ...overrides,
  };
}

export function sampleReport(
  overrides: { scenario?: Partial<ScenarioReport> } = {},
): ReportDocument {
  const scenario = sampleScenario(overrides.scenario);
  return buildReportDocument({
    project: { name: 'sample-app', description: 'Sample upgrade fixture' },
    configPath: '/workspace/upgradelab.yaml',
    configDirectory: '/workspace',
    configHash: 'abc123',
    startedAt: '2024-01-01T00:00:00.000Z',
    finishedAt: '2024-01-01T00:00:10.000Z',
    durationMs: 10_000,
    status: scenario.status,
    scenarios: [scenario],
    runId: 'run-1',
    toolVersion: '0.1.0',
    nodeVersion: 'v22.15.0',
    platform: 'linux',
    arch: 'x64',
    ai: emptyAiSection(),
  });
}
