import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import {
  EXIT_CODES,
  TOOL_VERSION,
  UpgradeLabError,
  exitCodeForError,
  serializeError,
} from '@upgradelab/contracts';
import { executeDoctor } from './services/doctor.js';
import { executeInit } from './services/init.js';
import { executePluginList } from './services/plugins.js';
import { executeReport } from './services/report.js';
import { executeRun } from './services/run.js';
import { executeValidate } from './services/validate.js';
import { executeVersion } from './services/version.js';
import { Ui, shouldUseColor } from './ui.js';

export interface CliOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

interface CommonOptions {
  readonly config?: string;
  readonly plugin?: string[];
  readonly json?: boolean;
  readonly color?: boolean;
  readonly logLevel?: string;
}

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'silent'];

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return parsed;
}

function parseLogLevel(value: string): LogLevel {
  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`must be one of: ${LOG_LEVELS.join(', ')}`);
  }
  return value as LogLevel;
}

function addCommonOptions(command: Command): Command {
  return command
    .addOption(new Option('-c, --config <path>', 'path to upgradelab.yaml'))
    .addOption(
      new Option('--plugin <path>', 'load a plugin ES module (repeatable)')
        .argParser(collect)
        .default([]),
    )
    .addOption(new Option('--json', 'machine-readable JSON on stdout').default(false))
    .addOption(new Option('--no-color', 'disable ANSI colors'))
    .addOption(
      new Option('--log-level <level>', 'structured log level')
        .argParser(parseLogLevel)
        .default('info'),
    );
}

function createUi(options: CommonOptions, cli: CliOptions): Ui {
  return new Ui({
    json: Boolean(options.json),
    color: shouldUseColor(options.color === false),
    ...(cli.stdout ? { stdout: cli.stdout } : {}),
    ...(cli.stderr ? { stderr: cli.stderr } : {}),
  });
}

function terminalFailure(ui: Ui, error: unknown): number {
  const serialized = serializeError(error);
  const exitCode = exitCodeForError(error);
  if (ui.json) {
    ui.line(JSON.stringify({ ok: false, exitCode, error: serialized }, null, 2));
    return exitCode;
  }
  ui.error(`error: ${serialized.message}`);
  if (serialized.code !== 'INTERNAL_ERROR') {
    ui.error(`code:  ${serialized.code}`);
  }
  if (error instanceof UpgradeLabError && error.hint) {
    ui.error(`hint:  ${error.hint}`);
  }
  const details = serialized.details;
  if (details && Object.keys(details).length > 0) {
    const printable = { ...details };
    delete printable['hint'];
    const text = JSON.stringify(printable, null, 2);
    if (text.length <= 2_000) {
      ui.error(`details: ${text.replace(/\n/g, '\n         ')}`);
    }
  }
  return exitCode;
}

async function runAction(ui: Ui, action: () => Promise<number | void>): Promise<void> {
  try {
    const result = await action();
    process.exitCode = typeof result === 'number' ? result : EXIT_CODES.OK;
  } catch (error) {
    process.exitCode = terminalFailure(ui, error);
  }
}

/**
 * Builds the CLI program. Command handlers only map options to services and
 * translate outcomes into exit codes.
 */
