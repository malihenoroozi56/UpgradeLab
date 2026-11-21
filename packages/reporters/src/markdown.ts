import type {
  CheckResult,
  ReportDocument,
  Reporter,
  ScenarioReport,
  SetupExecutionResult,
} from '@upgradelab/contracts';

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function code(value: unknown, limit = 400): string {
  if (value === undefined) {
    return '—';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const truncated = text.length > limit ? `${text.slice(0, limit)}…` : text;
  return `\`${escapeCell(truncated)}\``;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function statusIcon(status: string): string {
  switch (status) {
    case 'PASSED':
      return '✅ PASSED';
    case 'FAILED':
      return '❌ FAILED';
    case 'INCONCLUSIVE':
      return '⚠️ INCONCLUSIVE';
    case 'CANCELLED':
      return '⏹️ CANCELLED';
    case 'ERROR':
      return '💥 ERROR';
    case 'SKIPPED':
      return '⏭️ SKIPPED';
    default:
      return status;
  }
}

function checksTable(checks: readonly CheckResult[]): string {
  if (checks.length === 0) {
    return '_No checks were recorded._';
  }
  const lines = [
    '| Check | Type | Status | Required | Duration | Message |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const check of checks) {
    lines.push(
      `| \`${check.id}\` | ${check.type} | ${statusIcon(check.status)} | ${check.required ? 'yes' : 'no'} | ${seconds(check.durationMs)} | ${escapeCell(check.message ?? '')} |`,
    );
  }
  return lines.join('\n');
}

function failureDetails(checks: readonly CheckResult[]): string {
  const problems = checks.filter((check) => check.status === 'FAILED' || check.status === 'ERROR');
  if (problems.length === 0) {
    return '';
  }
  const sections = problems.map((check) => {
    const lines = [
      `#### ${statusIcon(check.status)} \`${check.id}\` (${check.type})`,
      '',
      check.message ?? 'No message recorded.',
      '',
    ];
    if (check.expected !== undefined) {
      lines.push(`- **Expected:** ${code(check.expected)}`);
    }
    if (check.actual !== undefined) {
      lines.push(`- **Actual:** ${code(check.actual)}`);
    }
    if (check.baseline !== undefined) {
      lines.push(`- **Baseline:** ${code(check.baseline)}`);
    }
    if (check.error) {
      lines.push(`- **Error:** \`${check.error.code}\` ${escapeCell(check.error.message)}`);
    }
    if (check.evidenceIds.length > 0) {
      lines.push(`- **Evidence:** ${check.evidenceIds.map((id) => `\`${id}\``).join(', ')}`);
    }
    return lines.join('\n');
  });
  return ['### Failure details', '', ...sections].join('\n');
}

function setupSection(setup: readonly SetupExecutionResult[]): string {
  if (setup.length === 0) {
    return '';
  }
  const lines = [
    '### Setup commands',
    '',
    '| Command | Target | Status | Exit code | Duration |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const step of setup) {
    lines.push(
      `| \`${escapeCell(step.command.join(' '))}\` | ${step.target} | ${statusIcon(step.status)} | ${step.exitCode} | ${seconds(step.durationMs)} |`,
    );
  }
  return lines.join('\n');
}

function evidenceSection(scenario: ScenarioReport): string {
  if (scenario.evidence.length === 0) {
    return '';
  }
  const failingEvidence = new Set(
    scenario.checks
      .filter((check) => check.status === 'FAILED' || check.status === 'ERROR')
      .flatMap((check) => check.evidenceIds),
  );
  const lines = [
    '### Evidence',
    '',
    '| ID | Kind | Description | Size | Truncated |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const item of scenario.evidence) {
    lines.push(
      `| \`${item.id}\` | ${item.kind} | ${escapeCell(item.description)} | ${item.bytes} B | ${item.truncated ? 'yes' : 'no'} |`,
    );
  }
  const excerpts = scenario.evidence.filter(
    (item) => failingEvidence.has(item.id) && item.inline && item.inline.length > 0,
  );
  for (const item of excerpts.slice(0, 3)) {
    lines.push(
      '',
      `<details><summary>Evidence <code>${item.id}</code>: ${escapeCell(item.description)}</summary>`,
      '',
      '```text',
      (item.inline ?? '').slice(0, 4_000),
      '```',
      '',
      '</details>',
    );
  }
  return lines.join('\n');
}

function scenarioSection(scenario: ScenarioReport): string {
  const parts: string[] = [];
  parts.push(`## Scenario \`${scenario.id}\` — ${statusIcon(scenario.status)}`);
  parts.push('');
  if (scenario.description) {
    parts.push(scenario.description, '');
  }
  parts.push(
    `- **Upgrade path:** ${scenario.imagePath.map((image) => `\`${image}\``).join(' → ')}`,
    `- **Duration:** ${seconds(scenario.durationMs)}`,
    `- **Checks:** ${scenario.counts.passed} passed, ${scenario.counts.failed} failed, ${scenario.counts.errored} errored, ${scenario.counts.skipped} skipped (${scenario.counts.total} total)`,
    `- **Environment:** ${scenario.environment.provider} project \`${scenario.environment.projectName}\``,
    `- **Cleanup:** ${scenario.cleanup.attempted ? (scenario.cleanup.succeeded ? 'succeeded' : 'FAILED') : 'not required'}`,
    '',
  );
  if (scenario.error) {
    parts.push(
      `> **Execution error:** \`${scenario.error.code}\` — ${escapeCell(scenario.error.message)}`,
      '',
    );
  }
  if (scenario.cleanup.warnings.length > 0) {
    parts.push(
      '> **Cleanup warnings:**',
      ...scenario.cleanup.warnings.map((warning) => `> - ${escapeCell(warning)}`),
      '',
    );
  }
  if (scenario.hops.length > 0) {
    parts.push(
      '### Upgrade hops',
      '',
      '| Hop | Image | Ready | Readiness attempts | Duration |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const hop of scenario.hops) {
      parts.push(
        `| ${hop.index} | \`${hop.image}\` | ${hop.ready ? 'yes' : 'no'} | ${hop.readinessAttempts} | ${seconds(hop.durationMs)} |`,
      );
    }
    parts.push('');
  }
  const setup = setupSection(scenario.setup);
  if (setup) {
    parts.push(setup, '');
  }
  parts.push(
    '### Invariants',
    '',
    checksTable(scenario.checks.filter((c) => c.kind === 'invariant')),
    '',
  );
  parts.push(
    '### Assertions',
    '',
    checksTable(scenario.checks.filter((c) => c.kind === 'assertion')),
    '',
  );
  const failures = failureDetails(scenario.checks);
  if (failures) {
    parts.push(failures, '');
  }
  const evidence = evidenceSection(scenario);
  if (evidence) {
    parts.push(evidence, '');
  }
  if (scenario.logs.length > 0) {
    parts.push(
      '### Logs (tail)',
      '',
      '```text',
      scenario.logs
        .map((entry) => `[${entry.at}] [${entry.service}/${entry.stream}] ${entry.message}`)
        .join('\n')
        .slice(0, 20_000),
      '```',
      '',
    );
  }
  if (scenario.aiAdvisories && scenario.aiAdvisories.length > 0) {
    parts.push('### AI advisories (advisory only)', '');
    for (const advisory of scenario.aiAdvisories) {
      parts.push(
        `#### ${advisory.kind}`,
        '',
        advisory.summary,
        '',
        ...(advisory.details ? [advisory.details, ''] : []),
        ...advisory.suggestions.map(
          (suggestion) => `- **${suggestion.title}:** ${suggestion.detail}`,
        ),
        '',
        `_${advisory.disclaimer}_`,
        '',
      );
    }
  }
  return parts.join('\n');
}

