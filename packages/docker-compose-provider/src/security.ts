import os from 'node:os';
import path from 'node:path';
import type { ComposeConfig, ComposeService } from './compose-types.js';

export interface SecurityIssue {
  readonly code: string;
  readonly message: string;
  readonly service?: string;
}

export interface SecurityAnalysisOptions {
  readonly projectDirectory: string;
  readonly allowedMountRoots: readonly string[];
  readonly allowNonLoopbackPorts: boolean;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost']);

const FORBIDDEN_MOUNT_PATHS = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/var/lib/docker',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
];

const FORBIDDEN_MOUNT_PREFIXES = ['/var/run', '/run', '/root', '/etc', '/var/lib/docker'];

function normalizeHostPath(value: string): string {
  return path.resolve(value);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(normalizeHostPath(parent), normalizeHostPath(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** True when a host path is explicitly forbidden or outside allowed roots. */
export function isUnsafeMountSource(
  source: string,
  options: SecurityAnalysisOptions,
): { unsafe: boolean; reason?: string } {
  const resolved = normalizeHostPath(source);
  const base = path.basename(resolved);
  if (base === 'docker.sock' || FORBIDDEN_MOUNT_PATHS.includes(resolved)) {
    return { unsafe: true, reason: 'the Docker socket must never be mounted into test containers' };
  }
  // The project directory is the primary trust boundary: repositories commonly
  // live inside the home directory, so checking home before this would reject
  // every normal project.
  if (isWithin(options.projectDirectory, resolved)) {
    return { unsafe: false };
  }
  for (const prefix of FORBIDDEN_MOUNT_PREFIXES) {
    if (resolved === normalizeHostPath(prefix) || isWithin(prefix, resolved)) {
      return { unsafe: true, reason: `mounting ${prefix} into test containers is not permitted` };
    }
  }
  const home = os.homedir();
  if (home && (resolved === normalizeHostPath(home) || isWithin(home, resolved))) {
    return { unsafe: true, reason: 'mounting the host home directory is not permitted' };
  }
  const allowedByConfig = options.allowedMountRoots.some((root) => isWithin(root, resolved));
  if (!allowedByConfig) {
    return {
      unsafe: true,
      reason:
        'bind mount source is outside the project directory and configured allowed mount roots',
    };
  }
  return { unsafe: false };
}

function analyzeService(
  name: string,
  service: ComposeService,
  options: SecurityAnalysisOptions,
  issues: SecurityIssue[],
): void {
  if (service.privileged === true) {
    issues.push({
      code: 'PRIVILEGED_CONTAINER',
      service: name,
      message: `Service "${name}" requests privileged mode, which gives it full host access.`,
    });
  }
  if (typeof service.network_mode === 'string') {
    const mode = service.network_mode;
    if (mode === 'host' || mode.startsWith('container:')) {
      issues.push({
        code: 'HOST_NETWORK',
        service: name,
        message: `Service "${name}" uses network_mode "${mode}", which escapes the isolated test network.`,
      });
    }
  }
  if (service.pid === 'host' || service.ipc === 'host' || service.uts === 'host') {
    issues.push({
      code: 'HOST_NAMESPACE',
      service: name,
      message: `Service "${name}" shares a host namespace (pid/ipc/uts), which is not permitted.`,
    });
  }
  if (service.userns_mode === 'host' || service.cgroup === 'host') {
    issues.push({
      code: 'HOST_NAMESPACE',
      service: name,
      message: `Service "${name}" disables namespace isolation (userns_mode/cgroup host).`,
    });
  }
  if (Array.isArray(service.cap_add) && service.cap_add.length > 0) {
    issues.push({
      code: 'ADDED_CAPABILITIES',
      service: name,
      message: `Service "${name}" adds Linux capabilities (${service.cap_add.join(', ')}), which is not permitted.`,
    });
  }
  if (Array.isArray(service.devices) && service.devices.length > 0) {
    issues.push({
      code: 'HOST_DEVICES',
      service: name,
      message: `Service "${name}" mounts host devices, which is not permitted.`,
    });
  }
  for (const option of service.security_opt ?? []) {
    if (/(unconfined|disable|apparmor=unconfined|seccomp=unconfined)/i.test(option)) {
      issues.push({
        code: 'DISABLED_SECURITY_PROFILE',
        service: name,
        message: `Service "${name}" disables a security profile via "${option}".`,
      });
    }
  }

  for (const volume of service.volumes ?? []) {
    if (volume.type !== 'bind') {
      continue;
    }
    const source = volume.source;
    if (!source) {
      continue;
    }
    const result = isUnsafeMountSource(source, options);
    if (result.unsafe) {
      issues.push({
        code: 'UNSAFE_BIND_MOUNT',
        service: name,
        message: `Service "${name}" bind-mounts ${source}: ${result.reason ?? 'not allowed'}.`,
      });
    }
  }

  for (const port of service.ports ?? []) {
    if (!port.host_ip || LOOPBACK_ADDRESSES.has(port.host_ip)) {
      continue;
    }
    if (!options.allowNonLoopbackPorts) {
      issues.push({
        code: 'NON_LOOPBACK_PORT',
        service: name,
        message: `Service "${name}" publishes port ${port.target} on ${port.host_ip}; test ports must bind to loopback.`,
      });
    }
  }

  const build = service.build;
  if (build && typeof build === 'object' && typeof build.context === 'string') {
    const contextPath = build.context;
    const roots = [options.projectDirectory, ...options.allowedMountRoots];
    const isUrl = /^[a-z]+:\/\//i.test(contextPath);
    if (!isUrl && !roots.some((root) => isWithin(root, contextPath))) {
      issues.push({
        code: 'UNSAFE_BUILD_CONTEXT',
        service: name,
        message: `Service "${name}" builds from ${contextPath}, outside the project directory.`,
      });
    }
  }
}

/**
 * Static security analysis of a resolved Compose configuration.
 *
 * This runs before any container is created and before the engine can start an
 * application, so unsafe configuration is rejected rather than merely warned
 * about. See THREAT_MODEL.md for the rationale of each rule.
 */
export function analyzeComposeSecurity(
  config: ComposeConfig,
  options: SecurityAnalysisOptions,
): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  for (const [name, service] of Object.entries(config.services)) {
    analyzeService(name, service, options, issues);
  }
  for (const [name, ref] of Object.entries(config.secrets ?? {})) {
    if (typeof ref.file !== 'string') {
      continue;
    }
    const result = isUnsafeMountSource(ref.file, options);
    if (result.unsafe) {
      issues.push({
        code: 'UNSAFE_SECRET_FILE',
        service: name,
        message: `Compose secret "${name}" reads ${ref.file}: ${result.reason ?? 'not allowed'}.`,
      });
    }
  }
  for (const [name, ref] of Object.entries(config.configs ?? {})) {
    if (typeof ref.file !== 'string') {
      continue;
    }
    const result = isUnsafeMountSource(ref.file, options);
    if (result.unsafe) {
      issues.push({
        code: 'UNSAFE_CONFIG_FILE',
        service: name,
        message: `Compose config "${name}" reads ${ref.file}: ${result.reason ?? 'not allowed'}.`,
      });
    }
  }
  return issues;
}
