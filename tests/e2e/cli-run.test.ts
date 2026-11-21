import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { executeRunWithRuntime, type RunFlags } from '@upgradelab/cli';
import {
  buildConfigYaml,
  buildTestRuntime,
  type TestRuntimeOptions,
} from '../helpers/test-runtime.js';
import { createCapturedUi } from '../helpers/ui.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runCli(
  options: TestRuntimeOptions,
  flagOverrides: Partial<RunFlags> = {},
  json = false,
): Promise<{
  outcome: Awaited<ReturnType<typeof executeRunWithRuntime>>;
  stdout: string;
  stderr: string;
}> {
  const test = buildTestRuntime(options);
  const captured = createCapturedUi(json);
  const outputDirectory = await temporaryDirectory('upgradelab-reports-');
  const outcome = await executeRunWithRuntime(
    {
      cwd: process.cwd(),
      configPath: 'tests/fixtures/upgradelab.test.yaml',
      scenarios: [],
      reportFormats: ['json', 'markdown', 'junit'],
      outputDirectory,
      noReport: false,
      ai: false,
      pluginPaths: [],
      logLevel: 'silent',
      keepRunDirectory: false,
      signal: new AbortController().signal,
      ...flagOverrides,
    },
    captured.ui,
    test.runtime,
  );
  return { outcome, stdout: captured.stdout(), stderr: captured.stderr() };
}

describe('upgradelab run end to end', () => {
  it('writes JSON, Markdown and JUnit reports for a passing upgrade', async () => {
    const { outcome, stdout } = await runCli({ configYaml: buildConfigYaml() });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.status).toBe('PASSED');
    expect(outcome.files.map((file) => file.format).sort()).toEqual(['json', 'junit', 'markdown']);
    const jsonReport = outcome.files.find((file) => file.format === 'json');
    const markdown = outcome.files.find((file) => file.format === 'markdown');
    const junit = outcome.files.find((file) => file.format === 'junit');
    expect(jsonReport).toBeDefined();
    const json = JSON.parse(await readFile(jsonReport?.path ?? '', 'utf8')) as {
      schemaVersion: number;
      run: { status: string; id: string };
      scenarios: { status: string; checks: unknown[] }[];
      ai: { enabled: boolean };
    };
    expect(json.schemaVersion).toBe(1);
    expect(json.run.status).toBe('PASSED');
    expect(json.scenarios[0]?.status).toBe('PASSED');
    expect(json.scenarios[0]?.checks.length).toBe(7);
    expect(json.ai.enabled).toBe(false);
    const markdownText = await readFile(markdown?.path ?? '', 'utf8');
    expect(markdownText).toContain('PASSED');
    expect(markdownText).toContain('users-preserved');
    const junitText = await readFile(junit?.path ?? '', 'utf8');
    expect(junitText).toContain('<testsuites');
    expect(junitText).toContain('tests="8"');
    expect(junitText).not.toContain('<failure');
    expect(stdout).toContain('PASSED');
    expect(outcome.report.run.status).toBe('PASSED');
  });

  it('exits 1 and preserves failure evidence for a data-loss migration', async () => {
    const { outcome } = await runCli({ configYaml: buildConfigYaml({ to: 'app:2.0.0-broken' }) });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.status).toBe('FAILED');
    const jsonFile = outcome.files.find((file) => file.format === 'json');
    const report = JSON.parse(await readFile(jsonFile?.path ?? '', 'utf8')) as {
      scenarios: { checks: { id: string; status: string; message: string }[] }[];
    };
    const failed = report.scenarios[0]?.checks.filter((check) => check.status === 'FAILED') ?? [];
    expect(failed.map((check) => check.id).sort()).toEqual([
      'balance-preserved',
      'email-column-present',
    ]);
    expect(failed[0]?.message.length).toBeGreaterThan(10);
    const junitFile = outcome.files.find((file) => file.format === 'junit');
    const junitText = await readFile(junitFile?.path ?? '', 'utf8');
    expect(junitText).toContain('<failure');
  });

  it('prints a single machine-readable document in --json mode', async () => {
    const { stdout } = await runCli(
      { configYaml: buildConfigYaml({ to: 'app:2.0.0-broken' }) },
      {},
      true,
    );
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      status: string;
      runId: string;
      scenarios: { id: string; status: string }[];
      reports: unknown[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe('FAILED');
    expect(parsed.runId).toMatch(/^run-test|^[0-9]/);
    expect(parsed.scenarios[0]?.status).toBe('FAILED');
    expect(parsed.reports.length).toBe(3);
  });

  it('exits 3 when cleanup fails even though the upgrade passed', async () => {
    const { outcome } = await runCli({
      configYaml: buildConfigYaml(),
      destroyFails: true,
    });
    expect(outcome.status).toBe('PASSED');
    expect(outcome.exitCode).toBe(3);
    expect(outcome.report.scenarios[0]?.cleanup.succeeded).toBe(false);
  });

  it('honours version overrides from the CLI', async () => {
    const { outcome } = await runCli(
      { configYaml: buildConfigYaml() },
      { fromImage: 'app:1.0.0', toImage: 'app:1.1.0' },
    );
    expect(outcome.status).toBe('PASSED');
    expect(outcome.report.scenarios[0]?.targetImage).toBe('app:1.1.0');
  });

  it('reports INCONCLUSIVE with exit code 7 when nothing is verified', async () => {
    const { outcome } = await runCli({
      configYaml: buildConfigYaml({ invariants: [], assertions: [] }),
    });
    expect(outcome.status).toBe('INCONCLUSIVE');
    expect(outcome.exitCode).toBe(7);
  });
});
