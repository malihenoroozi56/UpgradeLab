import { describe, expect, it } from 'vitest';
import { aiConfigSchema, UpgradeLabError } from '@upgradelab/contracts';
import { resolveAiConfig } from '@upgradelab/cli';

const enabled = aiConfigSchema.parse({
  enabled: true,
  provider: 'openai',
  model: 'gpt-test',
});
const disabled = aiConfigSchema.parse({
  enabled: false,
  provider: 'openai',
  model: 'gpt-test',
});

describe('AI opt-in resolution', () => {
  it('requires both ai.enabled and --ai', () => {
    expect(resolveAiConfig(enabled, { ai: false }).enabled).toBe(false);
    expect(resolveAiConfig(enabled, { ai: true }).enabled).toBe(true);
    expect(resolveAiConfig(disabled, { ai: false }).enabled).toBe(false);
    try {
      resolveAiConfig(disabled, { ai: true });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeLabError);
      expect((error as UpgradeLabError).code).toBe('CONFIG_VALIDATION_ERROR');
      expect((error as Error).message).toContain('ai.enabled');
    }
  });

  it('applies provider and model overrides without enabling implicitly', () => {
    const resolved = resolveAiConfig(enabled, {
      ai: true,
      aiProvider: 'anthropic',
      aiModel: 'claude-test',
    });
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.model).toBe('claude-test');
    expect(() => resolveAiConfig(enabled, { ai: true, aiProvider: 'not-a-provider' })).toThrowError(
      /Unknown AI provider/,
    );
  });
});
