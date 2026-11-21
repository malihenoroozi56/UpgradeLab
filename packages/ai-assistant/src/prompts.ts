import type { CheckResult, ReportDocument, ScenarioReport } from '@upgradelab/contracts';

export const AI_DISCLAIMER =
  'AI output is advisory only. It never determines the test verdict, and any suggested command, patch or migration must be reviewed by a human before use.';

export const SYSTEM_PROMPT = `You are a senior database reliability engineer helping a maintainer diagnose a failed software upgrade test.

Rules:
- The deterministic test verdict is authoritative. Never claim that an upgrade succeeded.
- Base your answer only on the provided evidence. Say "unknown" when evidence is missing.
- Focus on data loss, broken migrations, schema incompatibilities, configuration drift and availability.
- Never invent table names, columns, versions or log lines.
- Do not include credentials, tokens or connection strings in your answer.
- Suggest only read-only diagnostic commands. Never suggest destructive commands such as dropping data or running migrations against production.
- Respond with a single JSON object matching:
  {"summary": string, "details": string, "suggestions": [{"title": string, "detail": string}]}
- "summary" is at most 3 sentences. "details" may use short markdown. Provide at most 5 suggestions.`;

const MAX_LOG_LINES = 120;
const MAX_LOG_LINE_CHARS = 400;
const MAX_CONTEXT_CHARS = 24_000;

function formatValue(value: unknown): string {
  if (value === undefined) {
    return 'n/a';
  }
  try {
    const text = JSON.stringify(value);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return String(value);
  }
}

function formatCheck(check: CheckResult): string {
  const lines = [
    `- [${check.kind}/${check.type}] ${check.id}: ${check.status} (required=${check.required})`,
    `  message: ${check.message ?? 'none'}`,
  ];
  if (check.expected !== undefined) {
    lines.push(`  expected: ${formatValue(check.expected)}`);
  }
  if (check.actual !== undefined) {
    lines.push(`  actual: ${formatValue(check.actual)}`);
  }
  if (check.baseline !== undefined) {
    lines.push(`  baseline: ${formatValue(check.baseline)}`);
  }
  if (check.error) {
    lines.push(`  error: ${check.error.code}: ${check.error.message}`);
  }
  return lines.join('\n');
}

export interface ScenarioContextOptions {
  readonly includeLogs?: boolean;
  readonly includeQueries?: boolean;
}

/** Builds a bounded, evidence-grounded prompt context for one scenario. */
export function buildScenarioContext(
  scenario: ScenarioReport,
  options: ScenarioContextOptions = {},
): string {
  const failing = scenario.checks.filter(
    (check) => check.status === 'FAILED' || check.status === 'ERROR' || check.status === 'SKIPPED',
  );
  const relevantChecks = failing.length > 0 ? failing : scenario.checks;
  const lines: string[] = [
    `SCENARIO: ${scenario.id}`,
    `STATUS: ${scenario.status}`,
    `DESCRIPTION: ${scenario.description ?? 'none'}`,
    `UPGRADE PATH: ${scenario.imagePath.join(' -> ')}`,
    `PROVIDER: ${scenario.environment.provider}`,
    '',
    'CHECKS:',
    ...relevantChecks.map(formatCheck),
  ];

  if (scenario.error) {
    lines.push('', `EXECUTION ERROR: ${scenario.error.code}: ${scenario.error.message}`);
  }
  if (scenario.hops.length > 0) {
    lines.push('', 'UPGRADE HOPS:');
    for (const hop of scenario.hops) {
      lines.push(
        `- hop ${hop.index}: ${hop.image}, ready=${hop.ready}, attempts=${hop.readinessAttempts}, durationMs=${hop.durationMs}${hop.error ? `, error=${hop.error.message}` : ''}`,
      );
    }
  }
  const failedSetup = scenario.setup.filter((step) => step.status !== 'PASSED');
  if (failedSetup.length > 0) {
    lines.push('', 'FAILED SETUP COMMANDS:');
    for (const step of failedSetup) {
      lines.push(
        `- ${step.target}: ${step.command.join(' ')} (exit ${step.exitCode})`,
        `  stdout: ${step.stdout.slice(0, 500)}`,
        `  stderr: ${step.stderr.slice(0, 500)}`,
      );
    }
  }
  if (options.includeQueries) {
    const queries = scenario.checks
      .filter((check) => check.type === 'sql')
      .map((check) => check.id);
    if (queries.length > 0) {
      lines.push('', `SQL CHECKS: ${queries.join(', ')}`);
    }
  }
  const warnings = scenario.events.filter(
    (event) => event.type === 'warning' || event.type === 'error',
  );
  if (warnings.length > 0) {
    lines.push('', 'WARNINGS:');
    for (const warning of warnings.slice(-10)) {
      lines.push(`- ${warning.message}`);
    }
  }
  if (scenario.cleanup.warnings.length > 0) {
    lines.push('', 'CLEANUP WARNINGS:', ...scenario.cleanup.warnings.map((item) => `- ${item}`));
  }

  if (options.includeLogs !== false) {
    const tail = scenario.logs.slice(-MAX_LOG_LINES);
    lines.push('', `LOGS (last ${tail.length} lines):`);
    for (const entry of tail) {
      lines.push(`[${entry.service}] ${entry.message.slice(0, MAX_LOG_LINE_CHARS)}`);
    }
  }

  const context = lines.join('\n');
  return context.length > MAX_CONTEXT_CHARS
    ? `${context.slice(0, MAX_CONTEXT_CHARS)}\n…[context truncated]`
    : context;
}

