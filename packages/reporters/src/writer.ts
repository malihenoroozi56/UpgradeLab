import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  UpgradeLabError,
  type Redactor,
  type ReportDocument,
  type StructuredLogger,
} from '@upgradelab/contracts';
import { ReporterRegistry } from './registry.js';

export interface WrittenReportFile {
  readonly format: string;
  readonly path: string;
  readonly bytes: number;
}

export interface WriteReportOptions {
  readonly outputDirectory: string;
  readonly formats: readonly string[];
  readonly redactor: Redactor;
  readonly logger: StructuredLogger;
  readonly baseName?: string;
}

export interface WriteReportResult {
  readonly report: ReportDocument;
  readonly files: readonly WrittenReportFile[];
}

/**
 * Redacts the report once, then renders every requested format from the same
 * redacted document. Secret redaction therefore cannot differ between formats.
 */
export async function writeReports(
  report: ReportDocument,
  options: WriteReportOptions,
  registry: ReporterRegistry = new ReporterRegistry(),
): Promise<WriteReportResult> {
  const redacted = options.redactor.redactDeep(report);
  const baseName = options.baseName ?? 'upgradelab-report';
  const reporters = registry.resolveMany(options.formats);
  await mkdir(options.outputDirectory, { recursive: true, mode: 0o755 });
  const files: WrittenReportFile[] = [];
  for (const reporter of reporters) {
    const content = reporter.render(redacted);
    const target = path.join(options.outputDirectory, `${baseName}.${reporter.fileExtension}`);
    try {
      await writeFile(target, content, { encoding: 'utf8' });
    } catch (error) {
      throw new UpgradeLabError(`Unable to write ${reporter.format} report to ${target}.`, {
        code: 'REPORT_WRITE_FAILED',
        details: { target, format: reporter.format },
        cause: error,
      });
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    files.push({ format: reporter.format, path: target, bytes });
    options.logger.debug('Report written.', { format: reporter.format, path: target, bytes });
  }
  return { report: redacted, files };
}
