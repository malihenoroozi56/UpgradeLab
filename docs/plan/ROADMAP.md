# Roadmap

Status legend: ✅ implemented and tested in this environment · 🟡 implemented, validation blocked by the
host · ⛔ not implemented.

## Phase 1 — Foundations ✅

- pnpm workspace, strict TypeScript project references, ESLint/Prettier, Vitest.
- `contracts`: version constants, error/exit-code model, redaction, config/report/provider/database/plugin types.
- `config`: strict YAML loading, env interpolation, schema-version gate, scenario selection.
- `core`: execution engine, timeline, evidence, logging, IDs, deadlines.

## Phase 2 — Verification engine ✅

- SQL invariants with baseline capture and comparison strategies.
- Built-in assertions: `http`, `command`, `sql`, `container`, `health`.
- Multi-hop paths, per-check timeouts, cancellation, cleanup with independent timeout.
- Deterministic verdict aggregation and documented exit codes.

## Phase 3 — Environment and database adapters 🟡

- Docker Compose provider with generated, hardened, run-owned Compose files ✅.
- Compose security analysis, readiness probes, ownership-checked cleanup ✅.
- PostgreSQL read-only adapter and SQL guard ✅.
- Docker-backed validation on a machine with a daemon: **NOT RUN here** (Docker is not installed on this
  host). The opt-in suite is `UPGRADELAB_TEST_DOCKER=1 pnpm test:docker`.

## Phase 4 — Reporting ✅

- JSON (schema v1), Markdown and JUnit reporters.
- Redact-once writer so plugin formats cannot bypass redaction.
- Reporter registry with aliases and reserved-name protection.

## Phase 5 — CLI ✅

- `init`, `doctor`, `validate`, `run`, `report`, `plugin list`, `version`.
- Exit-code mapping, `--json` mode, SIGINT/SIGTERM cancellation.
- `doctor` reports missing Docker as an environment failure (exit 3), not as a pass.

## Phase 6 — CI integration ✅

- GitHub Action entry point, `action.yml`, esbuild bundle, job summary, outputs, `fail-on` statuses.
- No token or permissions requested by the Action itself.

## Phase 7 — Extensibility and AI ✅

- Plugin SDK v1: assertions, database adapters, environment providers, report formats.
- Example CSV reporter plugin.
- Optional AI diagnostics with redaction, JSON validation and advisory-only output.

## Phase 8 — Fixtures, examples, documentation ✅

- Sample application v1, v2 and an intentionally destructive v2 migration.
- Examples: basic upgrade, multi-hop upgrade, PostgreSQL migration.
- README, architecture, threat model, product requirements, contributing, governance, ADRs, VitePress docs.

## Phase 9 — Docker validation 🟡

- Build fixture images and run `examples/basic-upgrade` → expected `PASSED`.
- Run `examples/multi-hop-upgrade` → expected `FAILED` on the destructive final hop.
- Run against a real PostgreSQL database for the live adapter contract.
- These are implemented as opt-in tests and documented as **NOT RUN** on hosts without Docker.

## Phase 10 — Release ⛔

- Publish `@upgradelab/*` packages to npm.
- Cut a signed `v1.0.0` tag and release notes.
- Publish the VitePress documentation site.
- Add a Docker-enabled CI matrix and a scheduled action self-test.

These require maintainer credentials and a release decision; they are intentionally not performed here.
