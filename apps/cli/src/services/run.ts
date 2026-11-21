import path from 'node:path';
import {
  EXIT_CODES,
  TOOL_VERSION,
  UpgradeLabError,
  type AiAdvisory,
  type AiConfig,
  type AiReportSection,
  type ReportDocument,
  type RunStatus,
  type ScenarioConfig,
  type ScenarioReport,
} from '@upgradelab/contracts';
import { applyOverrides, selectScenarios } from '@upgradelab/config';
import {
  createLogger,
  createNullLogger,
  ExecutionEngine,
  removeRunDirectory,
  type EngineRunResult,
} from '@upgradelab/core';
import { createAiAssistant, type AiAssistant } from '@upgradelab/ai-assistant';
import { buildReportDocument, writeReports, type WrittenReportFile } from '@upgradelab/reporters';
import { createRuntime, type Runtime } from '../runtime.js';
import { formatDuration, type Ui } from '../ui.js';

export interface RunFlags {
  readonly cwd: string;
  readonly configPath?: string;
  readonly scenarios: readonly string[];
  readonly fromImage?: string;
  readonly toImage?: string;
  readonly timeoutMs?: number;
  readonly reportFormats: readonly string[];
  readonly outputDirectory?: string;
  readonly noReport: boolean;
  readonly ai: boolean;
  readonly aiProvider?: string;
  readonly aiModel?: string;
  readonly pluginPaths: readonly string[];
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
  readonly runRoot?: string;
  readonly keepRunDirectory: boolean;
  readonly signal: AbortSignal;
}

export interface RunOutcome {
  readonly exitCode: number;
  readonly status: RunStatus;
  readonly runId: string;
  readonly report: ReportDocument;
  readonly files: readonly WrittenReportFile[];
  readonly runDirectory: string;
  readonly scenarios: readonly ScenarioReport[];
}

const AI_PROVIDERS = ['openai', 'anthropic', 'gemini', 'openai-compatible'] as const;

/** Resolves the effective AI configuration, honouring explicit CLI consent. */
export function resolveAiConfig(
  base: AiConfig,
  flags: { ai: boolean; aiProvider?: string; aiModel?: string },
): AiConfig {
  let provider = base.provider;
  if (flags.aiProvider) {
    if (!(AI_PROVIDERS as readonly string[]).includes(flags.aiProvider)) {
      throw new UpgradeLabError(`Unknown AI provider "${flags.aiProvider}".`, {
        code: 'CONFIG_VALIDATION_ERROR',
        details: { provider: flags.aiProvider, supported: [...AI_PROVIDERS] },
      });
    }
    provider = flags.aiProvider as AiConfig['provider'];
  }
  const model = flags.aiModel ?? base.model;
  if (flags.ai && !base.enabled) {
    throw new UpgradeLabError(
      'AI diagnostics were requested with --ai but ai.enabled is false in the configuration.',
      {
        code: 'CONFIG_VALIDATION_ERROR',
        details: { provider },
        hint: 'Set ai.enabled: true and configure ai.model, or omit --ai.',
      },
    );
  }
  const enabled = base.enabled && flags.ai;
  if (enabled && !model) {
    throw new UpgradeLabError('AI analysis is enabled but no model is configured.', {
      code: 'CONFIG_VALIDATION_ERROR',
      details: { provider },
      hint: 'Set ai.model in the configuration or pass --ai-model.',
    });
  }
  return {
    ...base,
    provider,
    enabled,
    ...(model ? { model } : {}),
  };
}

function defaultReportDirectory(cwd: string, runId: string): string {
  return path.join(cwd, '.upgradelab', 'reports', runId);
}

