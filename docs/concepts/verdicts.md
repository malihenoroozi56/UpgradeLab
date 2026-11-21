# Verdicts and exit codes

UpgradeLab has exactly four run statuses. They are computed from check results, never from container state
alone and never from AI output.

## Status definitions

| Status         | Rule                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASSED`       | Every required check passed, and at least one required check ran.                                                                                               |
| `FAILED`       | At least one required check failed, or the target release could not be started, or cleanup failed.                                                              |
| `INCONCLUSIVE` | The upgrade completed but could not be verified: no required checks, a required check was skipped or errored, or an orchestration error prevented verification. |
| `CANCELLED`    | The run was cancelled (SIGINT/SIGTERM or an aborted signal).                                                                                                    |

Optional checks (`required: false`) never fail a scenario. A scenario with only optional checks is still
`INCONCLUSIVE`.

## Exit codes

| Code | Meaning             | Typical cause                                                        |
| ---- | ------------------- | -------------------------------------------------------------------- |
| `0`  | OK                  | `PASSED` run or successful command                                   |
| `1`  | Tests failed        | `FAILED` run                                                         |
| `2`  | Configuration error | Invalid YAML, unknown key, unsafe setting, plugin duplicate          |
| `3`  | Environment error   | Docker/Compose missing, unsafe Compose file, service failed to start |
| `4`  | Cancelled           | Ctrl+C / SIGTERM                                                     |
| `5`  | Internal error      | Unexpected failure, AI configuration error surfaced by a command     |
| `6`  | Plugin error        | Plugin invalid, failed to load, duplicate registration               |
| `7`  | Inconclusive        | No required checks, required check skipped/errored                   |

The mapping lives in `packages/contracts/src/errors.ts`. Every thrown `UpgradeLabError` has a stable code and
a category; the CLI maps the category to an exit code.

## Worked examples

**Safe upgrade with checks**

```text
invariant users-preserved        PASSED
invariant balances-preserved     PASSED
assertion application-healthy    PASSED
→ PASSED, exit 0
```

**Destructive migration**

```text
invariant users-preserved        PASSED
invariant balances-preserved     FAILED   expected 3000, got 1800
invariant email-column-present   FAILED   expected 1, got 0
→ FAILED, exit 1
```

**Nothing verified**

```yaml
scenarios:
  - id: upgrade
    from: { image: app:1 }
    to: { image: app:2 }
    # no invariants, no assertions
```

→ `INCONCLUSIVE`, exit 7. A started container is not verification.

**Cancelled**

Ctrl+C during readiness → `CANCELLED`, exit 4. Cleanup still runs and is reported; a failed cleanup is
recorded in the report even when the cancellation itself is expected.

## Run-level aggregation

When several scenarios run:

- any `FAILED` ⇒ run `FAILED`;
- any `INCONCLUSIVE` (without a failure) ⇒ run `INCONCLUSIVE`;
- all `PASSED` ⇒ run `PASSED`;
- `CANCELLED` mixed with any other status ⇒ `FAILED`, because a partially verified batch is not a safe pass;
- only `CANCELLED` ⇒ `CANCELLED`.
