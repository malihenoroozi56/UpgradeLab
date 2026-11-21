import { UpgradeLabError } from '@upgradelab/contracts';
import {
  apiKeyEnvName,
  type AiCompletionRequest,
  type AiCompletionResponse,
  type AiProvider,
  type AiProviderDependencies,
} from './types.js';

type FetchLike = typeof fetch;

function combineSignals(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: { signal: AbortSignal; timeoutMs: number; provider: string },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: combineSignals(options.signal, options.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new UpgradeLabError(
      timedOut
        ? `${options.provider} request timed out after ${options.timeoutMs} ms.`
        : `${options.provider} request failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'AI_PROVIDER_ERROR',
        details: { provider: options.provider, url },
        cause: error,
      },
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new UpgradeLabError(
      `${options.provider} returned HTTP ${response.status}: ${text.slice(0, 1_000)}`,
      {
        code: 'AI_PROVIDER_ERROR',
        details: { provider: options.provider, status: response.status },
      },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UpgradeLabError(`${options.provider} returned a non-JSON response.`, {
      code: 'AI_PROVIDER_ERROR',
      details: { provider: options.provider },
      cause: error,
    });
  }
}

function normalizeChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: string;
  readonly model: string;

  constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly apiKey: string | undefined;
      readonly model: string;
      readonly timeoutMs: number;
      readonly providerId: string;
      readonly fetchImpl: FetchLike;
    },
  ) {
    this.id = options.providerId;
    this.model = options.model;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const headers: Record<string, string> = {};
    if (this.options.apiKey) {
      headers['authorization'] = `Bearer ${this.options.apiKey}`;
    }
    const payload = await postJson(
      this.options.fetchImpl,
      normalizeChatCompletionsUrl(this.options.baseUrl),
      headers,
      {
        model: this.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
        max_tokens: request.maxOutputTokens,
        temperature: 0,
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      },
      { signal: request.signal, timeoutMs: this.options.timeoutMs, provider: this.id },
    );
    const data = payload as {
      model?: string;
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new UpgradeLabError(`${this.id} returned an empty completion.`, {
        code: 'AI_RESPONSE_INVALID',
        details: { provider: this.id },
      });
    }
    return {
      text,
      provider: this.id,
      model: data.model ?? this.model,
      usage: {
        ...(typeof data.usage?.prompt_tokens === 'number'
          ? { inputTokens: data.usage.prompt_tokens }
          : {}),
        ...(typeof data.usage?.completion_tokens === 'number'
          ? { outputTokens: data.usage.completion_tokens }
          : {}),
      },
    };
  }
}

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly model: string;

  constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly model: string;
      readonly timeoutMs: number;
      readonly fetchImpl: FetchLike;
    },
  ) {
    this.model = options.model;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const url = base.endsWith('/messages') ? base : `${base}/messages`;
    const payload = await postJson(
      this.options.fetchImpl,
      url,
      {
        'x-api-key': this.options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      {
        model: this.model,
        max_tokens: request.maxOutputTokens,
        temperature: 0,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
      },
      { signal: request.signal, timeoutMs: this.options.timeoutMs, provider: this.id },
    );
    const data = payload as {
      model?: string;
      content?: { type?: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = data.content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim();
    if (!text) {
      throw new UpgradeLabError('anthropic returned an empty completion.', {
        code: 'AI_RESPONSE_INVALID',
      });
    }
    return {
      text,
      provider: this.id,
      model: data.model ?? this.model,
      usage: {
        ...(typeof data.usage?.input_tokens === 'number'
          ? { inputTokens: data.usage.input_tokens }
          : {}),
        ...(typeof data.usage?.output_tokens === 'number'
          ? { outputTokens: data.usage.output_tokens }
          : {}),
      },
    };
  }
}

export class GeminiProvider implements AiProvider {
  readonly id = 'gemini';
  readonly model: string;

  constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly model: string;
      readonly timeoutMs: number;
      readonly fetchImpl: FetchLike;
    },
  ) {
    this.model = options.model;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(this.model)}:generateContent`;
    const payload = await postJson(
      this.options.fetchImpl,
      url,
      { 'x-goog-api-key': this.options.apiKey },
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        generationConfig: {
          maxOutputTokens: request.maxOutputTokens,
          temperature: 0,
        },
      },
      { signal: request.signal, timeoutMs: this.options.timeoutMs, provider: this.id },
    );
    const data = payload as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')
      .trim();
    if (!text) {
      throw new UpgradeLabError('gemini returned an empty completion.', {
        code: 'AI_RESPONSE_INVALID',
      });
    }
    return {
      text,
      provider: this.id,
      model: this.model,
      usage: {
        ...(typeof data.usageMetadata?.promptTokenCount === 'number'
          ? { inputTokens: data.usageMetadata.promptTokenCount }
          : {}),
        ...(typeof data.usageMetadata?.candidatesTokenCount === 'number'
          ? { outputTokens: data.usageMetadata.candidatesTokenCount }
          : {}),
      },
    };
  }
}

/**
 * Creates the configured provider.
 *
 * AI is opt-in: when `ai.enabled` is false this throws AI_DISABLED before any
 * network access. API keys are read from the environment only.
 */
export function createAiProvider(dependencies: AiProviderDependencies): AiProvider {
  const { config, env } = dependencies;
  if (!config.enabled) {
    throw new UpgradeLabError('AI analysis is disabled.', {
      code: 'AI_DISABLED',
      hint: 'Enable it with ai.enabled: true in the configuration and pass --ai to the run command.',
    });
  }
  if (!config.model) {
    throw new UpgradeLabError('ai.model is required when AI analysis is enabled.', {
      code: 'CONFIG_VALIDATION_ERROR',
    });
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const apiKeyName = apiKeyEnvName(config);
  const apiKey = env[apiKeyName];
  const timeoutMs = config.timeoutMs;

  if (config.provider === 'openai-compatible') {
    if (!config.baseUrl) {
      throw new UpgradeLabError('ai.baseUrl is required for the openai-compatible provider.', {
        code: 'CONFIG_VALIDATION_ERROR',
      });
    }
    return new OpenAiCompatibleProvider({
      baseUrl: config.baseUrl,
      apiKey,
      model: config.model,
      timeoutMs,
      providerId: 'openai-compatible',
      fetchImpl,
    });
  }

  if (!apiKey) {
    throw new UpgradeLabError(
      `AI provider "${config.provider}" requires an API key in ${apiKeyName}.`,
      {
        code: 'AI_MISSING_API_KEY',
        details: { provider: config.provider, env: apiKeyName },
        hint: `Export ${apiKeyName} or disable AI analysis. UpgradeLab never stores API keys in the configuration file.`,
      },
    );
  }

  switch (config.provider) {
    case 'openai':
      return new OpenAiCompatibleProvider({
        baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
        apiKey,
        model: config.model,
        timeoutMs,
        providerId: 'openai',
        fetchImpl,
      });
    case 'anthropic':
      return new AnthropicProvider({
        baseUrl: config.baseUrl ?? 'https://api.anthropic.com/v1',
        apiKey,
        model: config.model,
        timeoutMs,
        fetchImpl,
      });
    case 'gemini':
      return new GeminiProvider({
        baseUrl: config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta',
        apiKey,
        model: config.model,
        timeoutMs,
        fetchImpl,
      });
    default: {
      const exhaustive: never = config.provider;
      throw new UpgradeLabError(`Unsupported AI provider "${String(exhaustive)}".`, {
        code: 'CONFIG_VALIDATION_ERROR',
      });
    }
  }
}
