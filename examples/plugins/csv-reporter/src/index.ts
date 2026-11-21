import type {
  CheckResult,
  ReportDocument,
  Reporter,
  UpgradeLabPlugin,
} from '@upgradelab/contracts';

function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

/**
 * Renders one row per check. Deterministic: the same report always produces the
 * same bytes, which makes it suitable for diffing between runs.
 */
export function renderCsv(report: ReportDocument): string {
  const header = [
    'run_id',
    'project',
    'scenario_id',
    'scenario_status',
    'kind',
    'check_id',
    'type',
    'status',
    'required',
    'duration_ms',
    'message',
  ].join(',');
  const rows: string[] = [header];
  for (const scenario of report.scenarios) {
    for (const check of scenario.checks) {
      rows.push(
        [
          report.run.id,
          report.project.name,
          scenario.id,
          scenario.status,
          check.kind,
          check.id,
          check.type,
          check.status,
          check.required ? 'true' : 'false',
          String(check.durationMs),
          check.message ?? '',
        ]
          .map((cell) => csvCell(cell))
          .join(','),
      );
    }
  }
  return `${rows.join('\n')}\n`;
}

const csvReporter: Reporter = {
  format: 'csv',
  fileExtension: 'csv',
  render: renderCsv,
};

/**
 * Example plugin.
 *
 * It demonstrates the complete third-party flow: implement a documented
 * contract, register it, and use it through `--plugin` without touching Core.
 */
const plugin: UpgradeLabPlugin = {
  name: 'csv-reporter',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Adds a deterministic CSV report format.',
  register(registry) {
    registry.registerReporter('csv', csvReporter);
    registry.logger.debug('Registered CSV report format.');
  },
};

export default plugin;
export { csvReporter };
export type { CheckResult };
