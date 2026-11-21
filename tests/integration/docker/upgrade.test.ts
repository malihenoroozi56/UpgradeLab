import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeRun } from '@upgradelab/cli';
import { createCapturedUi } from '../../helpers/ui.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

/**
 * Docker-backed end-to-end tests.
 *
 * They are opt-in twice: `UPGRADELAB_TEST_DOCKER=1` must be set and a working
 * Docker daemon must be reachable. When either condition is false the suite is
 * skipped and reported as NOT RUN instead of pretending the upgrade passed.
 */
function dockerIsAvailable(): boolean {
  if (process.env['UPGRADELAB_TEST_DOCKER'] !== '1') {
    return false;
  }
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    });
    return true;
  } catch {
    return false;
  }
}

const available = dockerIsAvailable();

if (!available) {
  process.stderr.write(
    '[upgradelab] Docker integration tests NOT RUN: set UPGRADELAB_TEST_DOCKER=1 and start Docker to enable them.\n',
  );
}

describe.skipIf(!available)('Docker-backed upgrade scenarios', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

  it('passes a real 1.0.0 -> 2.0.0 upgrade and writes a PASSED report', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'upgradelab-docker-e2e-'));
    const { ui } = createCapturedUi(true);
    try {
      const outcome = await executeRun(
        {
          cwd: path.join(repositoryRoot, 'examples/basic-upgrade'),
          scenarios: ['upgrade-1-to-2'],
          reportFormats: ['json', 'markdown', 'junit'],
          outputDirectory,
          noReport: false,
          ai: false,
          pluginPaths: [],
          logLevel: 'info',
          keepRunDirectory: false,
          signal: new AbortController().signal,
        },
        ui,
      );
      expect(outcome.status).toBe('PASSED');
      expect(outcome.exitCode).toBe(0);
      expect(outcome.report.scenarios[0]?.checks.every((check) => check.status === 'PASSED')).toBe(
        true,
      );
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }, 600_000);

  it('fails the multi-hop scenario when the final migration destroys data', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'upgradelab-docker-e2e-'));
    const { ui } = createCapturedUi(true);
    try {
      const outcome = await executeRun(
        {
          cwd: path.join(repositoryRoot, 'examples/multi-hop-upgrade'),
          scenarios: ['hop-1-to-2'],
          reportFormats: ['json'],
          outputDirectory,
          noReport: false,
          ai: false,
          pluginPaths: [],
          logLevel: 'info',
          keepRunDirectory: false,
          signal: new AbortController().signal,
        },
        ui,
      );
      expect(outcome.status).toBe('FAILED');
      expect(outcome.exitCode).toBe(1);
      const failedIds =
        outcome.report.scenarios[0]?.checks
          .filter((check) => check.status === 'FAILED')
          .map((check) => check.id) ?? [];
      expect(failedIds).toContain('email-column-present');
      expect(failedIds).toContain('balances-preserved');
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }, 900_000);
});
