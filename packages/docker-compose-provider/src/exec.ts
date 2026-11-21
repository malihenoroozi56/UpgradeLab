import { execa } from 'execa';
import { UpgradeLabError } from '@upgradelab/contracts';

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly input?: string;
}

export interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/**
 * Narrow process-execution boundary.
 *
 * Every Docker invocation goes through this interface so the provider can be
 * contract-tested without a Docker daemon, and so argument arrays are the only
 * way to invoke a process (no shell interpolation anywhere).
 */
export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandOutput>;
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class ExecaCommandRunner implements CommandRunner {
  async run(spec: CommandSpec): Promise<CommandOutput> {
    const startedMs = Date.now();
    try {
      const result = await execa(spec.command, [...spec.args], {
        reject: false,
        timeout: spec.timeoutMs,
        ...(spec.signal ? { cancelSignal: spec.signal } : {}),
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        env: { ...process.env, ...(spec.env ?? {}) },
        ...(spec.input !== undefined ? { input: spec.input } : {}),
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        stripFinalNewline: false,
        all: false,
      });
      const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
      return {
        exitCode,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        durationMs: Date.now() - startedMs,
        timedOut: Boolean(result.timedOut),
      };
    } catch (error) {
      const candidate = error as {
        code?: string;
        message?: string;
        timedOut?: boolean;
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      };
      if (candidate.code === 'ENOENT') {
        throw new UpgradeLabError(`Executable "${spec.command}" was not found on PATH.`, {
          code: 'ENVIRONMENT_DOCKER_MISSING',
          details: { command: spec.command },
          hint: 'Install Docker (with the Compose plugin) and ensure it is on PATH.',
        });
      }
      if (candidate.code === 'ABORT_ERR' || spec.signal?.aborted) {
        throw spec.signal?.reason instanceof Error
          ? spec.signal.reason
          : new UpgradeLabError('Command execution cancelled.', { code: 'EXECUTION_CANCELLED' });
      }
      if (candidate.timedOut) {
        return {
          exitCode: -1,
          stdout: candidate.stdout ?? '',
          stderr: candidate.stderr ?? '',
          durationMs: Date.now() - startedMs,
          timedOut: true,
        };
      }
      throw new UpgradeLabError(
        `Failed to execute "${spec.command}": ${candidate.message ?? String(error)}`,
        {
          code: 'PROVIDER_COMMAND_FAILED',
          details: { command: spec.command, args: spec.args },
          cause: error,
        },
      );
    }
  }
}
