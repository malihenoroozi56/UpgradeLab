import type { CheckResult, ReportDocument, Reporter, ScenarioReport } from '@upgradelab/contracts';

/** Escapes XML text and removes characters that are illegal in XML 1.0. */
export function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

interface TestCase {
  readonly name: string;
  readonly className: string;
  readonly timeMs: number;
  readonly status: 'passed' | 'failed' | 'error' | 'skipped';
  readonly message?: string;
  readonly details?: string;
}

function checkToTestCase(scenarioId: string, check: CheckResult): TestCase {
  const status =
    check.status === 'PASSED'
      ? 'passed'
      : check.status === 'FAILED'
        ? 'failed'
        : check.status === 'ERROR'
          ? 'error'
          : 'skipped';
  const details = [
    check.message ?? '',
    check.expected === undefined ? '' : `expected: ${JSON.stringify(check.expected)}`,
    check.actual === undefined ? '' : `actual: ${JSON.stringify(check.actual)}`,
    check.baseline === undefined ? '' : `baseline: ${JSON.stringify(check.baseline)}`,
    check.error ? `error: [${check.error.code}] ${check.error.message}` : '',
    check.evidenceIds.length > 0 ? `evidence: ${check.evidenceIds.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    name: `${check.kind}:${check.id}`,
    className: `upgradelab.${scenarioId}`,
    timeMs: check.durationMs,
    status,
    ...(check.message ? { message: check.message } : {}),
    ...(details ? { details } : {}),
  };
}

function scenarioTestCases(scenario: ScenarioReport): TestCase[] {
  const cases: TestCase[] = scenario.checks.map((check) => checkToTestCase(scenario.id, check));
  for (const step of scenario.setup) {
    cases.push({
      name: `setup:${step.id}`,
      className: `upgradelab.${scenario.id}`,
      timeMs: step.durationMs,
      status: step.status === 'PASSED' ? 'passed' : 'error',
      ...(step.status === 'PASSED'
        ? {}
        : {
            message: `Setup command failed with exit code ${step.exitCode}.`,
            details: [step.stdout, step.stderr].filter(Boolean).join('\n'),
          }),
    });
  }
  if (scenario.status === 'FAILED' && !cases.some((testCase) => testCase.status === 'failed')) {
    cases.push({
      name: 'upgrade-execution',
      className: `upgradelab.${scenario.id}`,
      timeMs: scenario.durationMs,
      status: 'failed',
      message: scenario.error?.message ?? 'Upgrade execution failed.',
      details: scenario.error ? `[${scenario.error.code}] ${scenario.error.message}` : '',
    });
  }
  if (
    scenario.status === 'INCONCLUSIVE' &&
    cases.every((testCase) => testCase.status === 'passed')
  ) {
    cases.push({
      name: 'verdict',
      className: `upgradelab.${scenario.id}`,
      timeMs: 0,
      status: 'error',
      message:
        scenario.error?.message ??
        'Verification was inconclusive: mandatory checks were skipped, errored or not evaluated.',
    });
  }
  if (scenario.cleanup.attempted && !scenario.cleanup.succeeded) {
    cases.push({
      name: 'cleanup',
      className: `upgradelab.${scenario.id}`,
      timeMs: scenario.cleanup.durationMs,
      status: 'error',
      message: 'Environment cleanup failed; resources may still exist.',
      details: scenario.cleanup.warnings.join('\n'),
    });
  }
  return cases;
}

function renderTestCase(testCase: TestCase): string {
  const attributes = [
    `name="${escapeXml(testCase.name)}"`,
    `classname="${escapeXml(testCase.className)}"`,
    `time="${seconds(testCase.timeMs)}"`,
  ].join(' ');
  if (testCase.status === 'passed') {
    return `    <testcase ${attributes} />`;
  }
  const tag =
    testCase.status === 'failed' ? 'failure' : testCase.status === 'error' ? 'error' : 'skipped';
  const type =
    testCase.status === 'failed'
      ? 'AssertionFailure'
      : testCase.status === 'error'
        ? 'ExecutionError'
        : 'Skipped';
  const message = escapeXml(testCase.message ?? '');
  const details = testCase.details ? `\n${escapeXml(testCase.details)}` : '';
  return [
    `    <testcase ${attributes}>`,
    `      <${tag} message="${message}" type="${type}">${details}</${tag}>`,
    '    </testcase>',
  ].join('\n');
}

/** Renders a JUnit XML report consumable by CI test reporters. */
export function renderJUnit(report: ReportDocument): string {
  const suites = report.scenarios.map((scenario) => {
    const cases = scenarioTestCases(scenario);
    const failures = cases.filter((testCase) => testCase.status === 'failed').length;
    const errors = cases.filter((testCase) => testCase.status === 'error').length;
    const skipped = cases.filter((testCase) => testCase.status === 'skipped').length;
    const properties = [
      ['status', scenario.status],
      ['source', scenario.sourceImage],
      ['target', scenario.targetImage],
      ['project', report.project.name],
      ['run', report.run.id],
      ['provider', scenario.environment.provider],
    ]
      .map(
        ([name, value]) =>
          `      <property name="${escapeXml(name ?? '')}" value="${escapeXml(value ?? '')}" />`,
      )
      .join('\n');
    const body = [
      '  <testsuite',
      `    name="${escapeXml(scenario.id)}"`,
      `    tests="${cases.length}"`,
      `    failures="${failures}"`,
      `    errors="${errors}"`,
      `    skipped="${skipped}"`,
      `    time="${seconds(scenario.durationMs)}"`,
      `    timestamp="${scenario.startedAt}"`,
      '    hostname="upgradelab">',
      '    <properties>',
      properties,
      '    </properties>',
    ];
    if (scenario.logs.length > 0) {
      const logText = scenario.logs
        .map((entry) => `[${entry.at}] [${entry.service}/${entry.stream}] ${entry.message}`)
        .join('\n')
        .slice(0, 16_000);
      body.push(`    <system-out>${escapeXml(logText)}</system-out>`);
    }
    body.push(...cases.map(renderTestCase));
    body.push('  </testsuite>');
    return body.join('\n');
  });

  const allCases = report.scenarios.flatMap((scenario) => scenarioTestCases(scenario));
  const failures = allCases.filter((testCase) => testCase.status === 'failed').length;
  const errors = allCases.filter((testCase) => testCase.status === 'error').length;
  const skipped = allCases.filter((testCase) => testCase.status === 'skipped').length;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="UpgradeLab ${escapeXml(report.run.id)}" tests="${allCases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${seconds(report.run.durationMs)}">`,
    ...suites,
    '</testsuites>',
    '',
  ].join('\n');
}

export const junitReporter: Reporter = {
  format: 'junit',
  fileExtension: 'xml',
  render: renderJUnit,
};
