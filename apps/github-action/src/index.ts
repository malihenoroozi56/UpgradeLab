import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as core from '@actions/core';
import { Ui } from '@upgradelab/cli';
import { executeRun, type RunOutcome } from '@upgradelab/cli';
import { ExitCodeGuard } from './guard.js';

function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getBoolean(name: string, fallback = false): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (raw === '') {
    return fallback;
  }
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function getTimeout(name: string): number | undefined {
  const raw = core.getInput(name).trim();
  if (raw === '') {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Input "${name}" must be a positive integer number of milliseconds.`);
  }
  return parsed;
}

async function writeSummary(outcome: RunOutcome): Promise<void> {
  const markdown = outcome.files.find((file) => file.format === 'markdown');
  if (!markdown) {
    return;
  }
  try {
    const content = await readFile(markdown.path, 'utf8');
    await core.summary.addRaw(content, true).write();
  } catch (error) {
    core.warning(
      `Unable to render the job summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function run(): Promise<void> {
  const workingDirectory =
    core.getInput('working-directory') || process.env['GITHUB_WORKSPACE'] || process.cwd();
  const config = core.getInput('config') || 'upgradelab.yaml';
  const outputDirectory = path.resolve(
    workingDirectory,
    core.getInput('output-dir') || '.upgradelab/reports',
  );
  const formats = parseList(core.getInput('report-formats') || 'json,markdown,junit');
  const failOn = new Set(
    parseList(core.getInput('fail-on') || 'failed,inconclusive').map((entry) =>
      entry.toUpperCase(),
    ),
  );
  const timeoutMs = getTimeout('timeout');
  const ai = getBoolean('ai');
  const aiProvider = core.getInput('ai-provider');
  const aiModel = core.getInput('ai-model');
  const plugins = parseList(core.getInput('plugin'));
  const scenarios = parseList(core.getInput('scenarios'));

  const controller = new AbortController();
  const ui = new Ui({ json: false, color: false });

  const guard = new ExitCodeGuard(ui);
  const outcome = await guard.run(() =>
    executeRun(
      {
        cwd: path.resolve(workingDirectory),
        configPath: config,
        scenarios,
        ...(core.getInput('from-image') ? { fromImage: core.getInput('from-image') } : {}),
        ...(core.getInput('to-image') ? { toImage: core.getInput('to-image') } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        reportFormats: formats,
        outputDirectory,
        noReport: false,
        ai,
        ...(aiProvider ? { aiProvider } : {}),
        ...(aiModel ? { aiModel } : {}),
        pluginPaths: plugins,
        logLevel: getBoolean('verbose') ? 'debug' : 'info',
        keepRunDirectory: false,
        signal: controller.signal,
      },
      ui,
    ),
  );

  core.setOutput('run-id', outcome.runId);
  core.setOutput('status', outcome.status);
  core.setOutput('report-dir', outputDirectory);
  for (const format of ['json', 'markdown', 'junit']) {
    const file = outcome.files.find((entry) => entry.format === format);
    if (file) {
      core.setOutput(`${format}-report`, file.path);
    }
  }

  await writeSummary(outcome);

  if (failOn.has(outcome.status)) {
    core.setFailed(`UpgradeLab run ${outcome.runId} finished with status ${outcome.status}.`);
  } else if (outcome.status !== 'PASSED') {
    core.warning(`UpgradeLab run ${outcome.runId} finished with status ${outcome.status}.`);
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
