import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ReporterRegistry, writeReports } from '@upgradelab/reporters';
import { createRedactor, type StructuredLogger } from '@upgradelab/contracts';
import { sampleReport, sampleScenario } from '../helpers/report.js';

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const logger: StructuredLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

const LITERAL_SECRET = 's3cr3t-value-9f8e7d';
const BEARER_TOKEN = 'abcdefghijklmnop';
const GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

describe('report redaction', () => {
  it('removes secrets from every report format', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'upgradelab-secrets-'));
    temporaryDirectories.push(directory);
    const report = sampleReport({
      scenario: {
        checks: [
          {
            ...sampleScenario().checks[0]!,
            message: `Connection postgres://upgradelab:${LITERAL_SECRET}@db:5432/upgradelab failed`,
            error: {
              name: 'UpgradeLabError',
              code: 'ASSERTION_ERROR',
              category: 'ASSERTION',
              message: `Authorization: Bearer ${BEARER_TOKEN}`,
            },
          },
        ],
        logs: [
          {
            at: '2024-01-01T00:00:06.000Z',
            service: 'app',
            stream: 'stderr',
            message: `token=${GITHUB_TOKEN} password=${LITERAL_SECRET}`,
          },
        ],
        setup: [
          {
            id: 'setup-1',
            target: 'source',
            command: ['node', 'seed.mjs'],
            status: 'PASSED',
            exitCode: 0,
            durationMs: 10,
            stdout: `API_KEY=${LITERAL_SECRET}`,
            stderr: `Authorization: Bearer ${BEARER_TOKEN}`,
            evidenceIds: [],
          },
        ],
        evidence: [
          {
            id: 'ev-1',
            kind: 'log',
            description: 'target logs',
            createdAt: '2024-01-01T00:00:09.000Z',
            bytes: 42,
            truncated: false,
            inline: `postgres://user:${LITERAL_SECRET}@db/app`,
          },
        ],
        environment: {
          provider: 'docker-compose',
          projectName: 'upgradelab-run-1',
          composeFile: 'docker-compose.yml',
          metadata: { DSN: `postgres://u:${LITERAL_SECRET}@db/app` },
        },
      },
    });
    const result = await writeReports(report, {
      outputDirectory: directory,
      formats: ['json', 'markdown', 'junit'],
      redactor: createRedactor({ secrets: [LITERAL_SECRET] }),
      logger,
    });
    for (const file of result.files) {
      const content = await readFile(file.path, 'utf8');
      expect(content, `${file.format} report leaked the literal secret`).not.toContain(
        LITERAL_SECRET,
      );
      expect(content, `${file.format} report leaked the bearer token`).not.toContain(BEARER_TOKEN);
      expect(content, `${file.format} report leaked the GitHub token`).not.toContain(GITHUB_TOKEN);
      expect(content).toContain('[REDACTED]');
    }
    expect(result.report.scenarios[0]?.logs[0]?.message).toContain('[REDACTED]');
  });

  it('does not let plugins bypass redaction', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'upgradelab-plugin-report-'));
    temporaryDirectories.push(directory);
    const report = sampleReport({
      scenario: {
        logs: [
          {
            at: '2024-01-01T00:00:06.000Z',
            service: 'app',
            stream: 'stdout',
            message: `dsn=postgres://u:${LITERAL_SECRET}@db/app`,
          },
        ],
      },
    });
    const result = await writeReports(
      report,
      {
        outputDirectory: directory,
        formats: ['json'],
        redactor: createRedactor({ secrets: [LITERAL_SECRET] }),
        logger,
      },
      (() => {
        const registry = new ReporterRegistry();
        registry.register({
          format: 'leaky',
          fileExtension: 'leaky.txt',
          render: (value) => JSON.stringify(value),
        });
        return registry;
      })(),
    );
    const content = await readFile(result.files[0]?.path ?? '', 'utf8');
    expect(content).not.toContain(LITERAL_SECRET);
  });
});
