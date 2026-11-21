import { z } from 'zod';
import {
  UpgradeLabError,
  type AiAdvisory,
  type AiConfig,
  type AiFeature,
  type Redactor,
  type ReportDocument,
  type ScenarioReport,
  type StructuredLogger,
} from '@upgradelab/contracts';
import { createAiProvider } from './providers.js';
import {
  AI_DISCLAIMER,
  SYSTEM_PROMPT,
  buildRunContext,
  buildScenarioContext,
  renderDeterministicIssue,
} from './prompts.js';
import type { AiProvider } from './types.js';

const suggestionSchema = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(2_000),
});

const advisoryResponseSchema = z.object({
  summary: z.string().min(1).max(4_000),
  details: z.string().max(12_000).optional(),
  suggestions: z.array(suggestionSchema).max(5).default([]),
});

const issueResponseSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
});

export interface AiAssistantOptions {
  readonly config: AiConfig;
  readonly provider: AiProvider;
  readonly redactor: Redactor;
  readonly logger: StructuredLogger;
}

export interface CreateAiAssistantOptions {
  readonly config: AiConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly redactor: Redactor;
  readonly logger: StructuredLogger;
  readonly fetchImpl?: typeof fetch;
}

export interface IssuePreparation {
  readonly title: string;
  readonly body: string;
  readonly advisory?: AiAdvisory;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(withoutFence.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Optional AI diagnostics.
 *
 * Every method returns an advisory object that is stored separately from the
 * deterministic check results. AI failures never change a scenario verdict.
 */
export class AiAssistant {
  private readonly config: AiConfig;
  private readonly provider: AiProvider;
  private readonly redactor: Redactor;
  private readonly logger: StructuredLogger;

  constructor(options: AiAssistantOptions) {
    this.config = options.config;
    this.provider = options.provider;
    this.redactor = options.redactor;
    this.logger = options.logger;
  }

  static create(options: CreateAiAssistantOptions): AiAssistant {
    const provider = createAiProvider({
      config: options.config,
      env: options.env,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    return new AiAssistant({
      config: options.config,
      provider,
      redactor: options.redactor,
      logger: options.logger,
    });
  }

  get providerId(): string {
    return this.provider.id;
  }

  get model(): string {
    return this.provider.model;
  }

  get providerLabel(): string {
    return this.provider.id;
  }

  isEnabled(feature: AiFeature): boolean {
    return this.config.enabled && this.config.features.includes(feature);
  }

  private async runJson(
    operation: string,
    prompt: string,
    signal: AbortSignal,
    schema: z.ZodType,
  ): Promise<{ value: unknown; model: string; provider: string; redactions: number }> {
    const before = this.redactor.redactionCount;
    const system = this.redactor.redact(SYSTEM_PROMPT);
    const userPrompt = this.redactor.redact(prompt);
    this.logger.info('Requesting AI analysis.', {
      provider: this.provider.id,
      model: this.provider.model,
      operation,
    });
    const response = await this.provider.complete({
      system,
      prompt: userPrompt,
      maxOutputTokens: this.config.maxOutputTokens,
      json: true,
      signal,
    });
    const redactions = this.redactor.redactionCount - before;
    const parsed = extractJson(response.text);
    if (parsed === undefined) {
      throw new UpgradeLabError(
        `${this.provider.id} returned a response that is not valid JSON for ${operation}.`,
        {
          code: 'AI_RESPONSE_INVALID',
          details: { provider: this.provider.id, operation },
          hint: 'AI output is ignored; the deterministic verdict is unchanged.',
        },
      );
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new UpgradeLabError(
        `${this.provider.id} returned an unexpected JSON shape for ${operation}.`,
        {
          code: 'AI_RESPONSE_INVALID',
          details: { provider: this.provider.id, operation },
          hint: 'AI output is ignored; the deterministic verdict is unchanged.',
        },
      );
    }
    return {
      value: validated.data,
      model: response.model,
      provider: response.provider,
      redactions,
    };
  }

  private toAdvisory(
    kind: string,
    scenarioId: string | undefined,
    value: unknown,
    response: { model: string; provider: string; redactions: number },
  ): AiAdvisory {
    const parsed = advisoryResponseSchema.parse(value);
    return {
      kind,
      ...(scenarioId ? { scenarioId } : {}),
      model: response.model,
      provider: response.provider,
      generatedAt: new Date().toISOString(),
      summary: this.redactor.redact(parsed.summary),
      ...(parsed.details ? { details: this.redactor.redact(parsed.details) } : {}),
      suggestions: parsed.suggestions.map((suggestion) => ({
        title: this.redactor.redact(suggestion.title),
        detail: this.redactor.redact(suggestion.detail),
      })),
      redactionsApplied: response.redactions,
      disclaimer: AI_DISCLAIMER,
    };
  }

  async explainFailure(scenario: ScenarioReport, signal: AbortSignal): Promise<AiAdvisory> {
    this.ensureEnabled('explain-failure');
    const prompt = [
      'Explain why this upgrade did not pass, using only the evidence below.',
      'Separate observed facts from hypotheses and name the check ids that support each conclusion.',
      '',
      buildScenarioContext(scenario),
    ].join('\n');
    const result = await this.runJson('explain-failure', prompt, signal, advisoryResponseSchema);
    return this.toAdvisory('failure-explanation', scenario.id, result.value, result);
  }

  async analyzeLogs(scenario: ScenarioReport, signal: AbortSignal): Promise<AiAdvisory> {
    this.ensureEnabled('analyze-logs');
    const prompt = [
      'Analyze the migration and application logs below.',
      'Identify errors, retries, timeouts and warning signs that relate to data integrity or availability.',
      'Quote only log fragments that appear in the provided evidence.',
      '',
      buildScenarioContext(scenario, { includeLogs: true }),
    ].join('\n');
    const result = await this.runJson('analyze-logs', prompt, signal, advisoryResponseSchema);
    return this.toAdvisory('log-analysis', scenario.id, result.value, result);
  }

  async reviewSchemaChanges(
    scenario: ScenarioReport,
    invariantQueries: readonly string[],
    signal: AbortSignal,
  ): Promise<AiAdvisory> {
    this.ensureEnabled('schema-review');
    const prompt = [
      'Review the upgrade evidence for potentially dangerous schema or data changes.',
      'You do not have the migration source; infer only from failing checks, check names and logs.',
      'Flag destructive patterns such as dropped columns, narrowed types, rewritten identifiers, lost rows or broken foreign keys.',
      '',
      buildScenarioContext(scenario),
      '',
      'CONFIGURED DATA INVARIANTS (SQL):',
      ...invariantQueries.map((query) => `- ${query}`),
    ].join('\n');
    const result = await this.runJson('schema-review', prompt, signal, advisoryResponseSchema);
    return this.toAdvisory('schema-review', scenario.id, result.value, result);
  }

  async suggestInvariants(
    scenario: ScenarioReport,
    invariantQueries: readonly string[],
    signal: AbortSignal,
  ): Promise<AiAdvisory> {
    this.ensureEnabled('suggest-invariants');
    const prompt = [
      'Suggest additional read-only SQL integrity invariants for this upgrade scenario.',
      'Each suggestion must name the table and what should remain true after the upgrade.',
      'Suggestions are text only and will not be executed automatically.',
      '',
      buildScenarioContext(scenario, { includeLogs: false, includeQueries: true }),
      '',
      'EXISTING INVARIANTS (SQL):',
      ...invariantQueries.map((query) => `- ${query}`),
    ].join('\n');
    const result = await this.runJson('suggest-invariants', prompt, signal, advisoryResponseSchema);
    return this.toAdvisory('invariant-suggestions', scenario.id, result.value, result);
  }

  async summarizeRun(report: ReportDocument, signal: AbortSignal): Promise<AiAdvisory> {
    this.ensureEnabled('failure-summary');
    const prompt = [
      'Summarize this UpgradeLab run for a maintainer.',
      'State which upgrade paths preserved data, which did not, and what evidence is missing.',
      '',
      buildRunContext(report),
    ].join('\n');
    const result = await this.runJson('failure-summary', prompt, signal, advisoryResponseSchema);
    return this.toAdvisory('failure-summary', undefined, result.value, result);
  }

  /**
   * Prepares a GitHub issue. The deterministic template is always available;
   * AI output only enriches it and is clearly marked as advisory.
   */
  async prepareIssue(
    report: ReportDocument,
    scenario: ScenarioReport,
    signal: AbortSignal,
  ): Promise<IssuePreparation> {
    if (!this.isEnabled('prepare-issue')) {
      return renderDeterministicIssue(report, scenario);
    }
    const base = renderDeterministicIssue(report, scenario);
    try {
      const prompt = [
        'Write a concise, actionable GitHub issue for the upgrade failure below.',
        'Return JSON: {"title": string, "body": string}.',
        'The body must include: summary, evidence, reproduction steps and open questions.',
        'Do not claim that the upgrade passed. Do not invent evidence.',
        '',
        buildScenarioContext(scenario),
      ].join('\n');
      const result = await this.runJson('prepare-issue', prompt, signal, issueResponseSchema);
      const parsed = issueResponseSchema.parse(result.value);
      const body = [
        this.redactor.redact(parsed.body),
        '',
        '---',
        `_AI-assisted draft (${result.provider}/${result.model}). ${AI_DISCLAIMER}_`,
        '',
        '<details><summary>Deterministic UpgradeLab evidence</summary>',
        '',
        base.body,
        '',
        '</details>',
      ].join('\n');
      return { title: this.redactor.redact(parsed.title), body };
    } catch (error) {
      this.logger.warn('AI issue preparation failed; using deterministic template.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return base;
    }
  }

  private ensureEnabled(feature: AiFeature): void {
    if (!this.isEnabled(feature)) {
      throw new UpgradeLabError(`AI feature "${feature}" is not enabled.`, {
        code: 'AI_DISABLED',
        details: { feature, enabledFeatures: this.config.features },
        hint: 'Enable the feature in ai.features and opt in with --ai.',
      });
    }
  }
}

export function createAiAssistant(options: CreateAiAssistantOptions): AiAssistant {
  return AiAssistant.create(options);
}
