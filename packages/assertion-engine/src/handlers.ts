import {
  UpgradeLabError,
  type AssertionConfig,
  type AssertionExecutionResult,
  type AssertionHandler,
  type CheckContext,
  type CommandAssertionConfig,
  type ContainerAssertionConfig,
  type HealthAssertionConfig,
  type HttpAssertionConfig,
  type InvariantConfig,
  type InvariantHandler,
  type QueryResult,
  type SqlAssertionConfig,
} from '@upgradelab/contracts';
import { compareSqlResult, type SqlBaseline } from './comparison.js';
import {
  compileRegex,
  deepEqual,
  formatValue,
  getJsonPath,
  httpRequest,
  joinUrl,
  tcpProbe,
} from './support.js';

function assertType<T extends AssertionConfig>(
  assertion: AssertionConfig,
  type: string,
): asserts assertion is T {
  if (assertion.type !== type || 'params' in assertion) {
    throw new UpgradeLabError(
      `Assertion handler for "${type}" received a "${assertion.type}" assertion.`,
      { code: 'INTERNAL_ERROR' },
    );
  }
}

function httpEvidenceBody(response: {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
  durationMs: number;
}): string {
  const headerLines = Object.entries(response.headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  return [
    `status: ${response.status}`,
    `durationMs: ${response.durationMs}`,
    '--- headers ---',
    headerLines,
    '--- body ---',
    response.body,
  ].join('\n');
}

export const httpAssertionHandler: AssertionHandler = {
  type: 'http',
  description: 'Verifies an HTTP endpoint status, body and JSON fields.',
  async execute(assertion, ctx): Promise<AssertionExecutionResult> {
    assertType<HttpAssertionConfig>(assertion, 'http');
    const endpoint = assertion.url ? undefined : await ctx.application.endpoint();
    const url = assertion.url ?? joinUrl(endpoint?.baseUrl ?? '', assertion.path ?? '/');
    const evidence = ctx.evidence.add(
      'http',
      `HTTP ${assertion.method} ${url}`,
      `request: ${assertion.method} ${url}`,
      { mediaType: 'text/plain' },
    );

    let response;
    try {
      response = await httpRequest(url, {
        method: assertion.method,
        ...(assertion.headers ? { headers: assertion.headers } : {}),
        signal: ctx.signal,
        timeoutMs: assertion.timeoutMs ?? ctx.defaultTimeoutMs,
      });
    } catch (error) {
      if (error instanceof UpgradeLabError && error.code === 'ASSERTION_FAILED') {
        return {
          passed: false,
          message: error.message,
          expected: { status: assertion.expectedStatus },
          actual: { error: error.message },
          evidenceIds: [evidence.id],
        };
      }
      throw error;
    }

    const requestEvidence = ctx.evidence.add(
      'http',
      `HTTP response for ${url}`,
      httpEvidenceBody(response),
      { mediaType: 'text/plain' },
    );

    const problems: string[] = [];
    if (response.status !== assertion.expectedStatus) {
      problems.push(`expected status ${assertion.expectedStatus}, got ${response.status}`);
    }
    if (assertion.bodyContains && !response.body.includes(assertion.bodyContains)) {
      problems.push(`response body does not contain ${JSON.stringify(assertion.bodyContains)}`);
    }

    let parsedJson: unknown;
    let jsonParsed = false;
    if (assertion.jsonPath) {
      try {
        parsedJson = JSON.parse(response.body) as unknown;
        jsonParsed = true;
      } catch {
        problems.push('response body is not valid JSON');
      }
    }
    if (jsonParsed && assertion.jsonPath) {
      const extracted = getJsonPath(parsedJson, assertion.jsonPath);
      if (!extracted.found) {
        problems.push(`JSON path "${assertion.jsonPath}" was not found`);
      } else if (
        assertion.jsonEquals !== undefined &&
        !deepEqual(extracted.value, assertion.jsonEquals)
      ) {
        problems.push(
          `JSON path "${assertion.jsonPath}" is ${formatValue(extracted.value)}, expected ${formatValue(assertion.jsonEquals)}`,
        );
      } else if (assertion.jsonMatches !== undefined) {
        const regex = compileRegex(
          assertion.jsonMatches,
          `assertion "${assertion.id}".jsonMatches`,
        );
        if (!regex.test(formatValue(extracted.value))) {
          problems.push(
            `JSON path "${assertion.jsonPath}" value ${formatValue(extracted.value)} does not match /${assertion.jsonMatches}/`,
          );
        }
      }
    }

    const evidenceIds = [evidence.id, requestEvidence.id];
    return {
      passed: problems.length === 0,
      message:
        problems.length === 0
          ? `HTTP ${assertion.method} ${url} returned ${response.status} as expected.`
          : `HTTP assertion failed: ${problems.join('; ')}.`,
      expected: {
        status: assertion.expectedStatus,
        ...(assertion.bodyContains ? { bodyContains: assertion.bodyContains } : {}),
        ...(assertion.jsonPath ? { jsonPath: assertion.jsonPath } : {}),
      },
      actual: { status: response.status },
      evidenceIds,
    };
  },
};

export const commandAssertionHandler: AssertionHandler = {
  type: 'command',
  description: 'Runs a command inside a service container and verifies its exit code and output.',
  async execute(assertion, ctx): Promise<AssertionExecutionResult> {
    assertType<CommandAssertionConfig>(assertion, 'command');
    const timeoutMs = assertion.timeoutMs ?? ctx.defaultTimeoutMs;
    const result = await ctx.environment.runCommand({
      service: assertion.target,
      command: assertion.command,
      timeoutMs,
    });
    const evidence = ctx.evidence.add(
      'command',
      `Command assertion "${assertion.id}" on ${assertion.target}`,
      [
        `$ ${assertion.command.join(' ')}`,
        `exitCode: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`,
        '--- stdout ---',
        result.stdout,
        '--- stderr ---',
        result.stderr,
      ].join('\n'),
    );

    const problems: string[] = [];
    if (result.exitCode !== assertion.expectedExitCode) {
      problems.push(`expected exit code ${assertion.expectedExitCode}, got ${result.exitCode}`);
    }
    if (result.timedOut) {
      problems.push(`command timed out after ${timeoutMs} ms`);
    }
    if (assertion.stdoutContains && !result.stdout.includes(assertion.stdoutContains)) {
      problems.push(`stdout does not contain ${JSON.stringify(assertion.stdoutContains)}`);
    }
    if (assertion.stdoutMatches) {
      const regex = compileRegex(
        assertion.stdoutMatches,
        `assertion "${assertion.id}".stdoutMatches`,
      );
      if (!regex.test(result.stdout)) {
        problems.push(`stdout does not match /${assertion.stdoutMatches}/`);
      }
    }
    if (assertion.stderrContains && !result.stderr.includes(assertion.stderrContains)) {
      problems.push(`stderr does not contain ${JSON.stringify(assertion.stderrContains)}`);
    }

    return {
      passed: problems.length === 0,
      message:
        problems.length === 0
          ? `Command on "${assertion.target}" exited with ${result.exitCode} as expected.`
          : `Command assertion failed: ${problems.join('; ')}.`,
      expected: { exitCode: assertion.expectedExitCode },
      actual: { exitCode: result.exitCode, timedOut: result.timedOut },
      evidenceIds: [evidence.id],
    };
  },
};

export const sqlAssertionHandler: AssertionHandler = {
  type: 'sql',
  description: 'Runs a read-only SQL query and compares its result with an expected value.',
  async execute(assertion, ctx): Promise<AssertionExecutionResult> {
    assertType<SqlAssertionConfig>(assertion, 'sql');
    if (!ctx.database) {
      throw new UpgradeLabError(
        `SQL assertion "${assertion.id}" requires environment.database to be configured.`,
        { code: 'ASSERTION_ERROR' },
      );
    }
    const result = await ctx.database.execute(assertion.query);
    const evidence = sqlEvidence(ctx, assertion.id, assertion.query, result);
    const outcome = compareSqlResult({
      comparison: assertion.comparison,
      expected: assertion.expected,
      ...(assertion.tolerance !== undefined ? { tolerance: assertion.tolerance } : {}),
      current: result,
    });
    return {
      passed: outcome.passed,
      message: outcome.message,
      ...(outcome.expected !== undefined ? { expected: outcome.expected } : {}),
      ...(outcome.actual !== undefined ? { actual: outcome.actual } : {}),
      evidenceIds: [evidence.id],
    };
  },
};

export const containerAssertionHandler: AssertionHandler = {
  type: 'container',
  description: 'Verifies the runtime state and health of a service container.',
  async execute(assertion, ctx): Promise<AssertionExecutionResult> {
    assertType<ContainerAssertionConfig>(assertion, 'container');
    const state = await ctx.environment.serviceState(assertion.target);
    const evidence = ctx.evidence.add(
      'container',
      `Container state for ${assertion.target}`,
      JSON.stringify(state, null, 2),
      { mediaType: 'application/json' },
    );
    const passed =
      assertion.state === 'running'
        ? state.state === 'running'
        : assertion.state === 'healthy'
          ? state.state === 'running' && state.health === 'healthy'
          : state.state === 'exited';
    return {
      passed,
      message: passed
        ? `Service "${assertion.target}" is ${assertion.state}.`
        : `Service "${assertion.target}" is ${state.state} (health: ${state.health}), expected ${assertion.state}.`,
      expected: { state: assertion.state },
      actual: { state: state.state, health: state.health },
      evidenceIds: [evidence.id],
    };
  },
};

export const healthAssertionHandler: AssertionHandler = {
  type: 'health',
  description: 'Runs the configured application healthcheck against the running release.',
  async execute(assertion, ctx): Promise<AssertionExecutionResult> {
    assertType<HealthAssertionConfig>(assertion, 'health');
    const healthcheck = ctx.application.healthcheck;
    if (!healthcheck) {
      throw new UpgradeLabError(
        `Health assertion "${assertion.id}" requires environment.application.healthcheck.`,
        { code: 'ASSERTION_ERROR' },
      );
    }
    const timeoutMs = assertion.timeoutMs ?? healthcheck.timeoutMs ?? ctx.defaultTimeoutMs;

    if (healthcheck.type === 'command') {
      if (!healthcheck.command) {
        throw new UpgradeLabError('Command healthcheck has no command.', {
          code: 'ASSERTION_ERROR',
        });
      }
      const result = await ctx.environment.runCommand({
        service: assertion.target ?? ctx.application.service,
        command: healthcheck.command,
        timeoutMs,
      });
      const evidence = ctx.evidence.add(
        'command',
        `Health command for ${assertion.target ?? ctx.application.service}`,
        `exitCode: ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
      );
      return {
        passed: result.exitCode === 0 && !result.timedOut,
        message:
          result.exitCode === 0 && !result.timedOut
            ? 'Health command succeeded.'
            : `Health command failed with exit code ${result.exitCode}.`,
        expected: { exitCode: 0 },
        actual: { exitCode: result.exitCode },
        evidenceIds: [evidence.id],
      };
    }

    const endpoint = await ctx.application.endpoint();
    if (healthcheck.type === 'http') {
      const url = joinUrl(endpoint.baseUrl, healthcheck.path ?? '/');
      const response = await httpRequest(url, {
        method: 'GET',
        signal: ctx.signal,
        timeoutMs,
      });
      const evidence = ctx.evidence.add(
        'http',
        `Health endpoint ${url}`,
        httpEvidenceBody(response),
      );
      const passed = response.status >= 200 && response.status < 400;
      return {
        passed,
        message: passed
          ? `Health endpoint responded with ${response.status}.`
          : `Health endpoint responded with ${response.status}.`,
        expected: { status: '2xx/3xx' },
        actual: { status: response.status },
        evidenceIds: [evidence.id],
      };
    }

    const probe = await tcpProbe(
      endpoint.host,
      healthcheck.port ?? ctx.application.containerPort ?? endpoint.port,
      timeoutMs,
      ctx.signal,
    );
    const evidence = ctx.evidence.add(
      'container',
      `TCP healthcheck ${endpoint.host}:${healthcheck.port ?? ctx.application.containerPort ?? endpoint.port}`,
      JSON.stringify(probe, null, 2),
    );
    return {
      passed: probe.connected,
      message: probe.connected
        ? 'TCP healthcheck succeeded.'
        : `TCP healthcheck failed: ${probe.error ?? 'unknown error'}.`,
      expected: { connected: true },
      actual: { connected: probe.connected },
      evidenceIds: [evidence.id],
    };
  },
};

/**
 * SQL invariants capture a baseline before the upgrade and re-run the same
 * query afterwards. A query that fails after the upgrade is treated as FAILED
 * (for example a dropped column), not as an infrastructure error.
 */
export const sqlInvariantHandler: InvariantHandler = {
  type: 'sql',
  description: 'Captures a read-only SQL value before the upgrade and compares it afterwards.',
  async capture(invariant: InvariantConfig, ctx) {
    if (!ctx.database) {
      throw new UpgradeLabError(
        `SQL invariant "${invariant.id}" requires environment.database to be configured.`,
        { code: 'ASSERTION_ERROR' },
      );
    }
    const result = await ctx.database.execute(invariant.query);
    const evidence = sqlEvidence(ctx, invariant.id, invariant.query, result);
    const baseline: SqlBaseline = {
      columns: [...result.columns],
      rows: [...result.rows],
      values: [...result.values],
      rowCount: result.rowCount,
      capturedAt: result.executedAt,
    };
    ctx.logger.info('Captured invariant baseline.', {
      invariant: invariant.id,
      values: baseline.values,
    });
    return { baseline, evidenceIds: [evidence.id] };
  },

  async evaluate(invariant, baseline, ctx) {
    if (!ctx.database) {
      throw new UpgradeLabError(
        `SQL invariant "${invariant.id}" requires environment.database to be configured.`,
        { code: 'ASSERTION_ERROR' },
      );
    }
    let result: QueryResult;
    try {
      result = await ctx.database.execute(invariant.query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const evidence = ctx.evidence.add(
        'query',
        `Invariant "${invariant.id}" query failed after upgrade`,
        `query: ${invariant.query}\nerror: ${message}`,
      );
      return {
        passed: false,
        message: `Invariant query failed after the upgrade: ${message}`,
        actual: { error: message },
        evidenceIds: [evidence.id],
      };
    }
    const evidence = sqlEvidence(ctx, invariant.id, invariant.query, result);
    const outcome = compareSqlResult({
      comparison: invariant.comparison,
      expected: invariant.expected,
      ...(invariant.tolerance !== undefined ? { tolerance: invariant.tolerance } : {}),
      baseline,
      current: result,
    });
    return {
      passed: outcome.passed,
      message: outcome.message,
      ...(outcome.expected !== undefined ? { expected: outcome.expected } : {}),
      ...(outcome.actual !== undefined ? { actual: outcome.actual } : {}),
      ...(outcome.baseline !== undefined ? { baseline: outcome.baseline } : {}),
      evidenceIds: [evidence.id],
    };
  },
};

function sqlEvidence(ctx: CheckContext, id: string, query: string, result: QueryResult) {
  return ctx.evidence.add(
    'query',
    `SQL result for "${id}"`,
    JSON.stringify(
      {
        query,
        columns: result.columns,
        rowCount: result.rowCount,
        truncated: result.truncated,
        durationMs: result.durationMs,
        rows: result.rows,
      },
      null,
      2,
    ),
    { mediaType: 'application/json' },
  );
}

export const builtinAssertionHandlers: readonly AssertionHandler[] = [
  httpAssertionHandler,
  commandAssertionHandler,
  sqlAssertionHandler,
  containerAssertionHandler,
  healthAssertionHandler,
];
