import type {
  CheckResult,
  CleanupReport,
  ExecutionEvent,
  EvidenceReference,
  LogEntry,
  RunStatus,
  ServiceState,
} from './execution.js';
import type { SerializedError } from './errors.js';

export const REPORT_FORMATS = ['json', 'markdown', 'junit'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface SetupExecutionResult {
  readonly id: string;
  readonly target: string;
  readonly command: readonly string[];
  readonly status: 'PASSED' | 'FAILED' | 'ERROR';
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly evidenceIds: readonly string[];
}

export interface HopReport {
  readonly index: number;
  readonly image: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly ready: boolean;
  readonly readinessAttempts: number;
  readonly serviceState?: ServiceState;
  readonly endpoint?: string;
  readonly error?: SerializedError;
}

export interface ScenarioEnvironmentInfo {
  readonly provider: string;
  readonly projectName: string;
  readonly composeFile: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface AiSuggestion {
  readonly title: string;
  readonly detail: string;
}

export interface AiAdvisory {
  /** Stable identifier of the advisory kind, e.g. "failure-explanation". */
  readonly kind: string;
  readonly scenarioId?: string;
  readonly model: string;
  readonly provider: string;
  readonly generatedAt: string;
  readonly summary: string;
  readonly details?: string;
  readonly suggestions: readonly AiSuggestion[];
  readonly redactionsApplied: number;
  /** Always present: AI output is advisory and never determines the verdict. */
  readonly disclaimer: string;
}

export interface AiReportSection {
  readonly enabled: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly advisories: readonly AiAdvisory[];
  readonly skippedReason?: string;
}

export interface CheckCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly errored: number;
}

export interface ScenarioReport {
  readonly id: string;
  readonly description?: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly sourceImage: string;
  readonly targetImage: string;
  readonly imagePath: readonly string[];
  readonly hops: readonly HopReport[];
  readonly setup: readonly SetupExecutionResult[];
  readonly checks: readonly CheckResult[];
  readonly counts: CheckCounts;
  readonly logs: readonly LogEntry[];
  readonly events: readonly ExecutionEvent[];
  readonly evidence: readonly EvidenceReference[];
  readonly environment: ScenarioEnvironmentInfo;
  readonly cleanup: CleanupReport;
  readonly error?: SerializedError;
  readonly aiAdvisories?: readonly AiAdvisory[];
}

export interface RunEnvironmentInfo {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly toolVersion: string;
}

export interface RunReportInfo {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: RunStatus;
  readonly configPath: string;
  readonly configDirectory: string;
  /** SHA-256 of the raw configuration text, for traceability. */
  readonly configHash?: string;
  readonly cancelled: boolean;
  readonly environment: RunEnvironmentInfo;
}

export interface ReportDocument {
  readonly schemaVersion: 1;
  readonly tool: { readonly name: string; readonly version: string };
  readonly run: RunReportInfo;
  readonly project: { readonly name: string; readonly description?: string };
  readonly scenarios: readonly ScenarioReport[];
  readonly ai: AiReportSection;
}

export interface Reporter {
  readonly format: string;
  readonly fileExtension: string;
  render(report: ReportDocument): string;
}

/** Summary counts for a set of checks. */
export function countCheckStatuses(checks: readonly CheckResult[]): CheckCounts {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.status === 'PASSED').length,
    failed: checks.filter((check) => check.status === 'FAILED').length,
    skipped: checks.filter((check) => check.status === 'SKIPPED').length,
    errored: checks.filter((check) => check.status === 'ERROR').length,
  };
}
