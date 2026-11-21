import { describe, expect, it } from 'vitest';
import type { ComposeConfig } from '@upgradelab/docker-compose-provider';
import {
  canonicalizeComposeConfig,
  escapeComposeInterpolation,
} from '@upgradelab/docker-compose-provider';

function baseConfig(): ComposeConfig {
  return {
    name: 'user-project',
    services: {
      app: {
        image: 'app:1.0.0',
        build: { context: '/workspace/app' },
        container_name: 'my-app',
        ports: [{ mode: 'ingress', target: 3000, protocol: 'tcp' }],
        labels: { 'com.example.team': 'core' },
      },
      db: { image: 'postgres:16-alpine', ports: [] },
    },
    networks: { default: {} },
  };
}

async function canonicalize(config: ComposeConfig, ports: number[] = []) {
  let index = 0;
  return canonicalizeComposeConfig(config, {
    bindAddress: '127.0.0.1',
    resources: { memoryLimit: '512mb', cpus: 0.5, pidsLimit: 64 },
    internalNetwork: false,
    labels: { 'upgradelab.managed': 'true', 'upgradelab.run-id': 'run-1' },
    requiredPorts: [{ service: 'app', target: 3000 }],
    dropBuildFor: ['app'],
    resolvePort: async () => ports[index++] ?? 40_000 + index,
  });
}

describe('compose canonicalization', () => {
  it('hardens every service and strips run-colliding identifiers', async () => {
    const result = await canonicalize(baseConfig());
    expect(result.name).toBeUndefined();
    const app = result.services['app'];
    expect(app?.container_name).toBeUndefined();
    expect(app?.privileged).toBe(false);
    expect(app?.build).toBeUndefined();
    expect(app?.mem_limit).toBe('512mb');
    expect(app?.cpus).toBe(0.5);
    expect(app?.pids_limit).toBe(64);
    expect(app?.security_opt).toContain('no-new-privileges:true');
    expect(app?.labels).toMatchObject({
      'com.example.team': 'core',
      'upgradelab.managed': 'true',
      'upgradelab.run-id': 'run-1',
    });
    expect(result.services['db']?.mem_limit).toBe('512mb');
  });

  it('binds every port to loopback and allocates unique host ports', async () => {
    const result = await canonicalize(baseConfig(), [50_001]);
    const appPorts = result.services['app']?.ports ?? [];
    expect(appPorts[0]).toMatchObject({
      target: 3000,
      host_ip: '127.0.0.1',
      published: '50001',
      protocol: 'tcp',
    });
  });

  it('adds the required application port when the compose file does not publish it', async () => {
    const config = baseConfig();
    config.services['app'] = { image: 'app:1.0.0' };
    const result = await canonicalize(config, [50_002]);
    expect(result.services['app']?.ports).toEqual([
      expect.objectContaining({ target: 3000, published: '50002', host_ip: '127.0.0.1' }),
    ]);
  });

  it('reuses allocated ports when canonicalizing repeatedly', async () => {
    const config = baseConfig();
    const first = await canonicalize(config, [50_003]);
    const second = await canonicalize(config, [50_003]);
    expect(first.services['app']?.ports?.[0]?.published).toBe(
      second.services['app']?.ports?.[0]?.published,
    );
  });

  it('does not mutate the input configuration', async () => {
    const config = baseConfig();
    const snapshot = structuredClone(config);
    await canonicalize(config);
    expect(config).toEqual(snapshot);
  });

  it('marks every network internal when egress restriction is enabled', async () => {
    const result = await canonicalizeComposeConfig(baseConfig(), {
      bindAddress: '127.0.0.1',
      resources: { memoryLimit: '1g', cpus: 1, pidsLimit: 128 },
      internalNetwork: true,
      labels: {},
      requiredPorts: [],
      resolvePort: async () => 40_100,
    });
    expect(result.networks?.['default']?.internal).toBe(true);
    expect(result.services['app']?.networks).toEqual(['default']);
  });

  it('escapes dollar interpolation in generated values', () => {
    const escaped = escapeComposeInterpolation({
      environment: { LITERAL: 'cost is $5', TEMPLATE: '${HOME}' },
      command: ['sh', '-c', 'echo $FOO'],
    });
    expect(escaped.environment.LITERAL).toBe('cost is $$5');
    expect(escaped.environment.TEMPLATE).toBe('$${HOME}');
    expect(escaped.command[2]).toBe('echo $$FOO');
  });
});
