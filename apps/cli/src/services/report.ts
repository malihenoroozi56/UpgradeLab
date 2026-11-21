import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { EXIT_CODES, UpgradeLabError, redactText } from '@upgradelab/contracts';
import { createRuntime } from '../runtime.js';
import { parseRequestBody } from './report-file.js';
import { renderTable, type Ui } from '../ui.js';

export interface ReportFlags {
  readonly cwd: string;
  readonly file?: string;
  readonly formats: readonly string[];
  readonly outputDirectory?: string;
  readonly pluginPaths: readonly string[];
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export interface ReportOutcome {
  readonly exitCode: number;
  readonly file: string;
  readonly outputs: readonly string[];
}

async function findLatestReport(cwd: string): Promise<string> {
  const root = path.join(cwd, '.upgradelab', 'reports');
  let directories: string[];
  try {
    directories = await readdir(root);
  } catch {
    throw new UpgradeLabError(`No UpgradeLab reports found under ${root}.`, {
      code: 'CONFIG_NOT_FOUND',
      details: { directory: root },
      hint: 'Run "upgradelab run" first, or pass --file <report.json>.',
    });
  }
  const candidates: { file: string; mtime: number }[] = [];
  for (const directory of directories) {
    const file = path.join(root, directory, 'upgradelab-report.json');
    try {
      const info = await stat(file);
      if (info.isFile()) {
        candidates.push({ file, mtime: info.mtimeMs });
      }
    } catch {
      // Not every directory contains a JSON report.
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const latest = candidates[0];
  if (!latest) {
    throw new UpgradeLabError(`No JSON reports found under ${root}.`, {
      code: 'CONFIG_NOT_FOUND',
      details: { directory: root },
      hint: 'Run "upgradelab run" first.',
    });
  }
  return latest.file;
}

/** `upgradelab report` re-renders an existing report without running tests. */
export async function executeReport(flags: ReportFlags, ui: Ui): Promise<ReportOutcome> {
  const file = flags.file ? path.resolve(flags.cwd, flags.file) : await findLatestReport(flags.cwd);
  const report = await parseRequestBody(file);

  let reporters;
  if (flags.pluginPaths.length > 0) {
    const runtime = await createRuntime({
      cwd: flags.cwd,
      pluginPaths: flags.pluginPaths,
      logLevel: flags.logLevel,
    });
    reporters = runtime.reporters;
  } else {
    const { createReporterRegistry } = await import('@upgradelab/reporters');
    reporters = createReporterRegistry();
  }

  const resolved = reporters.resolveMany(flags.formats.length > 0 ? flags.formats : ['markdown']);
  const outputs: string[] = [];

  if (flags.outputDirectory) {
    const { writeReports } = await import('@upgradelab/reporters');
    const { createRedactor } = await import('@upgradelab/contracts');
    const { createLogger } = await import('@upgradelab/core');
    const redactor = createRedactor();
    const written = await writeReports(
      report,
      {
        outputDirectory: path.resolve(flags.cwd, flags.outputDirectory),
        formats: resolved.map((reporter) => reporter.format),
        redactor,
        logger: createLogger({ level: 'warn', redactor }),
      },
      reporters,
    );
    outputs.push(...written.files.map((entry) => entry.path));
    if (!ui.json) {
      for (const entry of written.files) {
        ui.line(`${entry.format.padEnd(9)} ${entry.path}`);
      }
    }
  } else if (!ui.json) {
    for (const [index, reporter] of resolved.entries()) {
      const rendered = reporter.render(report);
      if (index > 0) {
        ui.line('');
      }
      ui.line(rendered.trimEnd());
    }
  }

  if (ui.json) {
    ui.line(
      JSON.stringify(
        {
          ok: true,
          file,
          status: report.run.status,
          formats: resolved.map((reporter) => reporter.format),
          outputs,
          ...(outputs.length === 0 ? { report } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    ui.line('');
    ui.line(
      renderTable(
        [
          ['Project', report.project.name],
          ['Run', report.run.id],
          ['Status', report.run.status],
          ['Scenarios', String(report.scenarios.length)],
        ],
        ['Field', 'Value'],
      ),
    );
  }
  return { exitCode: EXIT_CODES.OK, file, outputs };
}

export { redactText };
