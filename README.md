# UpgradeLab

**Prove that your software upgrade preserves user data — before your users find out it did not.**

UpgradeLab runs real upgrade scenarios in isolated Docker Compose environments, captures the state of
your application and database before the upgrade, applies the new release, and then verifies the same
invariants against the upgraded system. A container that starts is not evidence. Only checks are.

```text
source release  →  seed data  →  capture baseline  →  upgrade (one or more hops)  →  verify invariants  →  FAIL or PASS
```

- **Deterministic verdicts.** PASSED / FAILED / INCONCLUSIVE / CANCELLED are computed from checks alone.
- **Data-first assertions.** SQL invariants, read-only SQL assertions, HTTP, command and container checks.
- **Isolated by default.** One generated Compose project per run, loopback-only ports, resource limits,
  no Docker socket, no privileged containers, ownership-labelled cleanup.
- **Evidence you can attach to a bug report.** JSON, Markdown and JUnit reports with redacted logs.
- **Optional AI, never authoritative.** AI explanations are advisory, opt-in, provider-independent and
  cannot change a verdict.
- **Apache-2.0.** No open-core traps.

> **Project status:** pre-release (`1.0.0-dev.0`). The TypeScript packages, CLI, reporters, plugin SDK,
> Docker Compose provider and tests are implemented. Docker-dependent end-to-end validation is opt-in
> and must be run on a machine with Docker installed; see [Verification](#verification).

---

## Why this exists

Most upgrade pipelines test that the new container starts. That misses the failures users care about:

- a migration drops a column that the application still writes to;
- a backfill rewrites money with a rounding bug;
- a new release starts, is healthy, and silently serves an empty database;
- a multi-hop upgrade works from `v1 → v3` but corrupts data at `v2`;
- the upgrade succeeds, but cleanup leaves orphaned volumes and networks behind.

A green "container started" signal is not verification. UpgradeLab exists to make data preservation a
testable, repeatable property of every release.

## Features

| Area            | What UpgradeLab provides                                                               |
| --------------- | -------------------------------------------------------------------------------------- |
| Scenarios       | `from`/`to` upgrades and multi-hop `path` upgrades (up to 10 images)                   |
| Data invariants | Read-only SQL captured before the upgrade and compared after it                        |
| Assertions      | `sql`, `http`, `command`, `container`, `health`, plus plugin-defined types             |
| Verdicts        | PASSED, FAILED, INCONCLUSIVE, CANCELLED with documented exit codes                     |
| Environments    | Hardened Docker Compose provider; provider interface for plugins                       |
| Reports         | JSON (schema v1), Markdown, JUnit XML, plus plugin report formats                      |
| CLI             | `init`, `doctor`, `validate`, `run`, `report`, `plugin list`, `version`                |
| CI              | GitHub Action with `action.yml`, job summary, artifacts and status propagation         |
| Plugins         | Versioned plugin API for assertions, database adapters, providers and reporters        |
| AI (optional)   | Failure explanations, log analysis, schema review, invariant suggestions, issue drafts |
| Security        | Secret redaction, argument arrays only, ownership-checked cleanup, loopback-only ports |

## Quick start

Requirements: **Node.js ≥ 22.12**, **pnpm 10**, **Docker with Compose ≥ 2.20** (for actual runs).

```bash
git clone <your-fork-or-checkout> UpgradeLab
cd UpgradeLab
pnpm install
pnpm build
node apps/cli/dist/bin.js --help
```

Create a configuration in your project:

```bash
cd /path/to/your/project
node /path/to/UpgradeLab/apps/cli/dist/bin.js init
node /path/to/UpgradeLab/apps/cli/dist/bin.js doctor
node /path/to/UpgradeLab/apps/cli/dist/bin.js validate
node /path/to/UpgradeLab/apps/cli/dist/bin.js run --scenario upgrade-1-to-2
```

Build the sample fixtures and run the shipped example end to end:

```bash
./fixtures/build-images.sh
node apps/cli/dist/bin.js run --config examples/basic-upgrade/upgradelab.yaml
```

## How it works

1. **Preflight** checks Node, configuration, Docker, Compose and plugins before creating anything.
2. **Environment** is created as a uniquely named `upgradelab-*` Compose project. The user Compose file is
   resolved with `docker compose config --format json` and rewritten into a hardened, run-owned file:
   loopback host ports, memory/CPU/PID limits, `no-new-privileges`, ownership labels, no build contexts.
3. **Source release** starts, the scenario's setup commands seed data, and the database session opens.
4. **Baseline** captures every SQL invariant with a read-only query (inside `READ ONLY` transactions).
5. **Upgrade** replaces the application image with each hop in order. Readiness is checked every time.
6. **Verification** re-runs invariants, compares them with the baseline, and executes post-upgrade
   assertions (HTTP, SQL, command, container, health, plugin checks).
7. **Cleanup** always runs, even after failures and cancellation, and only removes resources whose labels
   prove they belong to this run.
8. **Reports** are redacted once and rendered to every requested format from the same redacted document.

The engine never decides that a run passed because a container started. If no required check ran, the
verdict is `INCONCLUSIVE`.

## Verdicts

| Verdict        | Meaning                                                                     | Exit code |
| -------------- | --------------------------------------------------------------------------- | --------- |
| `PASSED`       | Every required check passed and at least one required check ran.            | 0         |
| `FAILED`       | At least one required check failed, or cleanup failed.                      | 1         |
| `INCONCLUSIVE` | The upgrade completed but could not be verified (no checks, errors, skips). | 7         |
| `CANCELLED`    | The run was cancelled (for example with Ctrl+C).                            | 4         |

Configuration errors exit with `2`, environment/Docker errors with `3`, plugin errors with `6` and
unexpected internal errors with `5`. The full mapping lives in
[`packages/contracts/src/errors.ts`](packages/contracts/src/errors.ts) and
[docs/concepts/verdicts.md](docs/concepts/verdicts.md).

## Configuration

A configuration is a strict, versioned YAML document. Unknown keys are rejected so typos fail loudly.

```yaml
schemaVersion: 1
project:
  name: my-app
environment:
  composeFile: ./docker-compose.yml
  application:
    service: app
    port: 3000
    healthcheck:
      type: http
      path: /health
  database:
    service: db
    adapter: postgres
  timeouts:
    startMs: 120000
    readinessMs: 120000
scenarios:
  - id: upgrade-1-to-2
    from:
      image: my-app:1.0.0
      setup:
        - target: app
          command: ['node', '/app/seed.mjs']
    to:
      image: my-app:2.0.0
    invariants:
      - id: users-preserved
        type: sql
        query: SELECT COUNT(*) FROM users
        comparison: equal-before-after
      - id: email-column-present
        type: sql
        query: >-
          SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'email'
        expected: 1
    assertions:
      - id: health
        type: http
        path: /health
```

Every field is documented in [docs/configuration/reference.md](docs/configuration/reference.md).
Secrets can reference environment variables (`${DB_PASSWORD}`), are redacted from reports, and are
never written to disk by UpgradeLab.

## Reports

`upgradelab run` writes one report per requested format under `.upgradelab/reports/<run-id>/`:

- `json` — machine-readable report (schema version `1`), used by the Action and integrations;
- `markdown` — human summary with check table, evidence excerpts, logs and optional AI advisories;
- `junit` — one test case per check, plus synthetic `upgrade-execution`, `verdict` and `cleanup` cases.

```bash
upgradelab run --format json --format markdown --output reports/
upgradelab report --file reports/upgradelab-report.json --format junit
```

Reports are redacted once, before rendering, so a plugin reporter cannot leak a secret that the
built-in reporters removed.

## CLI

```text
upgradelab init         create a documented upgradelab.yaml
upgradelab doctor       diagnose Node, Docker, Compose, configuration and plugins
upgradelab validate     validate configuration and plugins without starting containers
upgradelab run          execute upgrade scenarios
upgradelab report       re-render an existing report
upgradelab plugin list  list loaded plugins and registered capabilities
upgradelab version      print tool and schema versions
```

Run options include `--scenario`, `--from-image`, `--to-image`, `--timeout`, `--format`, `--output-dir`,
`--plugin`, `--ai`, `--json`, `--verbose`, `--skip-reports` and `--keep-run-dir`. `--json` emits a single machine-readable
document on stdout and keeps diagnostics on stderr.

See [docs/reference/cli.md](docs/reference/cli.md).

## GitHub Action

```yaml
name: upgrade-verification

on:
  pull_request:

permissions:
  contents: read

jobs:
  upgradelab:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: ./fixtures/build-images.sh
      # Replace the ref with the commit or tag you want to run.
      - uses: your-org/UpgradeLab@main
        with:
          config: upgradelab.yaml
          report-formats: json,markdown,junit
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: upgradelab-report
          path: .upgradelab/reports
```

The Action requests no token and no permissions by itself. It fails the step when the run status is
`FAILED` or `INCONCLUSIVE` by default (`fail-on` is configurable), writes a job summary and exposes the
report paths as outputs. See [docs/guides/github-actions.md](docs/guides/github-actions.md) for fork and
self-hosted runner guidance.

## Plugins

Plugins are explicit ES modules loaded from operator-controlled paths. They can register:

- custom assertion types (`registerAssertion`);
- database adapters (`registerDatabaseAdapter`);
- environment providers (`registerEnvironmentProvider`);
- report formats (`registerReporter`).

```js
export default {
  name: 'my-plugin',
  version: '1.0.0',
  apiVersion: 1,
  register(registry) {
    registry.registerAssertion({
      type: 'row-count',
      async execute(assertion, context) {
        return { passed: true, message: 'checked' };
      },
    });
  },
};
```

Plugins execute with the permissions of the process running UpgradeLab. They are never downloaded and
never loaded from remote configuration unless `security.allowConfigPlugins` is explicitly enabled.
Built-in assertion types and report formats cannot be overridden. See
[docs/guides/plugins.md](docs/guides/plugins.md) and [`examples/plugins/csv-reporter`](examples/plugins/csv-reporter).

## Optional AI diagnostics

AI is **off by default**, disabled unless both `ai.enabled: true` and `--ai` are present.

```yaml
ai:
  enabled: true
  provider: openai # openai | anthropic | gemini | openai-compatible
  model: gpt-4.1-mini
  apiKeyEnv: OPENAI_API_KEY # name, never the key itself
  features: [explain-failure, analyze-logs]
```

```bash
export OPENAI_API_KEY=...
upgradelab run --ai --scenario upgrade-1-to-2
```

Prompts are redacted before they leave the process. AI output is stored as an advisory, rendered with a
mandatory disclaimer, and ignored for verdict computation. Provider failures degrade to a warning; they
never turn a failed run into a passing one, or vice versa. See [docs/guides/ai-diagnostics.md](docs/guides/ai-diagnostics.md).

## Architecture

```text
apps/cli              commander CLI, UI, services, runtime wiring
apps/github-action    GitHub Action entry point and bundle script
packages/contracts    versioned schemas, errors, report types, redaction
packages/config       strict YAML loading, env resolution, scenario selection
packages/core         execution engine, timeline, evidence, logging, IDs, timeouts
packages/assertion-engine  built-in assertion and invariant handlers, comparison
packages/database-postgres read-only SQL guard and PostgreSQL adapter
packages/docker-compose-provider  Compose provider, security analysis, readiness
packages/reporters     JSON, Markdown and JUnit reporters, redacting writer
packages/plugin-sdk   explicit plugin loading and scoped registration
packages/ai-assistant optional provider adapters and advisory generation
```

Dependency direction points inward: `contracts` has no runtime dependency on the rest, and `core`
depends on contracts rather than on Docker or PostgreSQL. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Security

- No Docker socket mount and no privileged containers; compose configurations are analyzed before start.
- Host ports bind to loopback by default; non-loopback binding requires explicit opt-in.
- Process execution uses argument arrays (Execa), never shell interpolation.
- Cleanup verifies `upgradelab.run-id` ownership labels before removing anything.
- Secrets from environment references are redacted from logs and every report format.
- Read-only SQL is enforced inside a PostgreSQL `READ ONLY` transaction, not only by text inspection.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). The threat model is in
[THREAT_MODEL.md](THREAT_MODEL.md).

