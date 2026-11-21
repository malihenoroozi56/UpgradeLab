# Architecture

UpgradeLab is a pnpm workspace monorepo with a small, explicit dependency graph. The goal is that
verification logic is testable without Docker, PostgreSQL or an AI provider, while production adapters
remain thin and auditable.

## Package graph

```text
                         ┌────────────────────┐
                         │     contracts      │  schemas, errors, redaction, report types
                         └─────────┬──────────┘
              ┌────────────────────┼─────────────────────┐
              │                    │                     │
       ┌──────▼──────┐      ┌──────▼──────┐       ┌──────▼──────────┐
       │   config    │      │    core     │       │   plugin-sdk    │
       └──────┬──────┘      └──────┬──────┘       └─────────────────┘
              │                    │
              │       ┌────────────┼──────────────┬─────────────────┐
              │       │            │              │                 │
       ┌──────▼───────▼──┐  ┌──────▼──────┐ ┌─────▼──────────┐ ┌────▼─────────┐
       │ assertion-engine│  │  reporters  │ │database-postgres│ │docker-compose│
       └─────────────────┘  └─────────────┘ └─────────────────┘ └──────────────┘
                                      │
                            ┌─────────▼─────────┐
                            │    ai-assistant    │  optional, advisory only
                            └───────────────────┘
                                      │
                         ┌────────────▼────────────┐
                         │  apps/cli + action      │
                         └─────────────────────────┘
```

`contracts` depends only on `zod`. `core` depends on `contracts`. Adapters depend on `contracts` and
implement ports; they are wired together by the CLI runtime and by tests. `ai-assistant` is never imported
by `core` or the assertion engine.

## Execution engine

`packages/core/src/engine.ts` owns the lifecycle and nothing else:

1. provider preflight;
2. create a run-scoped environment;
3. start the source image and run scenario setup commands;
4. open a read-only database session and capture invariant baselines;
5. run source assertions;
6. replace the image for every hop, checking readiness each time;
7. run target assertions and invariant evaluation;
8. always clean up with an independent timeout;
9. aggregate check results into a verdict.

The engine consumes two ports:

- `EnvironmentProvider` — create/start/replace services, endpoints, command execution, logs, cleanup;
- `CheckRunner` — validate assertions, capture baselines, run assertions and invariants.

Either port can be replaced by a fake (tests) or a plugin (other platforms), which is why the integration
tests can exercise the full engine without Docker.

## Verdict computation

Verdicts are pure functions in `packages/contracts/src/result.ts`:

- cancellation wins (`CANCELLED`);
- any required `FAILED` ⇒ `FAILED`;
- an orchestration error with no failed required check ⇒ `INCONCLUSIVE`;
- zero required checks, or any required `SKIPPED`/`ERROR` ⇒ `INCONCLUSIVE`;
- otherwise `PASSED`.

A successful container start contributes a `container` check only when configured; it never implies
`PASSED` on its own. Run-level aggregation maps mixed `CANCELLED` + other results to `FAILED`, because a
partially cancelled batch is not a safe pass.

## Configuration pipeline

`packages/config` loads YAML, resolves `${VAR}` and `${VAR:-default}` references (recording secret values
for redaction), rejects unknown keys, enforces `schemaVersion`, validates cross-field rules, normalizes
`from`/`to` into an ordered `path`, and computes a SHA-256 hash of the raw configuration for the report.
Environment interpolation never touches command arrays as shell syntax; values stay separate arguments.

## Environment isolation

`packages/docker-compose-provider`:

1. runs `docker compose config --format json` to resolve the user file;
2. analyzes it for privileged mode, host namespaces, capabilities, devices, Docker socket mounts, unsafe
   bind mounts, build contexts and non-loopback ports;
3. rewrites it into a generated file: loopback published ports with ephemeral host allocation, memory/CPU/PID
   limits, `no-new-privileges`, dropped build contexts, run ownership labels, optional internal networks;
4. starts services with argument arrays and an explicit `-p upgradelab-…` project name;
5. verifies `upgradelab.run-id` labels before removing containers, volumes or networks.

Dependencies (`depends_on`, typically the database) are started on the first `up`, while later hops use
`--no-deps` so the database is never recreated during an upgrade.

## Read-only SQL

Static validation (`sql-guard.ts`) strips comments and literals, allows a single read-only statement, and
rejects mutating keywords and dangerous functions. The PostgreSQL adapter additionally opens a
`READ ONLY` transaction, sets a statement timeout and a server-side read-only default. The database is the
authority, not the text scanner.

## Reporting

`buildReportDocument` creates a versioned document. `writeReports` redacts it once with the configured
redactor and then renders every format from the redacted document. Reporters cannot bypass redaction
because they never see the unredacted report.

## Failure handling

- Cancellation aborts the signal tree; cleanup uses an independent timeout and still verifies ownership.
- Every check has its own timeout; a timed-out check becomes `ERROR` (⇒ `INCONCLUSIVE` if required).
- Provider errors that prevent verification are recorded as `INCONCLUSIVE`, except target-start failures
  which are a real upgrade failure (`FAILED`).
- AI errors are warnings. They cannot mutate check statuses or the report verdict.

## Versioning

Three public surfaces are versioned independently: `CONFIG_SCHEMA_VERSION`, `REPORT_SCHEMA_VERSION` and
`PLUGIN_API_VERSION`. Changing any of them requires an ADR and a migration note
(`docs/configuration/migration.md`).
