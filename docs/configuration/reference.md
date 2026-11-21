# Configuration reference

Configuration is a strict YAML document named `upgradelab.yaml`. Unknown keys are rejected. The schema
version is `1`.

```yaml
schemaVersion: 1
project:
  name: my-app
  description: optional
environment: { … }
defaults: { … }
security: { … }
plugins: […]
ai: { … }
scenarios: […]
```

## `project`

| Key           | Type           | Required | Description                                      |
| ------------- | -------------- | -------- | ------------------------------------------------ |
| `name`        | string (1–120) | yes      | Report name; not used as a Docker resource name. |
| `description` | string (≤1000) | no       | Human context included in reports.               |

## `environment`

| Key                       | Default                   | Description                                                      |
| ------------------------- | ------------------------- | ---------------------------------------------------------------- |
| `provider`                | `docker-compose`          | Registered environment provider id.                              |
| `composeFile`             | `./docker-compose.yml`    | Compose file path, relative to the config directory.             |
| `projectDirectory`        | config directory          | Compose project directory.                                       |
| `composeEnv`              | `{}`                      | Extra environment passed to Compose.                             |
| `application.service`     | —                         | Required Compose service under test.                             |
| `application.port`        | —                         | Container port of the application.                               |
| `application.healthcheck` | —                         | `http`, `tcp` or `command` readiness check.                      |
| `database`                | —                         | Required for SQL invariants/assertions.                          |
| `resources`               | `1g`, `1` CPU, `512` PIDs | Memory/CPU/PID limits applied to every service.                  |
| `network.bindAddress`     | `127.0.0.1`               | Published host bind address. `0.0.0.0` requires security opt-in. |
| `network.internal`        | `false`                   | Mark generated Compose networks internal (no egress).            |
| `timeouts`                | see below                 | Start/readiness/stop/command budgets.                            |

Healthcheck:

```yaml
healthcheck:
  type: http # http | tcp | command
  path: /health # http only, must start with /
  port: 3000 # optional; falls back to application.port
  command: ['pg_isready'] # command only
  intervalMs: 1000
  timeoutMs: 120000
```

Database:

```yaml
database:
  service: db
  adapter: postgres
  port: 5432
  database: upgradelab
  user: upgradelab
  password: ${DB_PASSWORD} # reference, never a literal in committed files
  ssl: false
  connectionTimeoutMs: 10000
  statementTimeoutMs: 5000
  maxRows: 1000
```

Timeouts (milliseconds): `startMs` 120000, `readinessMs` 60000, `stopMs` 60000, `commandMs` 60000.

## `defaults`

| Key                  | Default  |
| -------------------- | -------- |
| `scenarioTimeoutMs`  | `600000` |
| `assertionTimeoutMs` | `15000`  |
| `logTailLines`       | `500`    |
| `failFast`           | `false`  |

## `security`

| Key                     | Default | Effect                                                |
| ----------------------- | ------- | ----------------------------------------------------- |
| `allowConfigPlugins`    | `false` | Allow plugins referenced from the configuration file. |
| `allowNonLoopbackPorts` | `false` | Allow binding published ports to `0.0.0.0`.           |
| `extraMountRoots`       | `[]`    | Additional host paths allowed as bind-mount sources.  |

The Docker socket is always rejected, regardless of this section.

## `plugins`

```yaml
plugins:
  - path: ./plugins/my-plugin.mjs
    config:
      threshold: 3
```

Requires `security.allowConfigPlugins: true`. Plugin paths must resolve inside the project unless the
operator allows otherwise. CLI `--plugin` is also operator-controlled.

## `ai`

```yaml
ai:
  enabled: false # default
  provider: openai # openai | anthropic | gemini | openai-compatible
  model: gpt-4.1-mini
  baseUrl: http://127.0.0.1:11434/v1 # required for openai-compatible
  apiKeyEnv: OPENAI_API_KEY
  maxOutputTokens: 1200
  timeoutMs: 60000
  features:
    [
      explain-failure,
      analyze-logs,
      schema-review,
      suggest-invariants,
      failure-summary,
      prepare-issue,
    ]
```

AI also requires `--ai` on the command line. Keys are read from the environment only.

## Scenarios

```yaml
scenarios:
  - id: upgrade-1-to-2
    description: optional
    timeoutMs: 600000
    from:
      image: app:1.0.0
      healthcheck: { … } # optional per-step override
      setup:
        - target: app
          command: ['node', '/app/seed.mjs']
          env: { SEED_MODE: full }
          expectedExitCode: 0
          timeoutMs: 60000
      assertions: […] # optional source-only assertions
    to:
      image: app:2.0.0
      assertions: […] # optional target assertions
    invariants: […]
    assertions: […]
```

Use `path` instead of `from`/`to` for multi-hop upgrades. `path` and `from`/`to` are mutually exclusive.
A fresh-install path may contain a single image.

```yaml
scenarios:
  - id: multi-hop
    setup:
      - target: app
        command: ['node', '/app/seed.mjs']
    path:
      - image: app:1.0.0
      - image: app:2.0.0
      - image: app:3.0.0
```

### Invariants

```yaml
invariants:
  - id: users-preserved
    type: sql
    description: The user count is unchanged.
    query: SELECT COUNT(*) FROM users
    comparison: equal-before-after
    required: true
    timeoutMs: 15000
```

If `comparison` is omitted, supplying `expected` implies `equal`, while omitting it implies
`equal-before-after`. `tolerance` is valid only for numeric comparisons.

| Comparison                   | Meaning                                                |
| ---------------------------- | ------------------------------------------------------ |
| `equal-before-after`         | Same value as the pre-upgrade baseline.                |
| `numeric-equal-before-after` | Same numeric value within `tolerance`.                 |
| `equal`                      | Equals `expected`.                                     |
| `non-empty` / `empty`        | Result has at least one / no rows.                     |
| `matches`                    | First value matches the `expected` regular expression. |
| `at-least` / `at-most`       | First value compares against numeric `expected`.       |

### Assertions

```yaml
assertions:
  - id: health
    type: http
    path: /health
    expectedStatus: 200
    jsonPath: $.status
    jsonEquals: ok
  - id: row-count
    type: sql
    query: SELECT COUNT(*) FROM users
    expected: 3
  - id: seed-command
    type: command
    target: app
    command: ['node', '/app/check.mjs']
    expectedExitCode: 0
    stdoutContains: ok
  - id: container
    type: container
    target: app
    state: healthy
  - id: health-probe
    type: health
```

All assertions accept `id`, `description`, `required` (default `true`) and `timeoutMs`. A custom `type`
is dispatched to a plugin assertion handler.

## Environment references

```yaml
password: ${DB_PASSWORD}
password: ${DB_PASSWORD:-fallback}
literal: $${NOT_A_REFERENCE}
```

Missing variables without a default are a configuration error. Resolved values are tracked as secrets and
redacted from logs and reports.

## CLI overrides

`run --from-image`, `--to-image`, `--timeout`, `--scenario`, `--output-dir`, `--format`, `--skip-reports`,
`--ai` and `--plugin` are applied after loading and validation.
