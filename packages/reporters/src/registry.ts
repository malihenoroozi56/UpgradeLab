import {
  UpgradeLabError,
  REPORT_FORMATS,
  type ReportDocument,
  type Reporter,
} from '@upgradelab/contracts';
import { jsonReporter } from './json.js';
import { junitReporter } from './junit.js';
import { markdownReporter } from './markdown.js';

export const BUILTIN_REPORTERS: readonly Reporter[] = [
  jsonReporter,
  markdownReporter,
  junitReporter,
];

const FORMAT_ALIASES: Record<string, string> = {
  md: 'markdown',
  xml: 'junit',
  'junit-xml': 'junit',
  junitxml: 'junit',
};

/**
 * Registry of report formats.
 *
 * Built-in formats cannot be overridden: a plugin that tried to replace the
 * JSON reporter would silently change machine-readable output for every user.
 */
export class ReporterRegistry {
  private readonly reporters = new Map<string, Reporter>();

  constructor(initial: readonly Reporter[] = BUILTIN_REPORTERS) {
    for (const reporter of initial) {
      this.reporters.set(reporter.format, reporter);
    }
  }

  register(reporter: Reporter): void {
    if (this.reporters.has(reporter.format)) {
      throw new UpgradeLabError(`Report format "${reporter.format}" is already registered.`, {
        code: 'PLUGIN_DUPLICATE',
        details: { format: reporter.format },
        hint: 'Choose a new format name for the plugin reporter.',
      });
    }
    this.reporters.set(reporter.format, reporter);
  }

  resolve(format: string): Reporter {
    const normalized = FORMAT_ALIASES[format.toLowerCase()] ?? format.toLowerCase();
    const reporter = this.reporters.get(normalized);
    if (!reporter) {
      throw new UpgradeLabError(`Unknown report format "${format}".`, {
        code: 'CONFIG_VALIDATION_ERROR',
        details: { format, available: this.list() },
        hint: `Supported formats: ${this.list().join(', ')}.`,
      });
    }
    return reporter;
  }

  resolveMany(formats: readonly string[]): Reporter[] {
    const resolved = new Map<string, Reporter>();
    for (const format of formats) {
      const reporter = this.resolve(format);
      resolved.set(reporter.format, reporter);
    }
    return [...resolved.values()];
  }

  list(): string[] {
    return [...this.reporters.keys()].sort();
  }
}

export function createReporterRegistry(extra: readonly Reporter[] = []): ReporterRegistry {
  return new ReporterRegistry([...BUILTIN_REPORTERS, ...extra]);
}

export const DEFAULT_REPORT_FORMATS: readonly string[] = [...REPORT_FORMATS];

/** Validates a parsed JSON document as an UpgradeLab report. */
export function parseReportDocument(value: unknown, source = 'report'): ReportDocument {
  if (value === null || typeof value !== 'object') {
    throw new UpgradeLabError(`Report ${source} is not a JSON object.`, {
      code: 'CONFIG_PARSE_ERROR',
      details: { source },
    });
  }
  const candidate = value as Partial<ReportDocument> & { scenarios?: unknown };
  if (candidate.schemaVersion !== 1) {
    throw new UpgradeLabError(
      `Report ${source} has unsupported schemaVersion ${JSON.stringify(candidate.schemaVersion)}.`,
      {
        code: 'CONFIG_UNSUPPORTED_VERSION',
        details: { source, supported: 1 },
      },
    );
  }
  if (
    !candidate.run ||
    typeof candidate.run !== 'object' ||
    typeof candidate.run.id !== 'string' ||
    !candidate.project ||
    typeof candidate.project !== 'object' ||
    !Array.isArray(candidate.scenarios)
  ) {
    throw new UpgradeLabError(`Report ${source} is malformed: missing run, project or scenarios.`, {
      code: 'CONFIG_PARSE_ERROR',
      details: { source },
      hint: 'Regenerate the report with "upgradelab run".',
    });
  }
  return value as ReportDocument;
}
