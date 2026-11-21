import { describe, expect, it } from 'vitest';
import type { ComposeConfig } from '@upgradelab/docker-compose-provider';
import { analyzeComposeSecurity, isUnsafeMountSource } from '@upgradelab/docker-compose-provider';

const projectDirectory = '/workspace/app';

function configWith(services: ComposeConfig['services']): ComposeConfig {
  return { services };
}

const options = {
  projectDirectory,
  allowedMountRoots: ['/workspace/shared'],
  allowNonLoopbackPorts: false,
};

describe('compose security analysis', () => {
  it('accepts a conventional project configuration', () => {
    const issues = analyzeComposeSecurity(
      configWith({
        app: {
          image: 'app:1',
          volumes: [
            { type: 'bind', source: '/workspace/app/data', target: '/data' },
            { type: 'volume', source: 'app-data', target: '/var/lib/app' },
            { type: 'tmpfs', target: '/tmp' },
          ],
          ports: [{ target: 3000, host_ip: '127.0.0.1', protocol: 'tcp' }],
        },
        db: {
          image: 'postgres:16',
          volumes: [{ type: 'volume', source: 'pgdata', target: '/data' }],
        },
      }),
      options,
    );
    expect(issues).toEqual([]);
  });

  it('rejects privileged containers', () => {
    const issues = analyzeComposeSecurity(
      configWith({ app: { image: 'app:1', privileged: true } }),
      options,
    );
    expect(issues.map((issue) => issue.code)).toContain('PRIVILEGED_CONTAINER');
  });

  it('rejects host networking and host namespaces', () => {
    const issues = analyzeComposeSecurity(
      configWith({
        app: { image: 'app:1', network_mode: 'host' },
        worker: { image: 'app:1', pid: 'host' },
        debug: { image: 'app:1', ipc: 'host' },
      }),
      options,
    );
    expect(issues.map((issue) => issue.code)).toContain('HOST_NETWORK');
    expect(issues.filter((issue) => issue.code === 'HOST_NAMESPACE')).toHaveLength(2);
  });

  it('rejects added capabilities, host devices and disabled security profiles', () => {
    const issues = analyzeComposeSecurity(
      configWith({
        app: {
          image: 'app:1',
          cap_add: ['SYS_ADMIN'],
          devices: ['/dev/kvm'],
          security_opt: ['seccomp=unconfined'],
        },
      }),
      options,
    );
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain('ADDED_CAPABILITIES');
    expect(codes).toContain('HOST_DEVICES');
    expect(codes).toContain('DISABLED_SECURITY_PROFILE');
  });

  it('never allows the Docker socket', () => {
    const issues = analyzeComposeSecurity(
      configWith({
        app: {
          image: 'app:1',
          volumes: [
            { type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' },
          ],
        },
      }),
      options,
    );
    expect(issues[0]?.code).toBe('UNSAFE_BIND_MOUNT');
    expect(issues[0]?.message).toContain('Docker socket');
    expect(isUnsafeMountSource('/var/run/docker.sock', options).unsafe).toBe(true);
  });

  it('rejects sensitive host paths even when inside the project directory', () => {
    const issues = analyzeComposeSecurity(
      configWith({
        app: { image: 'app:1', volumes: [{ type: 'bind', source: '/proc/self', target: '/host' }] },
      }),
      options,
    );
    expect(issues.map((issue) => issue.code)).toContain('UNSAFE_BIND_MOUNT');
  });

  it('rejects bind mounts outside the project and allowed roots', () => {
    const issues = analyzeComposeSecurity(
      configWith({
        app: {
          image: 'app:1',
          volumes: [{ type: 'bind', source: '/etc/passwd', target: '/passwd' }],
        },
      }),
      options,
    );
    expect(issues.map((issue) => issue.code)).toContain('UNSAFE_BIND_MOUNT');

    const outside = analyzeComposeSecurity(
      configWith({
        app: {
          image: 'app:1',
          volumes: [{ type: 'bind', source: '/home/other/data', target: '/data' }],
        },
      }),
      options,
    );
    expect(outside.map((issue) => issue.code)).toContain('UNSAFE_BIND_MOUNT');
  });

  it('allows explicitly configured extra mount roots', () => {
    const issues = analyzeComposeSecurity(
      configWith({
        app: {
          image: 'app:1',
          volumes: [{ type: 'bind', source: '/workspace/shared/fixture', target: '/fixture' }],
        },
      }),
      options,
    );
    expect(issues).toEqual([]);
  });

  it('rejects non-loopback published ports unless explicitly allowed', () => {
    const insecure = analyzeComposeSecurity(
      configWith({
        app: { image: 'app:1', ports: [{ target: 3000, host_ip: '0.0.0.0', protocol: 'tcp' }] },
      }),
      options,
    );
    expect(insecure.map((issue) => issue.code)).toContain('NON_LOOPBACK_PORT');
    const allowed = analyzeComposeSecurity(
      configWith({
        app: { image: 'app:1', ports: [{ target: 3000, host_ip: '0.0.0.0', protocol: 'tcp' }] },
      }),
      { ...options, allowNonLoopbackPorts: true },
    );
    expect(allowed).toEqual([]);
  });

  it('rejects build contexts outside the project', () => {
    const issues = analyzeComposeSecurity(
      configWith({
        app: { image: 'app:1', build: { context: '/opt/other-project' } },
      }),
      options,
    );
    expect(issues.map((issue) => issue.code)).toContain('UNSAFE_BUILD_CONTEXT');
  });

  it('rejects secret and config files outside allowed roots', () => {
    const issues = analyzeComposeSecurity(
      {
        services: { app: { image: 'app:1' } },
        secrets: { db_password: { file: '/home/other/.secrets/db.txt' } },
        configs: { app_config: { file: '/etc/app/config.yml' } },
      },
      options,
    );
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain('UNSAFE_SECRET_FILE');
    expect(codes).toContain('UNSAFE_CONFIG_FILE');
  });
});
