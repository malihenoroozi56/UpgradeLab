# CLI reference

```text
upgradelab <command> [options]
```

Run from source with `node apps/cli/dist/bin.js <command>` until packages are published.

## Common options

| Option                | Description                                                                  |
| --------------------- | ---------------------------------------------------------------------------- |
| `--config <path>`     | Configuration file (default: `upgradelab.yaml` in the working directory).    |
| `--plugin <path>`     | Load a plugin module (repeatable).                                           |
| `--json`              | Emit one machine-readable JSON document on stdout; diagnostics go to stderr. |
| `--log-level <level>` | `trace`, `debug`, `info`, `warn`, `error`, `silent`.                         |
| `--no-color`          | Disable ANSI colour.                                                         |

## `init`

```bash
upgradelab init [--force] [--project-name <name>] [--compose-file <path>]
                [--app-service <name>] [--database-service <name>]
                [--from-image <image>] [--to-image <image>]
```

Writes `upgradelab.yaml`. Refuses to overwrite without `--force`. The generated file is validated by the
same loader used at runtime.

## `doctor`

```bash
upgradelab doctor
```

Checks Node version, configuration validity, plugins, database adapter, AI key presence and Docker/Compose.
Exit code `3` when an environment requirement such as Docker is missing; missing configuration is a warning.

## `validate`

```bash
upgradelab validate [--scenario <id>]
```

Offline check: loads configuration and plugins, validates assertion types and duplicate ids, prints the
upgrade paths. Never starts a container. Exits `2` on configuration errors and `6` on plugin errors.

## `run`

```bash
upgradelab run [--scenario <id>] [--from-image <image>] [--to-image <image>]
               [--timeout <ms>] [--format <format>] [--output-dir <path>]
               [--skip-reports] [--keep-run-dir] [--ai] [--verbose]
```

| Option                        | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `--scenario <id>`             | Run only the given scenario (repeatable). Default: all.                     |
| `--from-image` / `--to-image` | Override the first/last image of selected scenarios.                        |
| `--timeout <ms>`              | Override the per-scenario timeout.                                          |
| `--format <format>`           | Report format (repeatable): `json`, `markdown`, `junit` or a plugin format. |
| `--output-dir <path>`         | Report directory (default `.upgradelab/reports/<run-id>`).                  |
| `--skip-reports`              | Do not write report files.                                                  |
| `--keep-run-dir`              | Keep the per-run scratch directory (generated Compose file, evidence).      |
| `--ai`                        | Enable configured AI diagnostics for this run.                              |
| `--verbose`                   | Debug logging.                                                              |

Exit codes: `0` passed, `1` failed, `2` configuration, `3` environment, `4` cancelled, `5` internal,
`6` plugin, `7` inconclusive.

With `--json`, stdout contains one document:

```json
{
  "ok": true,
  "status": "PASSED",
  "runId": "…",
  "exitCode": 0,
  "scenarios": [{ "id": "upgrade-1-to-2", "status": "PASSED" }],
  "reports": [{ "format": "json", "path": "…" }]
}
```

## `report`

```bash
upgradelab report [--file <report.json>] [--format <format>] [--output-dir <path>]
```

Re-renders an existing JSON report. Without `--file`, uses the newest report under
`.upgradelab/reports/`. Without `--output-dir`, prints the rendered report(s) to stdout. In `--json` mode,
prints one envelope; when no output directory is used, the envelope contains the parsed `report` document.

Validates the report schema and refuses future major versions.

## `plugin list`

```bash
upgradelab plugin list
```

Lists loaded plugins, their registration kinds, built-in assertion types and report formats.

## `version`

```bash
upgradelab version [--json]
```

Prints the tool version, Node version, plugin API version, config schema version and report schema version.

## Signals

`SIGINT`/`SIGTERM` cancel the current run, trigger cleanup and exit with code `4`. A second Ctrl+C exits
immediately with code `130`.
