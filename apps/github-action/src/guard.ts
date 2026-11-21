/**
 * Ensures a failing `run` outcome marks the GitHub step as failed even if the
 * action's promise resolves normally.
 */
import type { Ui } from '@upgradelab/cli';

export interface RunOutcomeLike {
  readonly exitCode: number;
}

export class ExitCodeGuard {
  constructor(private readonly ui: Ui) {}

  async run<T extends RunOutcomeLike>(operation: () => Promise<T>): Promise<T> {
    const outcome = await operation();
    if (outcome.exitCode !== 0) {
      this.ui.warning(`UpgradeLab exited with code ${outcome.exitCode}.`);
    }
    return outcome;
  }
}
