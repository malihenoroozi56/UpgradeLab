# Implementation status

Snapshot of what exists in the repository and what was actually executed.

## Packages

| Package                            | State | Notes                                                                                                            |
| ---------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`               | ✅    | Zod schemas, error codes/exit codes, redaction, report/provider/database/plugin contracts.                       |
| `packages/config`                  | ✅    | Strict YAML, `${VAR}` resolution, secret tracking, schema-version gate, init template.                           |
| `packages/core`                    | ✅    | Engine, timeline, evidence, logger, IDs, deadlines, database session, scenario access.                           |
| `packages/assertion-engine`        | ✅    | Five assertion handlers, SQL invariant capture/evaluate, comparison strategies.                                  |
| `packages/database-postgres`       | ✅    | Static SQL guard, `READ ONLY` sessions, timeouts, row caps, normalization.                                       |
| `packages/docker-compose-provider` | ✅    | Preflight, security analysis, canonicalization, readiness, ownership cleanup. Docker runtime not validated here. |
| `packages/reporters`               | ✅    | JSON/Markdown/JUnit, registry, redacting writer, report parser.                                                  |
| `packages/plugin-sdk`              | ✅    | Explicit-path ES module loading, API version check, scoped registration, reserved names.                         |
| `packages/ai-assistant`            | ✅    | OpenAI-compatible, Anthropic, Gemini providers; redacted prompts; advisory generation.                           |
| `apps/cli`                         | ✅    | All commands, services, runtime, UI, exit codes, cancellation.                                                   |
| `apps/github-action`               | ✅    | Inputs/outputs, status propagation, job summary, esbuild bundle.                                                 |
| `examples/plugins/csv-reporter`    | ✅    | Deterministic CSV reporter plugin.                                                                               |

## Fixtures and examples

| Item                                          | State                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `fixtures/sample-app-v1` / `v2` / `v2-broken` | ✅ Source, Dockerfiles and migrations; images not built here (Docker unavailable). |
| `fixtures/build-images.sh`                    | ✅ Script; **NOT RUN**.                                                            |
| `examples/basic-upgrade`                      | ✅ Configuration validates; Docker run **NOT RUN**.                                |
| `examples/multi-hop-upgrade`                  | ✅ Configuration validates; Docker run **NOT RUN**.                                |
| `examples/postgres-migration`                 | ✅ Configuration validates; Docker run **NOT RUN**.                                |

## Tests

| Suite                                                 | Result in this environment                                |
| ----------------------------------------------------- | --------------------------------------------------------- |
| Unit                                                  | ✅ Passing                                                |
| Contract (plugin SDK, database adapter offline)       | ✅ Passing; live PostgreSQL skipped (no URL)              |
| Integration (engine + fake provider)                  | ✅ Passing                                                |
| End-to-end CLI (fake provider + file-based commands)  | ✅ Passing                                                |
| Security (report redaction)                           | ✅ Passing                                                |
| Docker integration (`tests/integration/docker`)       | ⏸ **NOT RUN** — Docker is not installed on this host      |
| Live PostgreSQL contract                              | ⏸ **NOT RUN** — `UPGRADELAB_TEST_POSTGRES_URL` is not set |
| `pnpm verify` (build, typecheck, lint, format, tests) | ✅ Passing                                                |

The Docker suite prints an explicit `NOT RUN` line and skips; it never reports a passing upgrade without
executing one.

## What is not implemented

- npm publication, signed releases, documentation hosting.
- Docker-enabled CI matrix (workflows exist; they cannot start a daemon in this environment).
- MySQL adapter, Kubernetes provider, dashboard, parallel scenario execution.
- Windows container support.

## What is not verified

- Actual container startup, image pulls, migrations, readiness and cleanup against a Docker daemon.
- A live PostgreSQL connection and real `information_schema` queries.
- GitHub Actions execution on GitHub-hosted runners.

These are listed as **NOT VERIFIED** rather than assumed to work.
