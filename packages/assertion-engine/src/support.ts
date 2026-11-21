import net from 'node:net';
import { UpgradeLabError } from '@upgradelab/contracts';

export const MAX_BODY_BYTES = 64 * 1024;

/** Truncates long strings for report fields. */
export function truncate(value: string, limit = 8_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`;
}

export function formatValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/** Resolves a dotted/bracketed JSON path such as `data.users[0].id`. */
export function getJsonPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  const tokens: (string | number)[] = [];
  const pattern = /([^.[\]]+)|\[(\d+)\]/g;
  for (const match of path.matchAll(pattern)) {
    if (match[2] !== undefined) {
      tokens.push(Number(match[2]));
    } else if (match[1] !== undefined) {
      tokens.push(match[1]);
    }
  }
  if (tokens.length === 0) {
    return { found: false };
  }
  let current: unknown = root;
  for (const token of tokens) {
    if (typeof token === 'number') {
      if (!Array.isArray(current) || token >= current.length) {
        return { found: false };
      }
      current = current[token];
      continue;
    }
    if (current === null || typeof current !== 'object' || !(token in current)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[token];
  }
  return { found: true, value: current };
}

/** Structural equality for JSON-like values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const aEntries = Object.entries(a as Record<string, unknown>);
    const bEntries = Object.entries(b as Record<string, unknown>);
    if (aEntries.length !== bEntries.length) {
      return false;
    }
    return aEntries.every(([key, value]) => deepEqual(value, (b as Record<string, unknown>)[key]));
  }
  return false;
}

/** Compiles a user-supplied regular expression, translating failures into config errors. */
export function compileRegex(source: string, label: string): RegExp {
  try {
    return new RegExp(source);
  } catch (error) {
    throw new UpgradeLabError(`Invalid regular expression in ${label}: ${source}`, {
      code: 'ASSERTION_ERROR',
      details: { label, source },
      cause: error,
      hint: 'Use a valid JavaScript regular expression without flags.',
    });
  }
}

export interface HttpRequestOptions {
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly durationMs: number;
}

/**
 * Performs an HTTP request with an explicit timeout.
 *
 * Only http(s) URLs are allowed: the assertion layer must never be able to read
 * local files or speak to arbitrary protocols through `fetch`.
 */
export async function httpRequest(url: string, options: HttpRequestOptions): Promise<HttpResponse> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UpgradeLabError(
      `Unsupported URL scheme "${parsed.protocol}" for an HTTP assertion.`,
      {
        code: 'ASSERTION_ERROR',
        details: { url },
        hint: 'Only http and https URLs are supported.',
      },
    );
  }
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any([options.signal, timeoutSignal]);
  const startedMs = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers: { ...options.headers },
      signal,
      redirect: 'follow',
    });
  } catch (error) {
    if (options.signal.aborted) {
      throw error;
    }
    if (timeoutSignal.aborted) {
      throw new UpgradeLabError(
        `HTTP ${options.method} ${url} timed out after ${options.timeoutMs} ms.`,
        {
          code: 'EXECUTION_TIMEOUT',
          details: { url, method: options.method, timeoutMs: options.timeoutMs },
        },
      );
    }
    throw new UpgradeLabError(
      `HTTP ${options.method} ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'ASSERTION_FAILED', details: { url, method: options.method }, cause: error },
    );
  }
  const body = (await response.text()).slice(0, MAX_BODY_BYTES);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, body, durationMs: Date.now() - startedMs };
}

/** Checks whether a TCP connection can be established. */
export async function tcpProbe(
  host: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ connected: boolean; error?: string; durationMs: number }> {
  const startedMs = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (connected: boolean, error?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      signal.removeEventListener('abort', onAbort);
      resolve({
        connected,
        ...(error ? { error } : {}),
        durationMs: Date.now() - startedMs,
      });
    };
    const timer = setTimeout(
      () => finish(false, `connection timed out after ${timeoutMs} ms`),
      timeoutMs,
    );
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      finish(false, 'connection aborted');
    };
    socket.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once('error', (error: Error) => {
      clearTimeout(timer);
      finish(false, error.message);
    });
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Joins a base URL and a path without double slashes. */
export function joinUrl(baseUrl: string, requestPath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  return `${base}${suffix}`;
}