export function buildRunContext(report: ReportDocument): string {
  const lines = [
    `RUN: ${report.run.id}`,
    `RUN STATUS: ${report.run.status}`,
    `PROJECT: ${report.project.name}`,
    `TOOL: ${report.tool.name} ${report.tool.version}`,
    '',
    'SCENARIOS:',
  ];
  for (const scenario of report.scenarios) {
    lines.push(
      `- ${scenario.id}: ${scenario.status} (${scenario.sourceImage} -> ${scenario.targetImage}), checks ${scenario.counts.passed}/${scenario.counts.total} passed, failed=${scenario.counts.failed}, errored=${scenario.counts.errored}`,
    );
    for (const check of scenario.checks.filter(
      (item) => item.status === 'FAILED' || item.status === 'ERROR',
    )) {
      lines.push(`  - ${check.id} (${check.type}): ${check.status}: ${check.message ?? ''}`);
    }
    if (scenario.error) {
      lines.push(`  - execution error: ${scenario.error.code}: ${scenario.error.message}`);
    }
  }
  return lines.join('\n');
}

/** Deterministic GitHub issue body used when AI is disabled or fails. */
export function renderDeterministicIssue(
  report: ReportDocument,
  scenario: ScenarioReport,
): { title: string; body: string } {
  const failed = scenario.checks.filter(
    (check) => check.status === 'FAILED' || check.status === 'ERROR',
  );
  const title = `[upgradelab] ${scenario.id}: ${scenario.sourceImage} -> ${scenario.targetImage} ${scenario.status.toLowerCase()}`;
  const checks = failed.length
    ? failed
        .map(
          (check) =>
            `- **${check.id}** (${check.kind}/${check.type}) — ${check.status}\n  ${check.message ?? ''}\n  expected: \`${formatValue(check.expected)}\`\n  actual: \`${formatValue(check.actual)}\``,
        )
        .join('\n')
    : '_No failing checks were recorded; see the execution error below._';
  const body = [
    '## UpgradeLab upgrade failure',
    '',
    `- **Project:** ${report.project.name}`,
    `- **Scenario:** \`${scenario.id}\``,
    `- **Upgrade path:** \`${scenario.imagePath.join('` -> `')}\``,
    `- **Verdict:** ${scenario.status}`,
    `- **Run:** \`${report.run.id}\``,
    '',
    '### Failing checks',
    '',
    checks,
    '',
  ];
  if (scenario.error) {
    body.push('### Execution error', '', '```text', scenario.error.message, '```', '');
  }
  if (scenario.logs.length > 0) {
    body.push(
      '### Log tail',
      '',
      '```text',
      scenario.logs
        .slice(-60)
        .map((entry) => `[${entry.service}] ${entry.message}`)
        .join('\n'),
      '```',
      '',
    );
  }
  body.push(
    '### Reproduction',
    '',
    '```bash',
    `upgradelab run --scenario ${scenario.id}`,
    '```',
    '',
    '_Generated by UpgradeLab from deterministic test evidence. Review before sharing; reports are redacted but logs can still contain unexpected data._',
    '',
  );
  return { title, body: body.join('\n') };
}
