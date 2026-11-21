# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Strict, versioned `upgradelab.yaml` configuration with environment references, duplicate-id detection and
  cross-field validation.
- Execution engine with preflight, source/target/multi-hop upgrades, per-scenario and per-check timeouts,
  cancellation, evidence collection and ownership-safe cleanup.
- SQL invariants compared against a captured baseline; read-only `sql` assertions; `http`, `command`,
  `container` and `health` assertions.
- PostgreSQL adapter with a static SQL guard, `READ ONLY` transactions, statement timeouts and row caps.
- Hardened Docker Compose provider: loopback-only ports, resource limits, `no-new-privileges`, generated
  run-owned Compose files, Compose ≥ 2.20 preflight and label-verified cleanup.
- JSON (schema v1), Markdown and JUnit reporters, all rendered from a single redacted report.
- Plugin SDK (API v1) for assertion types, database adapters, environment providers and report formats,
  with explicit-path loading and reserved-name protection.
- CLI commands `init`, `doctor`, `validate`, `run`, `report`, `plugin list` and `version`, with stable exit
  codes and a machine-readable `--json` mode.
- GitHub Action entry point with configurable `fail-on`, job summary, outputs and no requested permissions.
- Optional AI diagnostics (OpenAI, Anthropic, Gemini, OpenAI-compatible) that are disabled by default,
  redacted before transmission and cannot affect verdicts.
- Fixtures for a safe upgrade, a destructive migration and a multi-hop path; runnable examples for a basic
  upgrade, a multi-hop upgrade and a PostgreSQL migration.
- Unit, contract, integration, end-to-end and security test suites; Docker-backed tests are opt-in.

### Security

- Secret redaction for connection strings, authorization headers, provider tokens, JWTs, key/value pairs and
  sensitive JSON keys.
- Compose security analysis rejects privileged containers, host namespaces, added capabilities, host
  devices, Docker socket mounts, unsafe bind mounts and non-loopback ports by default.
- Argument-array process execution throughout; no shell interpolation.