export function createProgram(cli: CliOptions = {}): Command {
  const cwd = cli.cwd ?? process.cwd();
  const signal = cli.signal ?? new AbortController().signal;
  const program = new Command();

  program
    .name('upgradelab')
    .description('Prove that upgrades preserve user data.')
    .version(TOOL_VERSION, '-v, --version', 'print the UpgradeLab version')
    .showHelpAfterError('(run "upgradelab --help" for usage)');

  program.exitOverride();

  addCommonOptions(
    program
      .command('init')
      .description('create a documented upgradelab.yaml in the current directory')
      .option('--force', 'overwrite an existing configuration file', false)
      .option('--compose-file <path>', 'path to the Docker Compose file')
      .option('--project-name <name>', 'project name used in reports')
      .option('--app-service <name>', 'Compose service running the application')
      .option('--database-service <name>', 'Compose service running the database')
      .option('--from-image <image>', 'source release image')
      .option('--to-image <image>', 'target release image'),
  ).action(async (options: CommonOptions & Record<string, unknown>) => {
    const ui = createUi(options, cli);
    await runAction(ui, async () => {
      const outcome = await executeInit(
        {
          cwd,
          force: Boolean(options['force']),
          ...(typeof options['composeFile'] === 'string'
            ? { composeFile: options['composeFile'] }
            : {}),
          ...(typeof options['projectName'] === 'string'
            ? { projectName: options['projectName'] }
            : {}),
          ...(typeof options['appService'] === 'string'
            ? { appService: options['appService'] }
            : {}),
          ...(typeof options['databaseService'] === 'string'
            ? { databaseService: options['databaseService'] }
            : {}),
          ...(typeof options['fromImage'] === 'string' ? { fromImage: options['fromImage'] } : {}),
          ...(typeof options['toImage'] === 'string' ? { toImage: options['toImage'] } : {}),
        },
        ui,
      );
      return outcome.exitCode;
    });
  });

  addCommonOptions(
    program
      .command('doctor')
      .description('diagnose Docker, configuration and plugin prerequisites'),
  ).action(async (options: CommonOptions) => {
    const ui = createUi(options, cli);
    await runAction(ui, async () => {
      const outcome = await executeDoctor(
        {
          cwd,
          ...(options.config ? { configPath: options.config } : {}),
          pluginPaths: options.plugin ?? [],
          logLevel: (options.logLevel as LogLevel) ?? 'info',
          signal,
        },
        ui,
      );
      return outcome.exitCode;
    });
  });

  addCommonOptions(
    program
      .command('validate')
      .description('validate the configuration without starting containers')
      .option('--scenario <id>', 'validate only the given scenario (repeatable)', collect, []),
  ).action(async (options: CommonOptions & { scenario: string[] }) => {
    const ui = createUi(options, cli);
    await runAction(ui, async () => {
      const outcome = await executeValidate(
        {
          cwd,
          ...(options.config ? { configPath: options.config } : {}),
          scenarios: options.scenario,
          pluginPaths: options.plugin ?? [],
          logLevel: (options.logLevel as LogLevel) ?? 'info',
        },
        ui,
      );
      return outcome.exitCode;
    });
  });

  addCommonOptions(
    program
      .command('run')
      .description('execute upgrade scenarios in isolated Docker Compose environments')
      .option('--scenario <id>', 'run only the given scenario (repeatable)', collect, [])
      .option('--from-image <image>', 'override the source image of every selected scenario')
      .option('--to-image <image>', 'override the target image of every selected scenario')
      .option('--timeout <ms>', 'per-scenario timeout in milliseconds', parsePositiveInteger)
      .option(
        '--report <formats>',
        'report formats (comma separated or repeatable; default json,markdown,junit)',
        collect,
        [],
      )
      .option('--output-dir <path>', 'directory for report files')
      .option('--skip-reports', 'do not write report files', false)
      .option('--run-root <path>', 'root directory for per-run scratch files')
      .option('--keep-run-dir', 'keep the per-run scratch directory', false)
      .option('--ai', 'enable AI diagnostics for this run (advisory only)', false)
      .option(
        '--ai-provider <provider>',
        'AI provider: openai, anthropic, gemini, openai-compatible',
      )
      .option('--ai-model <model>', 'AI model name'),
  ).action(
    async (
      options: CommonOptions & {
        scenario: string[];
        report: string[];
        fromImage?: string;
        toImage?: string;
        timeout?: number;
        outputDir?: string;
        runRoot?: string;
        keepRunDir?: boolean;
        skipReports?: boolean;
        ai?: boolean;
        aiProvider?: string;
        aiModel?: string;
      },
    ) => {
      const ui = createUi(options, cli);
      await runAction(ui, async () => {
        const formats = (options.report.length > 0 ? options.report : ['json,markdown,junit'])
          .flatMap((value) => value.split(','))
          .map((value) => value.trim())
          .filter(Boolean);
        const outcome = await executeRun(
          {
            cwd,
            ...(options.config ? { configPath: options.config } : {}),
            scenarios: options.scenario,
            ...(options.fromImage ? { fromImage: options.fromImage } : {}),
            ...(options.toImage ? { toImage: options.toImage } : {}),
            ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
            reportFormats: formats,
            ...(options.outputDir ? { outputDirectory: options.outputDir } : {}),
            noReport: Boolean(options.skipReports),
            ai: Boolean(options.ai),
            ...(options.aiProvider ? { aiProvider: options.aiProvider } : {}),
            ...(options.aiModel ? { aiModel: options.aiModel } : {}),
            pluginPaths: options.plugin ?? [],
            logLevel: (options.logLevel as LogLevel) ?? 'info',
            ...(options.runRoot
              ? { runRoot: options.runRoot }
              : process.env['UPGRADELAB_RUN_ROOT']
                ? { runRoot: process.env['UPGRADELAB_RUN_ROOT'] }
                : {}),
            keepRunDirectory: Boolean(options.keepRunDir),
            signal,
          },
          ui,
        );
        return outcome.exitCode;
      });
    },
  );

  addCommonOptions(
    program
      .command('report')
      .description('re-render an existing report')
      .option('--file <path>', 'report JSON file (defaults to the newest run)')
      .option('--format <format>', 'report format (repeatable)', collect, [])
      .option('--output-dir <path>', 'write reports instead of printing them'),
  ).action(
    async (options: CommonOptions & { file?: string; format: string[]; outputDir?: string }) => {
      const ui = createUi(options, cli);
      await runAction(ui, async () => {
        const outcome = await executeReport(
          {
            cwd,
            ...(options.file ? { file: options.file } : {}),
            formats: options.format,
            ...(options.outputDir ? { outputDirectory: options.outputDir } : {}),
            pluginPaths: options.plugin ?? [],
            logLevel: (options.logLevel as LogLevel) ?? 'info',
          },
          ui,
        );
        return outcome.exitCode;
      });
    },
  );

  const pluginCommand = program.command('plugin').description('plugin utilities');
  addCommonOptions(
    pluginCommand.command('list').description('list plugins, assertion types and report formats'),
  ).action(async (options: CommonOptions) => {
    const ui = createUi(options, cli);
    await runAction(ui, async () => {
      const outcome = await executePluginList(
        {
          cwd,
          ...(options.config ? { configPath: options.config } : {}),
          pluginPaths: options.plugin ?? [],
          logLevel: (options.logLevel as LogLevel) ?? 'info',
        },
        ui,
      );
      return outcome.exitCode;
    });
  });

  addCommonOptions(
    program.command('version').description('print version and compatibility information'),
  ).action(async (options: CommonOptions) => {
    const ui = createUi(options, cli);
    await runAction(ui, async () => {
      executeVersion(ui);
      return EXIT_CODES.OK;
    });
  });

  program.configureOutput({
    writeErr: (text) => {
      const stream = cli.stderr ?? process.stderr;
      stream.write(text);
    },
    writeOut: (text) => {
      const stream = cli.stdout ?? process.stdout;
      stream.write(text);
    },
  });

  return program;
}

/** Maps a Commander parse failure to UpgradeLab's usage exit code. */
export function isCommanderHelp(error: unknown): boolean {
  return (
    error instanceof CommanderError &&
    (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
  );
}

export function commanderExitCode(error: unknown): number {
  return isCommanderHelp(error) ? EXIT_CODES.OK : EXIT_CODES.CONFIG_ERROR;
}
