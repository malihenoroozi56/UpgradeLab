import { describe, expect, it, vi } from 'vitest';
import { UpgradeLabError, aiConfigSchema, createRedactor } from '@upgradelab/contracts';
import { AiAssistant, createAiProvider, renderDeterministicIssue } from '@upgradelab/ai-assistant';
import { sampleReport, sampleScenario } from '../helpers/report.js';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function aiConfig(overrides: Record<string, unknown> = {}) {
  return aiConfigSchema.parse({
    enabled: true,
    provider: 'openai',
    model: 'gpt-test',
    maxOutputTokens: 256,
    timeoutMs: 5_000,
    ...overrides,
  });
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function completion(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

function assistantFor(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return AiAssistant.create({
    config: aiConfig(overrides),
    env: { OPENAI_API_KEY: 'test-api-key' },
    redactor: createRedactor(),
    logger,
    fetchImpl,
  });
}

describe('AI assistant', () => {
  it('is disabled by default and refuses to create a provider', () => {
    const config = aiConfig({ enabled: false });
    expect(config.enabled).toBe(false);
    expect(() =>
      AiAssistant.create({
        config,
        env: {},
        redactor: createRedactor(),
        logger,
      }),
    ).toThrowError(expect.objectContaining({ code: 'AI_DISABLED' }));
  });

  it('produces a redacted advisory with a mandatory disclaimer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      completion(
        JSON.stringify({
          summary: 'The migration rewrote postgres://user:supersecret@db:5432/app and lost rows.',
          details: 'Check balance-preserved failed.',
          suggestions: [
            {
              title: 'Backfill balances',
              detail: 'Recompute from the ledger before dropping columns.',
            },
          ],
        }),
      ),
    );
    const assistant = assistantFor(fetchImpl as unknown as typeof fetch);
    const scenario = sampleScenario({
      status: 'FAILED',
      logs: [
        {
          at: '2024-01-01T00:00:06.000Z',
          service: 'app',
          stream: 'stderr',
          message: 'connecting with postgres://user:supersecret@db:5432/app',
        },
      ],
    });
    const advisory = await assistant.explainFailure(scenario, new AbortController().signal);
    expect(advisory.kind).toBe('failure-explanation');
    expect(advisory.scenarioId).toBe(scenario.id);
    expect(advisory.provider).toBe('openai');
    expect(advisory.model).toBe('gpt-test');
    expect(advisory.summary).not.toContain('supersecret');
    expect(advisory.summary).toContain('[REDACTED]');
    expect(advisory.suggestions[0]?.title).toBe('Backfill balances');
    expect(advisory.disclaimer).toMatch(/advisory only/i);
    expect(advisory.redactionsApplied).toBeGreaterThan(0);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
    expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer test-api-key');
    const requestBody = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: string }[];
      response_format?: { type: string };
    };
    expect(requestBody.response_format?.type).toBe('json_object');
    const promptText = requestBody.messages.map((message) => message.content).join('\n');
    expect(promptText).not.toContain('supersecret');
    expect(promptText).toContain('users-preserved');
  });

  it('rejects malformed AI output without changing any verdict', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => completion('not json at all'));
    const assistant = assistantFor(fetchImpl as unknown as typeof fetch);
    await expect(
      assistant.analyzeLogs(sampleScenario(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' });
  });

  it('surfaces provider HTTP failures as AI_PROVIDER_ERROR', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: false,
          status: 401,
          text: async () => 'invalid api key',
        }) as unknown as Response,
    );
    const assistant = assistantFor(fetchImpl as unknown as typeof fetch);
    await expect(
      assistant.explainFailure(sampleScenario(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' });
  });

  it('requires an API key from the environment and never from configuration', () => {
    expect(() =>
      createAiProvider({
        config: aiConfig(),
        env: {},
        fetchImpl: (async () => completion('{}')) as unknown as typeof fetch,
      }),
    ).toThrowError(UpgradeLabError);
    try {
      createAiProvider({ config: aiConfig(), env: {} });
    } catch (error) {
      expect((error as UpgradeLabError).code).toBe('AI_MISSING_API_KEY');
      expect((error as UpgradeLabError).message).toContain('OPENAI_API_KEY');
    }
  });

  it('always provides a deterministic issue draft without AI', async () => {
    const failing = {
      ...sampleScenario().checks[0]!,
      id: 'users-preserved',
      status: 'FAILED' as const,
      message: 'Value changed during the upgrade: before 3, after 2.',
    };
    const report = sampleReport({
      scenario: {
        status: 'FAILED',
        checks: [failing],
        counts: { total: 1, passed: 0, failed: 1, skipped: 0, errored: 0 },
      },
    });
    const scenario = report.scenarios[0]!;
    const deterministic = renderDeterministicIssue(report, scenario);
    expect(deterministic.title).toContain(scenario.id);
    expect(deterministic.body).toContain('sample-app');
    expect(deterministic.body).toContain('users-preserved');

    const fetchImpl = vi.fn<typeof fetch>();
    const assistant = assistantFor(fetchImpl as unknown as typeof fetch, {
      features: ['explain-failure'],
    });
    const issue = await assistant.prepareIssue(report, scenario, new AbortController().signal);
    expect(issue.title).toBe(deterministic.title);
    expect(issue.body).toBe(deterministic.body);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enriches issue drafts with AI while retaining the deterministic evidence', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      completion(
        JSON.stringify({
          title: 'Data loss when upgrading to 2.0.0',
          body: 'The upgrade drops the email column.',
        }),
      ),
    );
    const assistant = assistantFor(fetchImpl as unknown as typeof fetch, {
      features: ['prepare-issue'],
    });
    const report = sampleReport({ scenario: { status: 'FAILED' } });
    const issue = await assistant.prepareIssue(
      report,
      report.scenarios[0]!,
      new AbortController().signal,
    );
    expect(issue.title).toBe('Data loss when upgrading to 2.0.0');
    expect(issue.body).toContain('The upgrade drops the email column.');
    expect(issue.body).toContain('Deterministic UpgradeLab evidence');
    expect(issue.body).toContain('advisory only');
  });
});

