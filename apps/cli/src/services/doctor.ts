import {
  EXIT_CODES,
  UpgradeLabError,
  isUpgradeLabError,
  type PreflightCheck,
} from '@upgradelab/contracts';
import { apiKeyEnvName } from '@upgradelab/ai-assistant';
import { createDockerComposeProvider } from '@upgradelab/docker-compose-provider';
import { createNullLogger } from '@upgradelab/core';
import { createRuntime, type Runtime } from '../runtime.js';
import { renderTable, type DoctorLine, type Ui } from '../ui.js';

export interface DoctorFlags {
  readonly cwd: string;
  readonly configPath?: string;
  readonly pluginPaths: readonly string[];
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
  readonly signal: AbortSignal;
}

export interface DoctorOutcome {
  readonly exitCode: number;
  readonly ok: boolean;
  readonly checks: readonly DoctorLine[];
  readonly metadata: Readonly<Record<string, string>>;
}

const MIN_NODE = [22, 12, 0] as const;

function nodeIsSupported(): { ok: boolean; version: string } {
  const raw = process.versions.node;
  const parts = raw.split('.').map((part) => Number(part));
  const [major = 0, minor = 0, patch = 0] = parts;
  const actual: [number, number, number] = [major, minor, patch];
  const ok =
    actual[0] > MIN_NODE[0] ||
    (actual[0] === MIN_NODE[0] && actual[1] > MIN_NODE[1]) ||
    (actual[0] === MIN_NODE[0] && actual[1] === MIN_NODE[1] && actual[2] >= MIN_NODE[2]);
  return { ok, version: raw };
}

function fromPreflight(check: PreflightCheck): DoctorLine {
  return {
    id: check.id,
    status:
      check.status === 'WARNING' ? 'WARNING' : check.status === 'PASSED' ? 'PASSED' : 'FAILED',
    message: check.message,
  };
}

/**
 * Diagnoses dependencies without running an upgrade.
 *
 * A missing configuration is a warning: `doctor` is useful on a fresh machine
 * before the user has written `upgradelab.yaml`.
 */
export async function executeDoctor(flags: DoctorFlags, ui: Ui): Promise<DoctorOutcome> {
  const checks: DoctorLine[] = [];
  const metadata: Record<string, string> = {};
  let configFailed = false;
  let environmentFailed = false;

  const node = nodeIsSupported();
  checks.push({
    id: 'node',
    status: node.ok ? 'PASSED' : 'FAILED',
    message: node.ok
      ? `Node.js ${node.version} satisfies the >=${MIN_NODE.join('.')} requirement.`
      : `Node.js ${node.version} is too old; UpgradeLab requires >=${MIN_NODE.join('.')}.`,
  });
  if (!node.ok) {
    environmentFailed = true;
  }

  let runtime: Runtime | undefined;
  try {
    runtime = await createRuntime({
      cwd: flags.cwd,
      ...(flags.configPath ? { configPath: flags.configPath } : {}),
      pluginPaths: flags.pluginPaths,
      logLevel: flags.logLevel,
    });
    checks.push({
      id: 'config',
      status: 'PASSED',
      message: `Configuration is valid: ${runtime.loaded.configPath}`,
    });
    checks.push({
      id: 'plugins',
      status: 'PASSED',
      message:
        runtime.plugins.loaded.length === 0
          ? 'No plugins loaded (core assertions only).'
          : `Loaded ${runtime.plugins.loaded.length} plugin(s): ${runtime.plugins.loaded.map((plugin) => plugin.name).join(', ')}`,
    });
    const database = runtime.config.environment.database;
    checks.push({
      id: 'database-adapter',
      status: 'PASSED',
      message: database
        ? `Database adapter "${database.adapter}" is available.`
        : 'No database configured (SQL checks disabled).',
    });
    if (runtime.config.ai.enabled) {
      const keyName = apiKeyEnvName(runtime.config.ai);
      const present = Boolean(process.env[keyName]);
      checks.push({
        id: 'ai',
        status: present ? 'PASSED' : 'WARNING',
        message: present
          ? `AI diagnostics enabled (${runtime.config.ai.provider}/${runtime.config.ai.model ?? 'no model'}).`
          : `AI is enabled but ${keyName} is not set; AI diagnostics will fail until it is exported.`,
      });
    } else {
      checks.push({
        id: 'ai',
        status: 'PASSED',
        message: 'AI diagnostics are disabled (default).',
      });
    }
  } catch (error) {
    const missing = isUpgradeLabError(error) && error.code === 'CONFIG_NOT_FOUND';
    checks.push({
      id: 'config',
      status: missing ? 'WARNING' : 'FAILED',
      message: missing
        ? 'No UpgradeLab configuration found in this directory.'
        : error instanceof Error
          ? error.message
          : String(error),
    });
    if (!missing) {
      configFailed = true;
    }
  }

  const provider =
    runtime?.provider ??
    createDockerComposeProvider({
      composeFile: '',
      projectDirectory: flags.cwd,
    });

  const timeoutSignal = AbortSignal.any([flags.signal, AbortSignal.timeout(120_000)]);
  const logger = runtime?.logger ?? createNullLogger();
  try {
    const preflight = await provider.preflight(logger, timeoutSignal);
    metadata['preflight'] = JSON.stringify(preflight.metadata);
    for (const [key, value] of Object.entries(preflight.metadata)) {
      metadata[key] = value;
    }
    for (const check of preflight.checks) {
      checks.push(fromPreflight(check));
      if (
        check.status === 'FAILED' &&
        check.id !== 'compose-config' &&
        check.id !== 'compose-security'
      ) {
        environmentFailed = true;
      }
      if (
        check.status === 'FAILED' &&
        (check.id === 'compose-config' || check.id === 'compose-security')
      ) {
        configFailed = true;
      }
    }
  } catch (error) {
    checks.push({
      id: 'provider',
      status: 'FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
    environmentFailed = true;
  }

  const failed = checks.some((check) => check.status === 'FAILED');
  const ok = !failed;
  const exitCode = configFailed
    ? EXIT_CODES.CONFIG_ERROR
    : environmentFailed
      ? EXIT_CODES.ENVIRONMENT_ERROR
      : EXIT_CODES.OK;

  if (ui.json) {
    ui.line(JSON.stringify({ ok, checks, metadata }, null, 2));
  } else {
    ui.heading('UpgradeLab doctor');
    ui.line(
      renderTable(
        checks.map((check) => [
          check.id,
          check.status === 'PASSED' ? 'ok' : check.status,
          check.message,
        ]),
        ['Check', 'Status', 'Details'],
      ),
    );
    const significant = Object.entries(metadata).filter(([key]) => key !== 'preflight');
    if (significant.length > 0) {
      ui.line('');
      ui.line('Environment:');
      for (const [key, value] of significant) {
        ui.line(`  ${key}: ${value}`);
      }
    }
  }

  return { exitCode, ok, checks, metadata };
}

export { UpgradeLabError };