function exitCodeForStatus(status: RunStatus, cleanupFailed: boolean): number {
  switch (status) {
    case 'PASSED':
      return cleanupFailed ? EXIT_CODES.ENVIRONMENT_ERROR : EXIT_CODES.OK;
    case 'FAILED':
      return EXIT_CODES.TEST_FAILED;
    case 'INCONCLUSIVE':
      return EXIT_CODES.INCONCLUSIVE;
    case 'CANCELLED':
      return EXIT_CODES.CANCELLED;
    default:
      return EXIT_CODES.INTERNAL_ERROR;
  }
}

function scenarioSummary(scenario: ScenarioReport): Record<string, unknown> {
  return {
    id: scenario.id,
    status: scenario.status,
    counts: scenario.counts,
    sourceImage: scenario.sourceImage,
    targetImage: scenario.targetImage,
    durationMs: scenario.durationMs,
    ...(scenario.error ? { error: scenario.error } : {}),
    cleanup: {
      attempted: scenario.cleanup.attempted,
      succeeded: scenario.cleanup.succeeded,
      warnings: scenario.cleanup.warnings,
    },
  };
}

async function collectAiAdvisories(options: {
  assistant: AiAssistant;
  scenarios: readonly ScenarioReport[];
  invariantQueries: readonly string[];
  signal: AbortSignal;
  logger: ReturnType<typeof createLogger>;
}): Promise<{ advisories: AiAdvisory[]; warnings: string[] }> {
  const advisories: AiAdvisory[] = [];
  const warnings: string[] = [];
  for (const scenario of options.scenarios) {
    if (scenario.status === 'PASSED') {
      continue;
    }
    const calls: { feature: string; run: () => Promise<AiAdvisory> }[] = [];
    if (options.assistant.isEnabled('explain-failure')) {
      calls.push({
        feature: 'explain-failure',
        run: () => options.assistant.explainFailure(scenario, options.signal),
      });
    }
    if (options.assistant.isEnabled('analyze-logs')) {
      calls.push({
        feature: 'analyze-logs',
        run: () => options.assistant.analyzeLogs(scenario, options.signal),
      });
    }
    if (options.assistant.isEnabled('schema-review')) {
      calls.push({
        feature: 'schema-review',
        run: () =>
          options.assistant.reviewSchemaChanges(scenario, options.invariantQueries, options.signal),
      });
    }
    if (options.assistant.isEnabled('suggest-invariants')) {
      calls.push({
        feature: 'suggest-invariants',
        run: () =>
          options.assistant.suggestInvariants(scenario, options.invariantQueries, options.signal),
      });
    }
    for (const call of calls) {
      try {
        advisories.push(await call.run());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn(`AI feature "${call.feature}" failed; ignoring its output.`, {
          error: message,
        });
        warnings.push(`AI ${call.feature} failed: ${message}`);
      }
    }
  }
  return { advisories, warnings };
}

function printSummary(options: {
  ui: Ui;
  result: EngineRunResult;
  report: ReportDocument;
  files: readonly WrittenReportFile[];
  runDirectory: string;
  keepRunDirectory: boolean;
  aiWarnings: readonly string[];
}): void {
  const { ui, result } = options;
  ui.heading(`UpgradeLab ${TOOL_VERSION}`);
  ui.line(`Run:      ${result.runId}`);
  ui.line(`Status:   ${ui.status(result.status)}`);
  ui.line(`Project:  ${options.report.project.name}`);
  ui.line(`Duration: ${formatDuration(result.durationMs)}`);
  ui.line('');
  for (const scenario of options.report.scenarios) {
    ui.line(
      `  ${ui.status(scenario.status)}  ${scenario.id}  ${scenario.sourceImage} -> ${scenario.targetImage}  (${formatDuration(scenario.durationMs)})`,
    );
    ui.line(
      ui.dim(
        `    checks: ${scenario.counts.passed} passed, ${scenario.counts.failed} failed, ${scenario.counts.errored} errored, ${scenario.counts.skipped} skipped`,
      ),
    );
    const failures = scenario.checks.filter(
      (check) => check.status === 'FAILED' || check.status === 'ERROR',
    );
    for (const check of failures.slice(0, 10)) {
      ui.line(`    ${ui.status(check.status)} ${check.id}: ${check.message ?? ''}`);
    }
    if (scenario.error) {
      ui.line(`    error: [${scenario.error.code}] ${scenario.error.message}`);
    }
    if (scenario.cleanup.warnings.length > 0) {
      for (const warning of scenario.cleanup.warnings) {
        ui.line(`    cleanup: ${warning}`);
      }
    }
  }
  if (options.aiWarnings.length > 0) {
    ui.line('');
    for (const warning of options.aiWarnings) {
      ui.warning(warning);
    }
  }
  if (options.files.length > 0) {
    ui.line('');
    ui.line('Reports:');
    for (const file of options.files) {
      ui.line(`  ${file.format.padEnd(9)} ${file.path}`);
    }
  }
  if (options.keepRunDirectory) {
    ui.line('');
    ui.line(`Run directory kept: ${options.runDirectory}`);
  }
}

