import type { ComposeConfig, ComposePort } from './compose-types.js';

export interface ResourceLimits {
  readonly memoryLimit: string;
  readonly cpus: number;
  readonly pidsLimit: number;
}

export interface RequiredPort {
  readonly service: string;
  readonly target: number;
}

export interface CanonicalizeOptions {
  readonly bindAddress: string;
  readonly resources: ResourceLimits;
  readonly internalNetwork: boolean;
  readonly labels: Readonly<Record<string, string>>;
  /** Ports that must be published on loopback for verification to work. */
  readonly requiredPorts: readonly RequiredPort[];
  /** Services whose `build` section is dropped so the scenario image wins. */
  readonly dropBuildFor?: readonly string[];
  /** Allocates (or reuses) a host port for one container port. */
  readonly resolvePort: (service: string, target: number, protocol: string) => Promise<number>;
}

const NO_NEW_PRIVILEGES = 'no-new-privileges:true';

function addRequiredPorts(config: ComposeConfig, requiredPorts: readonly RequiredPort[]): void {
  for (const required of requiredPorts) {
    const service = config.services[required.service];
    if (!service) {
      continue;
    }
    const ports: ComposePort[] = Array.isArray(service.ports) ? service.ports : [];
    const exists = ports.some(
      (port) => port.target === required.target && (port.protocol ?? 'tcp') === 'tcp',
    );
    if (!exists) {
      ports.push({ mode: 'ingress', target: required.target, protocol: 'tcp' });
    }
    service.ports = ports;
  }
}

function forceInternalNetwork(config: ComposeConfig): void {
  const networks = config.networks ?? {};
  if (Object.keys(networks).length === 0) {
    networks.default = { internal: true };
  }
  for (const network of Object.values(networks)) {
    network.internal = true;
  }
  if (!networks['default']) {
    networks['default'] = { internal: true };
  }
  config.networks = networks;
  for (const service of Object.values(config.services)) {
    if (!service.networks) {
      service.networks = ['default'];
    }
  }
}

/**
 * Produces a hardened, fully-resolved Compose configuration owned by a run.
 *
 * Working from `docker compose config --format json` avoids fragile override
 * merge semantics: the generated file is the single source of truth for the
 * test environment, and every port, label and limit is set explicitly.
 */
export async function canonicalizeComposeConfig(
  input: ComposeConfig,
  options: CanonicalizeOptions,
): Promise<ComposeConfig> {
  const config = structuredClone(input);
  delete config.name;
  addRequiredPorts(config, options.requiredPorts);
  if (options.internalNetwork) {
    forceInternalNetwork(config);
  }

  for (const [name, service] of Object.entries(config.services)) {
    delete service.container_name;
    service.privileged = false;
    delete service.cap_add;
    delete service.devices;
    if (options.dropBuildFor?.includes(name)) {
      delete service.build;
    }
    const securityOpt = Array.isArray(service.security_opt) ? [...service.security_opt] : [];
    if (!securityOpt.some((option) => option.startsWith('no-new-privileges'))) {
      securityOpt.push(NO_NEW_PRIVILEGES);
    }
    service.security_opt = securityOpt;
    service.mem_limit = options.resources.memoryLimit;
    service.cpus = options.resources.cpus;
    service.pids_limit = options.resources.pidsLimit;
    service.labels = {
      ...(service.labels && !Array.isArray(service.labels) ? service.labels : {}),
      ...options.labels,
    };

    for (const port of service.ports ?? []) {
      if (typeof port.target !== 'number') {
        continue;
      }
      const protocol = typeof port.protocol === 'string' ? port.protocol : 'tcp';
      const hostPort = await options.resolvePort(name, port.target, protocol);
      port.mode = typeof port.mode === 'string' ? port.mode : 'ingress';
      port.protocol = protocol;
      port.host_ip = options.bindAddress;
      port.published = String(hostPort);
    }
  }

  return config;
}
