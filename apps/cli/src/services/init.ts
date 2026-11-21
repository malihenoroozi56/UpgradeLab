import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EXIT_CODES, UpgradeLabError } from '@upgradelab/contracts';
import { renderInitConfig } from '@upgradelab/config';
import { type Ui } from '../ui.js';

export interface InitFlags {
  readonly cwd: string;
  readonly force: boolean;
  readonly composeFile?: string;
  readonly projectName?: string;
  readonly fromImage?: string;
  readonly toImage?: string;
  readonly appService?: string;
  readonly databaseService?: string;
}

export interface InitOutcome {
  readonly exitCode: number;
  readonly file: string;
  readonly created: boolean;
}

export async function executeInit(flags: InitFlags, ui: Ui): Promise<InitOutcome> {
  const file = path.join(flags.cwd, 'upgradelab.yaml');
  let exists = false;
  try {
    const info = await stat(file);
    exists = info.isFile();
  } catch {
    exists = false;
  }
  if (exists && !flags.force) {
    throw new UpgradeLabError(`Configuration file already exists: ${file}`, {
      code: 'CONFIG_VALIDATION_ERROR',
      details: { file },
      hint: 'Pass --force to overwrite it, or edit the existing file.',
    });
  }
  const content = renderInitConfig({
    ...(flags.projectName ? { projectName: flags.projectName } : {}),
    ...(flags.composeFile ? { composeFile: flags.composeFile } : {}),
    ...(flags.appService ? { appService: flags.appService } : {}),
    ...(flags.databaseService ? { databaseService: flags.databaseService } : {}),
    ...(flags.fromImage ? { fromImage: flags.fromImage } : {}),
    ...(flags.toImage ? { toImage: flags.toImage } : {}),
  });
  await writeFile(file, content, { encoding: 'utf8', mode: 0o644 });
  if (ui.json) {
    ui.line(JSON.stringify({ ok: true, file, created: !exists }, null, 2));
  } else {
    ui.heading(exists ? 'Configuration overwritten' : 'Configuration created');
    ui.line(file);
    ui.line('');
    ui.line('Next steps:');
    ui.line('  1. Point environment.composeFile at your Docker Compose file.');
    ui.line('  2. Replace the example images with the releases you want to test.');
    ui.line('  3. Run "upgradelab doctor" to verify Docker is available.');
    ui.line('  4. Run "upgradelab validate" and then "upgradelab run".');
  }
  return { exitCode: EXIT_CODES.OK, file, created: !exists };
}
