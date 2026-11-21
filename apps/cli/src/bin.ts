#!/usr/bin/env node
import { CommanderError } from 'commander';
import { EXIT_CODES, UpgradeLabError } from '@upgradelab/contracts';
import { commanderExitCode, createProgram } from './program.js';

const controller = new AbortController();
let interrupted = false;

function onSignal(signal: NodeJS.Signals): void {
  if (interrupted) {
    process.stderr.write('\nForced exit.\n');
    process.exit(130);
  }
  interrupted = true;
  process.stderr.write(
    `\nReceived ${signal}: cancelling the run and cleaning up test resources. Press Ctrl+C again to force exit.\n`,
  );
  controller.abort(
    new UpgradeLabError(`Execution cancelled by ${signal}.`, {
      code: 'EXECUTION_CANCELLED',
    }),
  );
}

process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

try {
  await createProgram({ signal: controller.signal }).parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = commanderExitCode(error);
  } else {
    process.stderr.write(
      `error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = EXIT_CODES.INTERNAL_ERROR;
  }
}
