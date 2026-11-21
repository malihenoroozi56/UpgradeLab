# Troubleshooting

Start with:

```bash
upgradelab doctor
upgradelab validate
```

## `ENVIRONMENT_DOCKER_MISSING` (exit 3)

Docker CLI is not on `PATH`.

- Install Docker Desktop or Docker Engine with the Compose plugin.
- On Windows, run from a shell where `docker` is available.
- `doctor` reports the same condition; it is an environment failure, not a passing check.

## Compose version is too old

UpgradeLab requires Compose ≥ 2.20 for `docker compose config --format json`. Upgrade the Compose plugin
(`docker compose version`).

## `ENVIRONMENT_UNSAFE_COMPOSE_CONFIG`

The Compose file contains a setting UpgradeLab refuses to run:

- `privileged: true`, `network_mode: host`, `pid/ipc/uts: host`;
- `cap_add`, `devices`, `security_opt: seccomp=unconfined`;
- a Docker socket mount or a bind mount outside the project;
- a build context outside the project;
- a non-loopback published port.

Remove the setting. If a bind mount is legitimately needed, add its root to `security.extraMountRoots`.
For ports, either omit `ports` (UpgradeLab allocates loopback ports) or set
`security.allowNonLoopbackPorts: true` deliberately.

## Application never becomes ready

- Check `environment.application.healthcheck.path` and `port`.
- If the app depends on the database, ensure `depends_on` uses `condition: service_healthy` and that the
  database has a healthcheck.
- Increase `environment.timeouts.readinessMs` / `startMs`.
- Run with `--keep-run-dir` and inspect container logs in the report.

A readiness failure is recorded as an environment error; the report shows the last state and collected logs.

## SQL invariant errors

`ASSERTION_UNSAFE_QUERY` means the query is not read-only. Use a single `SELECT`, `WITH`, `SHOW`,
`EXPLAIN`, `VALUES` or `TABLE` statement. Avoid `FOR UPDATE`, `SELECT INTO`, `SET`, multiple statements and
functions such as `pg_terminate_backend`.

`No pre-upgrade baseline` means the baseline capture failed. Inspect the report's `ERROR` check; common
causes are a missing table before migration, a missing database configuration, or a query that only works
after the upgrade.

## `INCONCLUSIVE` when you expected `PASSED`

- No required checks were configured.
- A required check was skipped or errored.
- An orchestration error prevented verification.
- A scenario was cancelled.

`INCONCLUSIVE` is intentional: UpgradeLab will not call an unverified upgrade safe.

## Reports are missing

- Reports are written to `--output-dir` or `.upgradelab/reports/<run-id>/`.
- `--skip-reports` disables them.
- The run directory is removed unless `--keep-run-dir` is set.

## Plugin fails to load

- Build TypeScript plugins first; only `.js`/`.mjs` are accepted.
- `apiVersion` must be `1`.
- Paths outside the project require explicit permission.
- `PLUGIN_DUPLICATE` means a type or format is already registered; built-ins cannot be overridden.

## AI features do not run

AI requires all of:

1. `ai.enabled: true`;
2. `--ai` on the command;
3. the API key env var (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or the configured
   `apiKeyEnv`);
4. the requested feature in `ai.features`.

AI errors are warnings and never change the verdict.

## Windows notes

- Quote paths containing spaces.
- Use a Node version ≥ 22.12.
- Linux containers are required; Windows containers are not supported.

## Cleaning up after a failed run

A successful cleanup removes the generated project. If cleanup failed, the report lists the reason. List
resources with:

```bash
docker ps -a --filter label=upgradelab.managed=true
docker volume ls --filter label=upgradelab.managed=true
docker network ls --filter label=upgradelab.managed=true
```

Remove only resources whose `upgradelab.run-id` label matches the failed run. Never run `docker system prune`
blindly.
