import { EXIT_CODES, UpgradeLabError } from '@upgradelab/contracts';
import { selectScenarios } from '@upgradelab/config';
import { createRuntime, type Runtime } from '../runtime.js';
import { renderTable, type Ui } from '../ui.js';

export interface ValidateFlags {
  readonly cwd: string;
  readonly configPath?: string;
  readonly scenarios: readonly string[];
  readonly pluginPaths: readonly string[];
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export interface ValidateOutcome {
  readonly exitCode: number;
  readonly configPath: string;
  readonly project: string;
  readonly scenarios: readonly {
    id: string;
    images: string;
    invariants: number;
    assertions: number;
  }[];
  readonly warnings: readonly string[];
}

/** `upgradelab validate` never starts containers; it is an offline check. */
export async function executeValidate(flags: ValidateFlags, ui: Ui): Promise<ValidateOutcome> {
  const runtime: Runtime = await createRuntime({
    cwd: flags.cwd,
    ...(flags.configPath ? { configPath: flags.configPath } : {}),
    pluginPaths: flags.pluginPaths,
    logLevel: flags.logLevel,
  });
  const selected = selectScenarios(runtime.config, flags.scenarios);
  for (const scenario of selected) {
    runtime.checkRunner.validateAssertions([
      ...scenario.assertions,
      ...scenario.path.flatMap((step) => step.assertions),
    ]);
    const duplicateIds = new Set<string>();
    for (const check of [...scenario.invariants, ...scenario.assertions]) {
      if (duplicateIds.has(check.id)) {
        throw new UpgradeLabError(
          `Scenario "${scenario.id}" contains duplicate check id "${check.id}".`,
          { code: 'CONFIG_VALIDATION_ERROR', details: { scenario: scenario.id, id: check.id } },
        );
      }
      duplicateIds.add(check.id);
    }
  }

  const warnings = [...runtime.loaded.warnings];
  const rows = selected.map((scenario) => ({
    id: scenario.id,
    images: scenario.path.map((step) => step.image).join(' -> '),
    invariants: scenario.invariants.length,
    assertions:
      scenario.assertions.length +
      scenario.path.reduce((total, step) => total + step.assertions.length, 0),
  }));

  if (ui.json) {
    ui.line(
      JSON.stringify(
        {
          ok: true,
          configPath: runtime.loaded.configPath,
          project: runtime.config.project.name,
          provider: runtime.config.environment.provider,
          scenarios: rows,
          warnings,
          plugins: runtime.plugins.loaded,
        },
        null,
        2,
      ),
    );
  } else {
    ui.heading('Configuration valid');
    ui.line(`File:     ${runtime.loaded.configPath}`);
    ui.line(`Project:  ${runtime.config.project.name}`);
    ui.line(`Provider: ${runtime.config.environment.provider}`);
    ui.line('');
    ui.line(
      renderTable(
        rows.map((row) => [row.id, row.images, String(row.invariants), String(row.assertions)]),
        ['Scenario', 'Upgrade path', 'Invariants', 'Assertions'],
      ),
    );
    if (runtime.plugins.loaded.length > 0) {
      ui.line('');
      ui.line(
        `Plugins: ${runtime.plugins.loaded.map((plugin) => `${plugin.name}@${plugin.version}`).join(', ')}`,
      );
    }
    for (const warning of warnings) {
      ui.warning(`warning: ${warning}`);
    }
  }

  return {
    exitCode: EXIT_CODES.OK,
    configPath: runtime.loaded.configPath,
    project: runtime.config.project.name,
    scenarios: rows,
    warnings,
  };
}
