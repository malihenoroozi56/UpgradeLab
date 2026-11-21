import type { AiConfig } from '@upgradelab/contracts';

export interface AiCompletionRequest {
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly json: boolean;
  readonly signal: AbortSignal;
}

export interface AiCompletionResponse {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

/**
 * Provider-independent completion interface.
 *
 * Implementations receive already-redacted prompts; redaction is the caller's
 * responsibility so that every provider gets the same protection.
 */
export interface AiProvider {
  readonly id: string;
  readonly model: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResponse>;
}

export interface AiProviderDependencies {
  readonly config: AiConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_API_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'openai-compatible': 'UPGRADELAB_AI_API_KEY',
};

export function apiKeyEnvName(config: AiConfig): string {
  return config.apiKeyEnv ?? DEFAULT_API_KEY_ENV[config.provider] ?? 'UPGRADELAB_AI_API_KEY';
}