## Verification

This repository distinguishes three states honestly:

- **Executed here:** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and the full
  Vitest suite (unit, contract, integration with a fake provider, CLI end-to-end with a fake provider,
  security tests).
- **Opt-in:** Docker-backed tests (`UPGRADELAB_TEST_DOCKER=1 pnpm test:docker`) and live PostgreSQL
  contract tests (`UPGRADELAB_TEST_POSTGRES_URL=... pnpm test`). These are skipped, never silently
  passed, when prerequisites are missing.
- **Not run:** Docker upgrade runs on machines without Docker are reported as NOT RUN in the final
  execution report. A successful container start is never treated as proof of a safe upgrade.

```bash
pnpm verify                 # build + lint + format check + tests
pnpm test:docker            # Docker-backed integration tests (requires Docker)
```

## Limitations

- The first-class provider is Docker Compose; other providers require a plugin.
- SQL verification supports PostgreSQL today; other databases require a database adapter plugin.
- Docker Compose ≥ 2.20 is required for `docker compose config --format json`.
- Windows containers are not tested; Linux containers are the supported target.
- AI diagnostics are advisory and provider-dependent; they are not part of the verdict.
- The project is pre-release. Configuration, report and plugin schemas are versioned, but APIs may change
  with a major version and an ADR.

## Roadmap

See [docs/plan/ROADMAP.md](docs/plan/ROADMAP.md). Near-term work: Docker-backed CI validation, a MySQL
adapter, a Kubernetes provider plugin, and richer evidence capture for failing migrations.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
and [GOVERNANCE.md](GOVERNANCE.md). Run `pnpm verify` before opening a pull request, and use Conventional
Commits.

## License

Apache License 2.0. See [LICENSE](LICENSE).
