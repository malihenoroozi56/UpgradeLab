import { readFile } from 'node:fs/promises';
import { UpgradeLabError, type ReportDocument } from '@upgradelab/contracts';
import { parseReportDocument } from '@upgradelab/reporters';

/** Reads and validates a JSON report file with actionable errors. */
export async function parseRequestBody(file: string): Promise<ReportDocument> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new UpgradeLabError(`Unable to read report file ${file}.`, {
      code: 'CONFIG_NOT_FOUND',
      details: { file },
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UpgradeLabError(`Report file ${file} is not valid JSON.`, {
      code: 'CONFIG_PARSE_ERROR',
      details: { file },
      cause: error,
      hint: 'Regenerate the report with "upgradelab run".',
    });
  }
  return parseReportDocument(parsed, file);
}