describe('AI provider adapters', () => {
  it('speaks the Anthropic messages API', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ content: [{ type: 'text', text: '{"summary":"ok"}' }] }),
    );
    const provider = createAiProvider({
      config: aiConfig({ provider: 'anthropic', model: 'claude-test' }),
      env: { ANTHROPIC_API_KEY: 'anthropic-key' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const response = await provider.complete({
      system: 'system',
      prompt: 'prompt',
      maxOutputTokens: 100,
      json: true,
      signal: new AbortController().signal,
    });
    expect(response.text).toBe('{"summary":"ok"}');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('anthropic-key');
    expect((init?.headers as Record<string, string>)['anthropic-version']).toBeDefined();
  });

  it('speaks the Gemini generateContent API', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"summary":"gemini"}' }] } }],
      }),
    );
    const provider = createAiProvider({
      config: aiConfig({ provider: 'gemini', model: 'gemini-test' }),
      env: { GEMINI_API_KEY: 'gemini-key' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const response = await provider.complete({
      system: 'system',
      prompt: 'prompt',
      maxOutputTokens: 100,
      json: true,
      signal: new AbortController().signal,
    });
    expect(response.text).toBe('{"summary":"gemini"}');
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain('generativelanguage.googleapis.com');
    expect(String(url)).toContain('gemini-test');
  });

  it('supports local OpenAI-compatible endpoints', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => completion('{"summary":"local"}'));
    const provider = createAiProvider({
      config: aiConfig({
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'llama-test',
      }),
      env: { UPGRADELAB_AI_API_KEY: 'local-key' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(provider.id).toBe('openai-compatible');
    await provider.complete({
      system: 's',
      prompt: 'p',
      maxOutputTokens: 10,
      json: true,
      signal: new AbortController().signal,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });
});
