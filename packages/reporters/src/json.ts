import type { ReportDocument, Reporter } from '@upgradelab/contracts';

export function renderJson(report: ReportDocument): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export const jsonReporter: Reporter = {
  format: 'json',
  fileExtension: 'json',
  render: renderJson,
};