/** Renders a human-readable Markdown report. */
export function renderMarkdown(report: ReportDocument): string {
  const lines = [
    '# UpgradeLab report',
    '',
    `**Status:** ${statusIcon(report.run.status)}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Project | \`${escapeCell(report.project.name)}\` |`,
    `| Run | \`${report.run.id}\` |`,
    `| Started | ${report.run.startedAt} |`,
    `| Finished | ${report.run.finishedAt} |`,
    `| Duration | ${seconds(report.run.durationMs)} |`,
    `| Configuration | \`${escapeCell(report.run.configPath)}\` |`,
    `| Tool | ${report.tool.name} ${report.tool.version} |`,
    `| Node | ${report.run.environment.nodeVersion} (${report.run.environment.platform}/${report.run.environment.arch}) |`,
    '',
  ];
  if (report.scenarios.length === 0) {
    lines.push('_No scenarios were executed._');
  } else {
    lines.push(
      '## Summary',
      '',
      '| Scenario | Status | From | To | Duration | Passed | Failed |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const scenario of report.scenarios) {
      lines.push(
        `| \`${scenario.id}\` | ${statusIcon(scenario.status)} | \`${scenario.sourceImage}\` | \`${scenario.targetImage}\` | ${seconds(scenario.durationMs)} | ${scenario.counts.passed} | ${scenario.counts.failed} |`,
      );
    }
    lines.push('');
    for (const scenario of report.scenarios) {
      lines.push(scenarioSection(scenario), '');
    }
  }
  if (report.ai.enabled) {
    lines.push(
      '## AI analysis',
      '',
      `Provider: ${report.ai.provider ?? 'unknown'}, model: ${report.ai.model ?? 'unknown'}.`,
      '',
    );
    for (const advisory of report.ai.advisories) {
      lines.push(`- **${advisory.kind}** (${advisory.scenarioId ?? 'run'}): ${advisory.summary}`);
    }
    lines.push('', '_AI output is advisory only and never determines the verdict._', '');
  }
  lines.push(`_Generated by ${report.tool.name} ${report.tool.version}._`, '');
  return lines.join('\n');
}

export const markdownReporter: Reporter = {
  format: 'markdown',
  fileExtension: 'md',
  render: renderMarkdown,
};
