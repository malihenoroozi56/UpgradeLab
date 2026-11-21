import {
  REPORT_SCHEMA_VERSION,
  TOOL_NAME,
  TOOL_VERSION,
  countCheckStatuses,
  type AiAdvisory,
  type AiReportSection,
  type ReportDocument,
  type RunStatus,
  type ScenarioReport,
} from '@upgradelab/contracts';

export interface BuildReportInput {
  readonly project: { readonly name: string; readonly description?: string };
  readonly configPath: string;
  readonly configDirectory: string;
  readonly configHash?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: RunStatus;
  readonly scenarios: readonly ScenarioReport[];
  readonly runId: string;
  readonly cancelled?: boolean;
  readonly ai?: AiReportSection;
  readonly toolVersion?: string;
  readonly nodeVersion?: string;
  readonly platform?: string;
  readonly arch?: string;
}

const DEFAULT_DISCLAIMER =
  'AI output is advisory only. It never changes the verdict and must be reviewed by a human before acting on it.';

export function emptyAiSection(): AiReportSection {
  return { enabled: false, advisories: [] };
}

/** Attaches AI advisories to the scenarios they refer to. */
function attachAdvisories(
  scenarios: readonly ScenarioReport[],
  advisories: readonly AiAdvisory[],
): readonly ScenarioReport[] {
  if (advisories.length === 0) {
    return scenarios;
  }
  return scenarios.map((scenario) => {
    const relevant = advisories.filter((advisory) => advisory.scenarioId === scenario.id);
    if (relevant.length === 0) {
      return scenario;
    }
    return { ...scenario, aiAdvisories: relevant };
  });
}

/** Builds the versioned report document from engine results. */
export function buildReportDocument(input: BuildReportInput): ReportDocument {
  const ai: AiReportSection = input.ai ?? emptyAiSection();
  const advisories: readonly AiAdvisory[] = ai.advisories.map((advisory) => ({
    ...advisory,
    disclaimer: advisory.disclaimer || DEFAULT_DISCLAIMER,
  }));
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: input.toolVersion ?? TOOL_VERSION },
    run: {
      id: input.runId,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      status: input.status,
      configPath: input.configPath,
      configDirectory: input.configDirectory,
      ...(input.configHash ? { configHash: input.configHash } : {}),
      cancelled: input.cancelled ?? false,
      environment: {
        nodeVersion: input.nodeVersion ?? process.version,
        platform: input.platform ?? process.platform,
        arch: input.arch ?? process.arch,
        toolVersion: input.toolVersion ?? TOOL_VERSION,
      },
    },
    project: input.project,
    scenarios: attachAdvisories(input.scenarios, advisories),
    ai: { ...ai, advisories },
  };
}

/** Recomputes counts for a scenario, used when reports are re-rendered. */
export function withCounts(scenario: ScenarioReport): ScenarioReport {
  return { ...scenario, counts: countCheckStatuses(scenario.checks) };
}
