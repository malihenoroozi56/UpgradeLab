# Notes for AI coding agents

This file is for automated assistants working in this repository. Follow it in addition to the user's
instructions.

## Mission

UpgradeLab proves that a software upgrade preserves user data. The core product rule:

> A successful container start is not proof of a safe upgrade. No required checks ⇒ `INCONCLUSIVE`.

Never weaken that rule, and never report Docker validation as passing when Docker was unavailable.

## Repository map

- `packages/contracts` — versioned schemas, errors, report types, redaction. No dependency on adapters.
- `packages/config` — YAML loading, env references, scenario selection, init template.
- `packages/core` — execution engine, timeline, evidence, logging, IDs, timeouts.
- `packages/assertion-engine` — built-in assertion/invariant handlers and SQL comparison.
- `packages/database-postgres` — read-only SQL guard and PostgreSQL adapter.
- `packages/docker-compose-provider` — Compose execution, security analysis, canonicalization, readiness.
- `packages/reporters` — JSON/Markdown/JUnit reporters and the redacting writer.
- `packages/plugin-sdk` — explicit plugin loading and scoped registries.
- `packages/ai-assistant` — optional, advisory-only AI diagnostics.
- `apps/cli` — Commander CLI and services.
- `apps/github-action` — Action entry point; bundle with `pnpm build:action`.
- `tests/` — unit, contract, integration, e2e and security tests.
- `fixtures/` — Docker demo application and intentionally broken migration.
- `examples/` — runnable configurations and the CSV reporter plugin.

## Commands

```bash
pnpm install
pnpm build                 # tsc -b (emits dist/ for packages, apps and the example plugin)
pnpm typecheck             # tsc -b --force
pnpm lint                  # eslint (type-unaware; tsc is authoritative)
pnpm format:check
pnpm test                  # vitest run
pnpm verify                # build + lint + format check + tests
pnpm build:action          # esbuild bundle for the GitHub Action
pnpm test:docker           # opt-in Docker tests; skipped without a daemon
```

When a test needs Docker, gate it with a real availability check and print **NOT RUN** rather than skipping
silently. Do not add a test that would report `PASSED` without executing the upgrade.

## Rules

- TypeScript strict. No `any`, no non-null assertions unless unavoidable and explained.
- Process execution uses argument arrays (Execa). Never interpolate configuration into a shell string.
- Read-only SQL must be validated statically **and** executed inside a `READ ONLY` transaction.
- Cleanup must verify ownership labels before deleting anything. Never add `docker system prune`.
- Keep AI outside the verdict path. AI failures are warnings, not failures or passes.
- Redact reports once, before rendering any format, including plugin formats.
- Do not add runtime dependencies without a strong reason; the dependency set is deliberately small.
- Update `docs/` and add a changeset for user-visible changes.
- Do not invent adoption, benchmark or security claims. State exactly what was executed.

## Common pitfalls

- Paths in this repository contain a space; quote them in shell commands.
- Windows: use `fileURLToPath` for plugin paths, not `new URL(...).pathname`.
- The Docker provider starts dependencies on the first `up` and uses `--no-deps` for later hops.
- The engine accumulates checks; verdicts come from `packages/contracts/src/result.ts`.
- `pnpm build` overwrites `dist/` for the Action library but not the bundled `dist/index.js`; keep the
  Action bundle produced by `pnpm build:action`.
- Adding a new error code requires updating the union and the category map in `contracts/src/errors.ts`.

## Definition of done

1. Implementation and failure paths are covered by tests.
2. `pnpm verify` passes; Docker-dependent work is either run or explicitly reported as NOT RUN.
3. Documentation and changeset are updated.
4. The final report separates IMPLEMENTED, VERIFIED, NOT VERIFIED and NOT IMPLEMENTED items.
