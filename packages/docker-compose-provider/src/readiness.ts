import net from 'node:net';
import type {
  Endpoint,
  HealthcheckConfig,
  ReadinessResult,
  ServiceState,
} from '@upgradelab/contracts';
import type { CommandOutput } from './exec.js';

export interface ReadinessProbeOptions {
  readonly service: string;
  readonly healthcheck?: HealthcheckConfig;
  readonly containerPort?: number;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly signal: AbortSignal;
  readonly getState: () => Promise<ServiceState>;
  readonly getEndpoint: () => Promise<Endpoint>;
  readonly runCommand: (command: readonly string[], timeoutMs: number) => Promise<CommandOutput>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function probeHttp(endpoint: Endpoint, path: string, timeoutMs: number): Promise<void> {
  const pathValue = path.startsWith('/') ? path : `/${path}`;
  const url = `${endpoint.baseUrl}${pathValue}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(Math.min(timeoutMs, 5_000)),
    redirect: 'manual',
  });
  if (response.status < 200 || response.status >= 400) {
    throw new Error(`health endpoint returned HTTP ${response.status}`);
  }
  // Drain the body so the socket can be reused.
  await response.arrayBuffer();
}

async function probeTcp(endpoint: Endpoint, port: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: endpoint.host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connection to ${endpoint.host}:${port} timed out`));
    }, timeoutMs);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Waits until a service is ready according to its healthcheck.
 *
 * Readiness is a gate only: it never decides that an upgrade preserved data.
 * When no healthcheck is configured, only the container state is checked and
 * the engine records that limitation in the report.
 */
export async function waitForReadiness(options: ReadinessProbeOptions): Promise<ReadinessResult> {
  const startedMs = Date.now();
  const intervalMs = options.intervalMs ?? 500;
  let attempts = 0;
  let lastError: string | undefined;

  while (Date.now() - startedMs < options.timeoutMs) {
    if (options.signal.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('readiness check cancelled');
    }
    attempts += 1;
    try {
      const state = await options.getState();
      if (state.state === 'exited' || state.state === 'created') {
        lastError = `container state is "${state.state}"${state.exitCode !== undefined ? ` (exit ${state.exitCode})` : ''}`;
        return {
          ready: false,
          attempts,
          durationMs: Date.now() - startedMs,
          lastError,
          ...(options.healthcheck ? { healthcheck: options.healthcheck } : {}),
        };
      }
      if (state.state !== 'running') {
        lastError = `container state is "${state.state}"`;
      } else if (!options.healthcheck) {
        if (state.health === 'starting') {
          lastError = 'container healthcheck is still starting';
        } else if (state.health === 'unhealthy') {
          return {
            ready: false,
            attempts,
            durationMs: Date.now() - startedMs,
            lastError: 'container healthcheck reported unhealthy',
          };
        } else {
          return {
            ready: true,
            attempts,
            durationMs: Date.now() - startedMs,
            ...(options.healthcheck ? { healthcheck: options.healthcheck } : {}),
          };
        }
      } else if (options.healthcheck.type === 'http') {
        const endpoint = await options.getEndpoint();
        await probeHttp(endpoint, options.healthcheck.path ?? '/', options.healthcheck.timeoutMs);
        return {
          ready: true,
          attempts,
          durationMs: Date.now() - startedMs,
          healthcheck: options.healthcheck,
        };
      } else if (options.healthcheck.type === 'tcp') {
        const endpoint = await options.getEndpoint();
        await probeTcp(
          endpoint,
          options.healthcheck.port ?? options.containerPort ?? endpoint.port,
          options.healthcheck.timeoutMs,
        );
        return {
          ready: true,
          attempts,
          durationMs: Date.now() - startedMs,
          healthcheck: options.healthcheck,
        };
      } else {
        if (!options.healthcheck.command) {
          throw new Error('command healthcheck has no command');
        }
        const result = await options.runCommand(
          options.healthcheck.command,
          options.healthcheck.timeoutMs,
        );
        if (result.exitCode === 0 && !result.timedOut) {
          return {
            ready: true,
            attempts,
            durationMs: Date.now() - startedMs,
            healthcheck: options.healthcheck,
          };
        }
        lastError = `health command exited with ${result.exitCode}${result.timedOut ? ' after timing out' : ''}`;
      }
    } catch (error) {
      if (options.signal.aborted) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs, options.signal);
  }

  return {
    ready: false,
    attempts,
    durationMs: Date.now() - startedMs,
    ...(lastError ? { lastError } : {}),
    ...(options.healthcheck ? { healthcheck: options.healthcheck } : {}),
  };
}
