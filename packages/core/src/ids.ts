import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Creates a sortable, filesystem- and Docker-safe run identifier. */
export function createRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .toLowerCase();
  const random = randomBytes(4).toString('hex');
  return `${stamp}-${random}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Docker Compose project names must match `[a-z0-9][a-z0-9_-]*`.
 * The run id is embedded so two concurrent runs can never collide, and so a
 * leaked resource can be traced back to one execution.
 */
export function composeProjectName(runId: string, scenarioId: string): string {
  const project = `upgradelab-${slugify(scenarioId)}-${slugify(runId)}`;
  return project.slice(0, 63).replace(/-+$/g, '');
}

export interface RunDirectoryOptions {
  readonly root?: string;
  readonly runId: string;
}

/** Resolves the scratch root. Defaults to the OS temp directory. */
export function resolveRunRoot(root?: string): string {
  return root ? path.resolve(root) : path.join(os.tmpdir(), 'upgradelab');
}

/** Creates a private per-run scratch directory. */
export async function createRunDirectory(options: RunDirectoryOptions): Promise<string> {
  const root = resolveRunRoot(options.root);
  const directory = path.join(root, options.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** Removes a run scratch directory, ignoring missing paths. */
export async function removeRunDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
