# Contributing to UpgradeLab

Thanks for helping make upgrades safer. This project values small, well-tested changes and honest
documentation over volume.

## Development setup

```bash
pnpm install
pnpm build
pnpm verify
```

Requirements: Node.js ≥ 22.12 and pnpm 10. Docker with Compose ≥ 2.20 is required only for Docker-backed
tests (`UPGRADELAB_TEST_DOCKER=1 pnpm test:docker`).

## Workflow

1. Open an issue for non-trivial changes, describing the user problem and the expected behaviour.
2. Create a branch with a descriptive name.
3. Add or update tests. A behaviour change without a test is incomplete.
4. Update documentation when a public surface changes (configuration, CLI, report schema, plugin API).
5. Run `pnpm verify`; Docker-related changes additionally run `pnpm test:docker`.
6. Open a pull request using the template. Explain the "why", the "how", and what you did **not** verify.

## Commit messages

Use Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `perf:`, `build:`, `ci:`.
Breaking changes use `!` and a `BREAKING CHANGE:` footer. Changesets are required for user-visible changes:

```bash
pnpm changeset
```

## Code standards

- TypeScript strict mode; avoid `any`, non-null assertions and unsafe casts.
- Keep dependencies minimal; new runtime dependencies need justification in the PR.
- No shell interpolation: always pass argument arrays to processes.
- No secrets in code, tests or fixtures. Use obvious placeholder values.
- Public schemas are versioned; changing them requires an ADR and a migration note.
- Errors use `UpgradeLabError` with a stable code and actionable hint.
- Logs and evidence must be safe to attach to a public issue after redaction.

## Tests

- Unit tests: pure logic (config, comparison, redaction, security analysis).
- Contract tests: ports and adapters (plugin loading, database adapter).
- Integration tests: the execution engine with a fake provider.
- End-to-end tests: CLI services with a fake provider; Docker-backed tests are opt-in.
- Security tests: report redaction, unsafe Compose rejection, ownership checks, SQL guard.

Never turn a skipped test into a passing claim. If Docker is unavailable, report Docker validation as
NOT RUN in the pull request.

## Review criteria

- Does the change prove the requested behaviour, including failure paths?
- Is the smallest useful change made?
- Are verdict semantics preserved (no accidental PASSED)?
- Are cleanup, cancellation and timeout paths safe?
- Could a secret, command or path escape its intended boundary?
- Is documentation accurate, without invented adoption or performance claims?

## Reporting bugs

Use the bug report template. Include the UpgradeLab version, Node version, Docker/Compose version, a minimal
configuration and a redacted report. Do not paste secrets or production data.

## Code of conduct

Participation is governed by `CODE_OF_CONDUCT.md`. Security issues follow `SECURITY.md`.
