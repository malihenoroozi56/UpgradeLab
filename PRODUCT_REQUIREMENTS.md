# Product requirements

This document records what UpgradeLab promises, so that implementation choices can be judged against a
stable target. It is intentionally narrower than "test all software".

## Problem

Teams ship upgrades that start successfully but corrupt, truncate or hide user data. Existing smoke tests
prove availability, not preservation. Upgrade verification is usually manual, unrepeatable and absent from
CI.

## Goals

1. **Deterministic verification.** A verdict must be reproducible from checks and evidence, with no AI,
   network model or human judgement in the decision.
2. **Real upgrades.** Run the actual images and the actual migrations in an isolated environment; do not
   simulate the upgrade in a mock database.
3. **Data-first checks.** SQL invariants compared before/after, plus assertions against the upgraded system.
4. **Honest outcomes.** Missing verification must produce `INCONCLUSIVE`, never `PASSED`.
5. **Actionable evidence.** Reports explain what failed, with redacted logs, check details and cleanup status.
6. **Safe by default.** UpgradeLab must not become a way to escape a CI container or damage unrelated
   Docker resources.
7. **Extensible without forks.** Plugins can add assertion types, database adapters, providers and reports.
8. **CI-native.** A CLI with stable exit codes and a GitHub Action that propagates the verdict.

## Non-goals

- Production deployment, rollback orchestration or database backups.
- Performance, load or chaos testing.
- Proving correctness of arbitrary application logic beyond configured checks.
- Running untrusted plugins safely; plugins are code execution by design.
- Replacing migration linters or schema-diff tools.

## Functional requirements

| ID    | Requirement                                                                         |
| ----- | ----------------------------------------------------------------------------------- |
| FR-1  | Load a strict, versioned YAML configuration; reject unknown fields.                 |
| FR-2  | Support `from`/`to` and multi-hop `path` scenarios.                                 |
| FR-3  | Run setup commands against the source release before capturing baselines.           |
| FR-4  | Capture SQL invariants read-only and compare them after the upgrade.                |
| FR-5  | Execute `http`, `command`, `sql`, `container` and `health` assertions.              |
| FR-6  | Compute PASSED / FAILED / INCONCLUSIVE / CANCELLED from check results.              |
| FR-7  | Always clean up, and only remove resources owned by the run.                        |
| FR-8  | Write JSON, Markdown and JUnit reports; support plugin formats.                     |
| FR-9  | Redact secrets from logs, evidence and every report format.                         |
| FR-10 | Provide `init`, `doctor`, `validate`, `run`, `report`, `plugin list`, `version`.    |
| FR-11 | Provide a GitHub Action that fails on configured statuses and writes a job summary. |
| FR-12 | Load plugins from explicit paths with a versioned API and scoped registration.      |
| FR-13 | Offer optional AI diagnostics that never influence verdicts.                        |
| FR-14 | Support cancellation with cleanup and a dedicated exit code.                        |
| FR-15 | Document exit codes, configuration, report schema and plugin API.                   |

## Non-functional requirements

- **Reliability:** cleanup runs even on failure/cancellation; a run never leaves labelled resources behind
  without reporting it.
- **Security:** no Docker socket, no privileged containers, loopback-only ports by default, no shell
  interpolation, ownership-checked cleanup.
- **Determinism:** no random seeds in checks, stable check ids, stable report schema, timestamps only where
  they describe execution.
- **Portability:** Node.js ≥ 22.12 on Linux, macOS and Windows; Linux containers via Docker Compose.
- **Performance:** preflight and configuration validation are offline and fast; Docker runs are bounded by
  per-scenario and per-check timeouts.
- **Maintainability:** strict TypeScript, small ports, unit/contract/integration tests, ADRs for decisions.

## Success criteria

- A safe upgrade with real invariants yields `PASSED` and exit code 0.
- A destructive migration yields `FAILED`, exit code 1, and a report naming the failed invariants.
- A run with no required checks yields `INCONCLUSIVE`, exit code 7.
- A cancelled run cleans up and yields `CANCELLED`, exit code 4.
- A plugin reporter cannot leak a literal secret present in logs.
- The engine can be fully tested with a fake provider (no Docker required for the core logic).

## Out of scope for 1.0

Kubernetes provider, MySQL adapter, hosted dashboard, parallel scenario execution, binary distributions.
See `docs/plan/ROADMAP.md`.
