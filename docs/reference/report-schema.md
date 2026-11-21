# Report schema (version 1)

The JSON report is the source of truth for integrations. Markdown and JUnit are renderings of the same
redacted document.

```json
{
  "schemaVersion": 1,
  "tool": { "name": "upgradelab", "version": "1.0.0-dev.0" },
  "run": {
    "id": "20260101t120000z-abc12345",
    "startedAt": "2026-01-01T12:00:00.000Z",
    "finishedAt": "2026-01-01T12:00:30.000Z",
    "durationMs": 30000,
    "status": "PASSED",
    "configPath": "/repo/upgradelab.yaml",
    "configDirectory": "/repo",
    "configHash": "sha256…",
    "cancelled": false,
    "environment": {
      "nodeVersion": "v22.15.0",
      "platform": "linux",
      "arch": "x64",
      "toolVersion": "1.0.0-dev.0"
    }
  },
  "project": { "name": "my-app", "description": "optional" },
  "scenarios": [ … ],
  "ai": { "enabled": false, "advisories": [] }
}
```

## Scenario

| Field                                     | Description                                                     |
| ----------------------------------------- | --------------------------------------------------------------- |
| `id`, `description`                       | Configuration values.                                           |
| `status`                                  | `PASSED`, `FAILED`, `INCONCLUSIVE`, `CANCELLED`.                |
| `startedAt`, `finishedAt`, `durationMs`   | Timing.                                                         |
| `sourceImage`, `targetImage`, `imagePath` | Upgrade path.                                                   |
| `hops`                                    | Per-hop image, readiness, attempts, endpoint, error.            |
| `setup`                                   | Setup command results (id, target, command, exit code, output). |
| `checks`                                  | Check results (see below).                                      |
| `counts`                                  | `{ total, passed, failed, skipped, errored }`.                  |
| `logs`                                    | Redacted log entries.                                           |
| `events`                                  | Lifecycle events with sequence numbers.                         |
| `evidence`                                | `ev-N` references with kind, description, bytes, truncation.    |
| `environment`                             | Provider, project name, compose file, metadata.                 |
| `cleanup`                                 | `{ attempted, succeeded, removed, warnings, error? }`.          |
| `error`                                   | Serialized orchestration error, if any.                         |
| `aiAdvisories`                            | Optional advisories for this scenario.                          |

## Check

```json
{
  "id": "balances-preserved",
  "kind": "invariant",
  "type": "sql",
  "required": true,
  "status": "FAILED",
  "startedAt": "…",
  "finishedAt": "…",
  "durationMs": 12,
  "message": "Numeric equality with baseline violated: expected 3000 ± 0, got 1800.",
  "expected": 3000,
  "actual": 1800,
  "baseline": 3000,
  "evidenceIds": ["ev-7"],
  "error": { "name": "UpgradeLabError", "code": "…", "category": "…", "message": "…" }
}
```

`kind` is `invariant` or `assertion`. `status` is `PASSED`, `FAILED`, `SKIPPED` or `ERROR`.

## AI section

```json
{
  "enabled": true,
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "advisories": [
    {
      "kind": "failure-explanation",
      "scenarioId": "upgrade-1-to-2",
      "summary": "…",
      "suggestions": [{ "title": "…", "detail": "…" }],
      "redactionsApplied": 2,
      "disclaimer": "AI output is advisory only. It never changes the verdict…"
    }
  ]
}
```

The `ai` section is never used to compute `run.status`.

## JUnit mapping

- `testsuites` → run; `testsuite` → scenario.
- `testcase` names: `invariant:<id>`, `assertion:<id>`, `setup:<id>`.
- Synthetic test cases: `upgrade-execution`, `verdict`, `cleanup`.
- `FAILED` → `<failure>`, `ERROR` → `<error>`, `SKIPPED` → `<skipped>`.
- Logs are emitted as `<system-out>`; all XML text is escaped.

## Redaction

The document written to disk is redacted. Evidence and logs may still contain unexpected data; review
artifacts before sharing them publicly.
