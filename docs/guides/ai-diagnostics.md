# AI diagnostics (optional)

AI can explain a failed upgrade, summarise logs or draft an issue. It is **never** part of the verdict.

## Enabling

```yaml
ai:
  enabled: true
  provider: openai # openai | anthropic | gemini | openai-compatible
  model: gpt-4.1-mini
  apiKeyEnv: OPENAI_API_KEY # name, not the key
  maxOutputTokens: 1200
  timeoutMs: 60000
  features: [explain-failure, analyze-logs]
```

```bash
export OPENAI_API_KEY=...
upgradelab run --ai --scenario upgrade-1-to-2
```

AI runs only when both conditions are true: `ai.enabled: true` and `--ai`. The API key is read from the
environment variable named by `apiKeyEnv`; UpgradeLab never stores keys in configuration or reports.

## Features

| Feature              | Output                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| `explain-failure`    | Explanation of failed checks, separated into facts and hypotheses.     |
| `analyze-logs`       | Error, retry and integrity signals found in redacted logs.             |
| `schema-review`      | Potentially destructive schema/data changes inferred from evidence.    |
| `suggest-invariants` | Text suggestions for additional read-only invariants (never executed). |
| `failure-summary`    | Run-level summary of preserved and unpreserved upgrade paths.          |
| `prepare-issue`      | An issue draft; the deterministic template is always embedded.         |

## Local providers

Use an OpenAI-compatible endpoint such as Ollama:

```yaml
ai:
  enabled: true
  provider: openai-compatible
  baseUrl: http://127.0.0.1:11434/v1
  model: llama3.1
  apiKeyEnv: UPGRADELAB_AI_API_KEY
```

## Guarantees

- **Advisory only.** `AiAdvisory` objects are stored in the report; the verdict function never reads them.
- **Redacted prompts.** The configured redactor processes every prompt before the HTTP request, including
  logs and check messages.
- **Validated output.** Responses must be valid JSON with the expected shape; otherwise the advisory is
  skipped with an `AI_RESPONSE_INVALID` warning.
- **Failure isolation.** Provider timeouts, HTTP errors and malformed output become warnings. They cannot
  turn a failed run into a pass or a passing run into a failure.
- **Mandatory disclaimer.** Every advisory carries a disclaimer in reports and in Markdown.

## What AI cannot do

- change a check status or run status;
- execute SQL or commands;
- read files outside the report context;
- run when AI is disabled;
- receive an unredacted prompt.

## Limitations

Providers differ in quality and JSON reliability. A model can be wrong or influenced by prompt injection in
logs; review its output. Do not use advisory text as the only description of an incident.
