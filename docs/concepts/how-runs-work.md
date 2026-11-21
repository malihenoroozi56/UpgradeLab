# How a run works

```text
preflight → create environment → start source → seed → capture baseline
          → hop 1 → … → hop N → verify → cleanup → report
```

## 1. Preflight

The CLI validates the configuration, loads plugins, resolves the provider and asks it to run preflight
checks. The Docker Compose provider requires:

- Docker CLI on `PATH`;
- Compose plugin ≥ 2.20 (`docker compose config --format json`);
- a reachable daemon (`docker info`).

AI configuration is checked only for syntax and key presence; AI never blocks a run.

## 2. Environment

The provider resolves the user Compose file and analyzes it:

- privileged containers, host namespaces, added capabilities and host devices are rejected;
- Docker socket mounts and unsafe bind mounts are rejected;
- build contexts and secret/config files outside allowed roots are rejected;
- non-loopback published ports are rejected unless explicitly allowed.

The resolved configuration is rewritten into `<run-dir>/compose.generated.yaml` with loopback ports,
resource limits, `no-new-privileges` and ownership labels. The project is named `upgradelab-<run>-<scenario>`.

## 3. Source release

The source image starts. `depends_on` services such as the database start with it and honour health
conditions. Readiness is verified according to `environment.application.healthcheck`.

For an HTTP healthcheck, UpgradeLab resolves the published port and polls the path with a bounded timeout.
For a command healthcheck, it runs the command inside the container. Without a healthcheck, only the
container state is checked, and a warning is recorded — this is weaker evidence.

## 4. Setup and baseline

Scenario setup commands run inside the source container (for example a seed script). Then a read-only
database session opens through the configured adapter, and every SQL invariant is executed once. The
results form the baseline.

If a baseline query fails, the invariant produces an `ERROR` check and the run cannot be verified.

## 5. Upgrade

For each image in the path after the source, the application service is recreated with the new image and
readiness is checked again. The database is never recreated between hops. A target-start failure is treated
as a failed upgrade, not as an inconclusive one.

## 6. Verification

- Invariants are re-executed and compared with the baseline (`equal-before-after`,
  `numeric-equal-before-after`, `equal`, `non-empty`, `empty`, `matches`, `at-least`, `at-most`).
- Assertions run against the upgraded system: HTTP responses, SQL queries, commands, container state and
  health.
- Source-specific assertions may be attached to the source step; target assertions to the target step.

## 7. Cleanup

Cleanup runs even after failure or cancellation, with an independent timeout. The provider lists containers
for the Compose project, inspects their labels, and refuses to delete anything not labelled with this run's
`upgradelab.run-id`. Leftover volumes and networks are inspected individually.

## 8. Report

Checks, evidence, logs, events and cleanup results are assembled into a versioned report. The report is
redacted once and rendered to JSON, Markdown, JUnit and any plugin formats.

## Timeouts and cancellation

Every phase is bounded: readiness, each check, each setup command, the whole scenario and cleanup. A
per-check timeout produces `ERROR`; a scenario timeout produces `INCONCLUSIVE` unless a required check
already failed. Ctrl+C aborts the signal tree, marks the run `CANCELLED`, and triggers cleanup.