/** Executes `upgradelab run` end to end. */
export async function executeRun(flags: RunFlags, ui: Ui): Promise<RunOutcome> {
  const runtime = await createRuntime({
    cwd: flags.cwd,
    ...(flags.configPath ? { configPath: flags.configPath } : {}),
    pluginPaths: flags.pluginPaths,
    logLevel: flags.logLevel,
  });
  return executeRunWithRuntime(flags, ui, runtime);
}

export async function executeRunWithRuntime(
  flags: RunFlags,
  ui: Ui,
  runtime: Runtime,
): Promise<RunOutcome> {
  const { config, loaded, logger, redactor, checkRunner, provider, databaseAdapter } = runtime;
  const selected = selectScenarios(config, flags.scenarios);
  const scenarios: readonly ScenarioConfig[] = applyOverrides(selected, {
    ...(flags.fromImage ? { fromImage: flags.fromImage } : {}),
    ...(flags.toImage ? { toImage: flags.toImage } : {}),
    ...(flags.timeoutMs !== undefined ? { timeoutMs: flags.timeoutMs } : {}),
  });

  // Validate report formats before doing any expensive work.
  runtime.reporters.resolveMany(flags.reportFormats);

  const aiConfig = resolveAiConfig(config.ai, {
    ai: flags.ai,
    ...(flags.aiProvider ? { aiProvider: flags.aiProvider } : {}),
    ...(flags.aiModel ? { aiModel: flags.aiModel } : {}),
  });
  let assistant: AiAssistant | undefined;
  if (aiConfig.enabled) {
    const aiLogger = createLogger({ level: flags.logLevel, redactor });
    assistant = createAiAssistant({
      config: aiConfig,
      env: process.env,
      redactor,
      logger: aiLogger,
    });
    ui.progress(
      `AI diagnostics enabled (${assistant.providerId}/${assistant.model}); output is advisory only.`,
    );
  }

  const engine = new ExecutionEngine({
    provider,
    checkRunner,
    redactor,
    logger,
    config,
    composeFile: loaded.composeFile,
    projectDirectory: loaded.projectDirectory,
    ...(databaseAdapter ? { databaseAdapter } : {}),
    ...(flags.runRoot ? { runRoot: flags.runRoot } : {}),
  });

  const engineLogger = createLogger({ level: flags.logLevel, redactor });
  const result = await engine.run({
    scenarios,
    configPath: loaded.configPath,
    signal: flags.signal,
    ...(flags.runRoot ? { runRoot: flags.runRoot } : {}),
    onEvent: (event) => {
      if (event.type === 'phase' || event.type === 'warning' || event.type === 'error') {
        ui.progress(`[${event.phase}] ${event.message}`);
      }
    },
    onScenarioStart: (scenario) => {
      ui.progress(
        `Scenario ${scenario.id}: ${scenario.path.map((step) => step.image).join(' -> ')}`,
      );
    },
  });
  void engineLogger;

  let adAdvisories: readonly AiAdvisory[] = [];
  const aiWarnings: string[] = [];
  if (assistant) {
    const invariantQueries = config.scenarios.flatMap((scenario) =>
      scenario.invariants.map((invariant) => invariant.query),
    );
    const collected = await collectAiAdvisories({
      assistant,
      scenarios: result.scenarios,
      invariantQueries,
      signal: flags.signal,
      logger,
    });
    adAdvisories = collected.advisories;
    aiWarnings.push(...collected.warnings);

    const nonPassing = result.scenarios.some((scenario) => scenario.status !== 'PASSED');
    if (nonPassing && assistant.isEnabled('failure-summary')) {
      const provisional = buildReportDocument({
        project: config.project,
        configPath: loaded.configPath,
        configDirectory: loaded.configDirectory,
        configHash: loaded.configHash,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        status: result.status,
        scenarios: result.scenarios,
        runId: result.runId,
        cancelled: result.cancelled,
        ai: {
          enabled: true,
          provider: assistant.providerId,
          model: assistant.model,
          advisories: adAdvisories,
        },
      });
      try {
        const summary = await assistant.summarizeRun(provisional, flags.signal);
        adAdvisories = [...adAdvisories, summary];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('AI run summary failed; ignoring its output.', { error: message });
        aiWarnings.push(`AI failure-summary failed: ${message}`);
      }
    }
  }

  const aiSection: AiReportSection = assistant
    ? {
        enabled: true,
        provider: assistant.providerId,
        model: assistant.model,
        advisories: adAdvisories,
      }
    : { enabled: false, advisories: [], skippedReason: 'AI diagnostics are disabled.' };

  const report = buildReportDocument({
    project: config.project,
    configPath: loaded.configPath,
    configDirectory: loaded.configDirectory,
    configHash: loaded.configHash,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    status: result.status,
    scenarios: result.scenarios,
    runId: result.runId,
    cancelled: result.cancelled,
    ai: aiSection,
    toolVersion: TOOL_VERSION,
  });

  let files: readonly WrittenReportFile[] = [];
  if (!flags.noReport) {
    const outputDirectory = flags.outputDirectory
      ? path.resolve(flags.cwd, flags.outputDirectory)
      : defaultReportDirectory(flags.cwd, result.runId);
    const written = await writeReports(
      report,
      {
        outputDirectory,
        formats: flags.reportFormats,
        redactor,
        logger,
      },
      runtime.reporters,
    );
    files = written.files;
  }

  const exitCode = exitCodeForStatus(result.status, result.cleanupFailed);

  if (ui.json) {
    ui.line(
      JSON.stringify(
        {
          ok: result.status === 'PASSED' && exitCode === EXIT_CODES.OK,
          status: result.status,
          runId: result.runId,
          project: config.project.name,
          durationMs: result.durationMs,
          scenarios: result.scenarios.map(scenarioSummary),
          reports: files,
          ai: assistant
            ? {
                enabled: true,
                provider: assistant.providerId,
                model: assistant.model,
                advisories: adAdvisories.length,
              }
            : { enabled: false },
          cleanupFailed: result.cleanupFailed,
        },
        null,
        2,
      ),
    );
  } else {
    printSummary({
      ui,
      result,
      report,
      files,
      runDirectory: result.runDirectory,
      keepRunDirectory: flags.keepRunDirectory,
      aiWarnings,
    });
  }

  if (!flags.keepRunDirectory) {
    try {
      await removeRunDirectory(result.runDirectory);
    } catch (error) {
      ui.warning(
        `Unable to remove run directory ${result.runDirectory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    exitCode,
    status: result.status,
    runId: result.runId,
    report,
    files,
    runDirectory: result.runDirectory,
    scenarios: result.scenarios,
  };
}

export { createNullLogger };
