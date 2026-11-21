#!/usr/bin/env node
/**
 * Keeps every public version string in sync with the root package.json.
 *
 * The CLI, all workspace packages and the version constants reported by
 * `upgradelab version` must always agree. Run after `changeset version`.
 *
 * Usage:
 *   node scripts/sync-version.mjs          # write versions
 *   node scripts/sync-version.mjs --check  # fail if anything is out of sync
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const checkOnly = process.argv.includes('--check');

const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = rootPackage.version;

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[sync-version] root package.json has no valid version: ${String(version)}`);
  process.exit(1);
}

const workspaceFiles = [
  'packages/contracts/package.json',
  'packages/config/package.json',
  'packages/core/package.json',
  'packages/assertion-engine/package.json',
  'packages/database-postgres/package.json',
  'packages/docker-compose-provider/package.json',
  'packages/reporters/package.json',
  'packages/plugin-sdk/package.json',
  'packages/ai-assistant/package.json',
  'apps/cli/package.json',
  'apps/github-action/package.json',
  'examples/plugins/csv-reporter/package.json',
];

let failures = 0;

for (const relative of workspaceFiles) {
  const file = path.join(root, relative);
  const contents = await readFile(file, 'utf8');
  const document = JSON.parse(contents);
  if (document.version === version) {
    continue;
  }
  if (checkOnly) {
    console.error(`[sync-version] ${relative}: ${document.version} !== ${version}`);
    failures += 1;
    continue;
  }
  document.version = version;
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(`[sync-version] updated ${relative} to ${version}`);
}

const versionFile = path.join(root, 'packages/contracts/src/version.ts');
const versionSource = await readFile(versionFile, 'utf8');
const pattern = /(export const TOOL_VERSION = ')([^']+)(';)/;
const match = pattern.exec(versionSource);
if (!match) {
  console.error(
    '[sync-version] TOOL_VERSION declaration not found in packages/contracts/src/version.ts',
  );
  process.exit(1);
}
if (match[2] !== version) {
  if (checkOnly) {
    console.error(`[sync-version] packages/contracts/src/version.ts: ${match[2]} !== ${version}`);
    failures += 1;
  } else {
    await writeFile(versionFile, versionSource.replace(pattern, `$1${version}$3`), 'utf8');
    console.log(`[sync-version] updated TOOL_VERSION to ${version}`);
  }
}

if (failures > 0) {
  console.error('[sync-version] versions are out of sync; run "pnpm version:sync".');
  process.exit(1);
}

console.log(
  checkOnly ? `[sync-version] all versions match ${version}` : `[sync-version] synced ${version}`,
);
