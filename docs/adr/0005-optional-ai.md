# ADR 0005 — AI is optional, redacted and advisory

**Status:** Accepted

## Context

AI can help explain failures, but it is non-deterministic, may leak prompts and can be manipulated by log
content. Making it part of the verdict would undermine the product's core promise.

## Decision

- AI is disabled by default and requires `ai.enabled: true` plus `--ai`.
- API keys are read only from environment variables named by `apiKeyEnv`.
- Prompts are redacted before transmission; responses are validated with a zod schema.
- Output is an `AiAdvisory` with a mandatory disclaimer, stored next to checks, never read by verdict
  aggregation.
- AI failures are warnings and never change run status.

Providers: OpenAI-compatible, Anthropic and Gemini, behind a small `AiProvider` interface.

## Consequences

- Core verification works with no AI dependency installed or configured.
- Prompt injection can at worst produce misleading advisory text.
- Users choose the provider and remain responsible for its data policy.
