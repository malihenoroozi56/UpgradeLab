import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  executeDoctor,
  executeInit,
  executePluginList,
  executeReport,
  executeValidate,
  executeVersion,
} from '@upgradelab/cli';
import { UpgradeLabError } from '@upgradelab/contracts';
import { parseConfigText } from '@upgradelab/config';
import { createCapturedUi } from '../helpers/ui.js';
import { sampleReport } from '../helpers/report.js';

const temporaryDirectories: string[] = [];

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'upgradelab-cli-'));
  temporaryDirectories.push(directory);
  await writeFile(
    path.join(directory, 'docker-compose.yml'),
    [
      'services:',
      '  app:',
      '    image: app:1.0.0',
      '  db:',
      '    image: postgres:16-alpine',
      '',
    ].join('\n'),
    'utf8',
  );
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const logLevel = 'silent' as const;

describe('upgradelab init', () => {
  it('writes a configuration that the loader accepts', async () => {
    const cwd = await projectDirectory();
    const { ui } = createCapturedUi();
    const outcome = await executeInit({ cwd, force: false, projectName: 'demo-app' }, ui);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.created).toBe(true);
    const text = await readFile(path.join(cwd, 'upgradelab.yaml'), 'utf8');
    const parsed = parseConfigText(text, { sourcePath: 'upgradelab.yaml', env: {} });
    expect(parsed.config.project.name).toBe('demo-app');
    expect(parsed.config.environment.composeFile).toBe('./docker-compose.yml');
    expect(parsed.config.scenarios.length).toBeGreaterThan(0);
  });

  it('refuses to overwrite an existing configuration without --force', async () => {
    const cwd = await projectDirectory();
    const { ui } = createCapturedUi();
    await executeInit({ cwd, force: false }, ui);
    await expect(executeInit({ cwd, force: false }, ui)).rejects.toMatchObject({
      code: 'CONFIG_VALIDATION_ERROR',
    });
    const overwritten = await executeInit({ cwd, force: true }, ui);
    expect(overwritten.created).toBe(false);
  });
});

describe('upgradelab validate', () => {
  it('validates a generated configuration without starting containers', async () => {
    const cwd = await projectDirectory();
    const { ui } = createCapturedUi();
    await executeInit({ cwd, force: false }, ui);
    const outcome = await executeValidate({ cwd, scenarios: [], pluginPaths: [], logLevel }, ui);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.scenarios).toHaveLength(1);
    expect(outcome.scenarios[0]?.invariants).toBeGreaterThan(0);
  });

  it('rejects unknown scenario ids', async () => {
    const cwd = await projectDirectory();
    const { ui } = createCapturedUi();
    await executeInit({ cwd, force: false }, ui);
    await expect(
      executeValidate({ cwd, scenarios: ['nope'], pluginPaths: [], logLevel }, ui),
    ).rejects.toMatchObject({ code: 'CONFIG_VALIDATION_ERROR' });
  });

  it('reports a missing configuration file', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'upgradelab-empty-'));
    temporaryDirectories.push(cwd);
    const { ui } = createCapturedUi();
    await expect(
      executeValidate({ cwd, scenarios: [], pluginPaths: [], logLevel }, ui),
    ).rejects.toMatchObject({ code: 'CONFIG_NOT_FOUND' });
  });
});

describe('upgradelab plugin list', () => {
  it('lists built-in capabilities and loaded plugins', async () => {
    const cwd = await projectDirectory();
    const { ui, stdout } = createCapturedUi(true);
    await executeInit({ cwd, force: false }, ui);
    const builtin = await executePluginList({ cwd, pluginPaths: [], logLevel }, ui);
    expect(builtin.exitCode).toBe(0);
    expect(builtin.plugins).toEqual([]);
    expect(builtin.assertionTypes).toContain('http');
    expect(builtin.assertionTypes).toContain('sql');
    expect(builtin.reportFormats).toEqual(['json', 'junit', 'markdown']);

    const pluginPath = path.resolve(import.meta.dirname, '../fixtures/plugins/valid.mjs');
    const withPlugin = await executePluginList({ cwd, pluginPaths: [pluginPath], logLevel }, ui);
    expect(withPlugin.plugins.map((plugin) => plugin.name)).toEqual(['fixture-plugin']);
    expect(withPlugin.assertionTypes).toContain('fixture-check');
    expect(withPlugin.reportFormats).toContain('fixture-text');
    expect(stdout()).toContain('fixture-plugin');
  });
});

