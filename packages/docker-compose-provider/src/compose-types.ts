import { UpgradeLabError } from '@upgradelab/contracts';

export interface ComposePort {
  mode?: string;
  target: number;
  published?: string | number;
  protocol?: string;
  host_ip?: string;
  [key: string]: unknown;
}

export interface ComposeMount {
  type?: 'bind' | 'volume' | 'tmpfs' | 'npipe' | 'cluster';
  source?: string;
  target?: string;
  read_only?: boolean;
  [key: string]: unknown;
}

export interface ComposeBuild {
  context?: string;
  dockerfile?: string;
  args?: unknown;
  [key: string]: unknown;
}

export interface ComposeService {
  image?: string;
  build?: ComposeBuild | string;
  ports?: ComposePort[];
  volumes?: ComposeMount[];
  environment?: Record<string, string | null> | string[];
  labels?: Record<string, string> | string[];
  privileged?: boolean;
  network_mode?: string;
  pid?: string;
  ipc?: string;
  uts?: string;
  userns_mode?: string;
  cgroup?: string;
  cap_add?: string[];
  devices?: unknown[];
  security_opt?: string[];
  mem_limit?: string;
  cpus?: number;
  pids_limit?: number;
  healthcheck?: unknown;
  networks?: string[] | Record<string, unknown>;
  container_name?: string;
  profiles?: string[];
  [key: string]: unknown;
}

export interface ComposeNetwork {
  internal?: boolean;
  name?: string;
  [key: string]: unknown;
}

export interface ComposeFileRef {
  file?: string;
  [key: string]: unknown;
}

export interface ComposeConfig {
  name?: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, ComposeNetwork>;
  volumes?: Record<string, unknown>;
  secrets?: Record<string, ComposeFileRef>;
  configs?: Record<string, ComposeFileRef>;
  [key: string]: unknown;
}

export interface ComposePsEntry {
  readonly ID?: string;
  readonly Name?: string;
  readonly Image?: string;
  readonly Service?: string;
  readonly State?: string;
  readonly Health?: string;
  readonly ExitCode?: number;
  readonly Status?: string;
}

/** Parses `docker compose config --format json` output. */
export function parseComposeConfig(text: string, source: string): ComposeConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new UpgradeLabError(`Docker Compose produced invalid JSON for ${source}.`, {
      code: 'ENVIRONMENT_COMPOSE_INVALID',
      details: { source },
      cause: error,
    });
  }
  if (value === null || typeof value !== 'object' || !('services' in value)) {
    throw new UpgradeLabError(`Docker Compose configuration ${source} has no services.`, {
      code: 'ENVIRONMENT_COMPOSE_INVALID',
      details: { source },
    });
  }
  const config = value as ComposeConfig;
  if (!config.services || typeof config.services !== 'object') {
    throw new UpgradeLabError(`Docker Compose configuration ${source} has no services.`, {
      code: 'ENVIRONMENT_COMPOSE_INVALID',
      details: { source },
    });
  }
  return config;
}

/**
 * `docker compose ps --format json` returns a JSON array on newer releases and
 * one JSON object per line on older ones. Both shapes are accepted.
 */
export function parseComposePs(stdout: string): ComposePsEntry[] {
  const text = stdout.trim();
  if (text.length === 0) {
    return [];
  }
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as ComposePsEntry[]) : [];
    } catch {
      return [];
    }
  }
  const entries: ComposePsEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as ComposePsEntry);
    } catch {
      // Ignore non-JSON lines: compose may print warnings to stdout.
    }
  }
  return entries;
}

/** Reads labels whether Compose normalized them to an object or left a list. */
export function readServiceLabels(service: ComposeService): Record<string, string> {
  const labels = service.labels;
  if (!labels) {
    return {};
  }
  if (Array.isArray(labels)) {
    const result: Record<string, string> = {};
    for (const entry of labels) {
      const index = entry.indexOf('=');
      if (index > 0) {
        result[entry.slice(0, index)] = entry.slice(index + 1);
      }
    }
    return result;
  }
  return { ...labels };
}

/** Escapes `$` so Compose does not re-interpolate an already-resolved config. */
export function escapeComposeInterpolation<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/\$/g, '$$$$') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => escapeComposeInterpolation(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = escapeComposeInterpolation(item);
    }
    return output as unknown as T;
  }
  return value;
}