describe('upgradelab report', () => {
  it('re-renders an existing JSON report in another format', async () => {
    const cwd = await projectDirectory();
    const report = sampleReport();
    const reportFile = path.join(cwd, 'report.json');
    await writeFile(reportFile, JSON.stringify(report), 'utf8');
    const { ui } = createCapturedUi(true);
    const outcome = await executeReport(
      {
        cwd,
        file: reportFile,
        formats: ['markdown', 'junit'],
        outputDirectory: 'out',
        pluginPaths: [],
        logLevel,
      },
      ui,
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.outputs).toHaveLength(2);
    expect(outcome.outputs.every((file) => file.startsWith(path.join(cwd, 'out')))).toBe(true);
    const markdown = await readFile(
      outcome.outputs.find((file) => file.endsWith('.md')) ?? '',
      'utf8',
    );
    expect(markdown).toContain('sample-app');
  });

  it('prints a report to stdout when no output directory is given', async () => {
    const cwd = await projectDirectory();
    await writeFile(path.join(cwd, 'report.json'), JSON.stringify(sampleReport()), 'utf8');
    const { ui, stdout } = createCapturedUi(true);
    const outcome = await executeReport(
      { cwd, file: 'report.json', formats: ['json'], pluginPaths: [], logLevel },
      ui,
    );
    expect(outcome.exitCode).toBe(0);
    expect(JSON.parse(stdout()).report.schemaVersion).toBe(1);
  });

  it('rejects malformed report files with an actionable error', async () => {
    const cwd = await projectDirectory();
    await writeFile(path.join(cwd, 'broken.json'), '{ not json', 'utf8');
    const { ui } = createCapturedUi();
    await expect(
      executeReport({ cwd, file: 'broken.json', formats: ['json'], pluginPaths: [], logLevel }, ui),
    ).rejects.toMatchObject({ code: 'CONFIG_PARSE_ERROR' });
    await writeFile(path.join(cwd, 'wrong.json'), JSON.stringify({ schemaVersion: 99 }), 'utf8');
    try {
      await executeReport(
        { cwd, file: 'wrong.json', formats: ['json'], pluginPaths: [], logLevel },
        ui,
      );
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeLabError);
      expect((error as UpgradeLabError).code).toBe('CONFIG_UNSUPPORTED_VERSION');
    }
  });
});

describe('upgradelab doctor', () => {
  it('reports each prerequisite with a machine-readable status', async () => {
    const cwd = await projectDirectory();
    const { ui } = createCapturedUi(true);
    await executeInit({ cwd, force: false }, ui);
    const outcome = await executeDoctor(
      { cwd, pluginPaths: [], logLevel, signal: new AbortController().signal },
      ui,
    );
    expect(outcome.checks.find((check) => check.id === 'node')?.status).toBe('PASSED');
    expect(outcome.checks.find((check) => check.id === 'config')?.status).toBe('PASSED');
    expect(outcome.checks.find((check) => check.id === 'ai')?.status).toBe('PASSED');
    if (process.env['UPGRADELAB_EXPECT_DOCKER'] === '1') {
      expect(outcome.checks.find((check) => check.id === 'docker')?.status).toBe('PASSED');
    }
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(3);
    } else {
      expect(outcome.exitCode).toBe(0);
    }
  });
});

describe('upgradelab version', () => {
  it('prints a semantic version', () => {
    const { ui, stdout } = createCapturedUi(true);
    const outcome = executeVersion(ui);
    expect(outcome.name).toBe('upgradelab');
    const parsed = JSON.parse(stdout()) as {
      ok: boolean;
      name: string;
      version: string;
      node: string;
    };
    expect(parsed.name).toBe('upgradelab');
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(parsed.node).toContain(process.version);
  });
});
