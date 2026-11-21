# GitHub Actions

The repository ships an Action at the root (`action.yml`) whose bundled entry point is
`apps/github-action/dist/index.js`. The bundle is generated with `pnpm build:action` and committed so that
the Action does not need a build step at runtime.

## Minimal workflow

```yaml
name: upgrade-verification

on:
  pull_request:

permissions:
  contents: read

jobs:
  upgradelab:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./fixtures/build-images.sh
      # Replace the ref with your fork/tag. Pin a commit SHA for supply-chain safety.
      - uses: your-org/UpgradeLab@main
        with:
          config: upgradelab.yaml
          report-formats: json,markdown,junit
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: upgradelab-report
          path: .upgradelab/reports
```

The Action requests **no** token and no permissions itself. The workflow decides what the job may access.
Grant `contents: read` only.

## Inputs

| Input                           | Default               | Description                                       |
| ------------------------------- | --------------------- | ------------------------------------------------- |
| `config`                        | `upgradelab.yaml`     | Configuration path.                               |
| `working-directory`             | `.`                   | Directory containing the config and Compose file. |
| `scenarios`                     | all                   | Comma/newline-separated scenario ids.             |
| `from-image`, `to-image`        | —                     | Image overrides.                                  |
| `timeout`                       | config                | Per-scenario timeout in milliseconds.             |
| `report-formats`                | `json,markdown,junit` | Report formats.                                   |
| `output-dir`                    | `.upgradelab/reports` | Report directory.                                 |
| `fail-on`                       | `failed,inconclusive` | Statuses that fail the step.                      |
| `ai`, `ai-provider`, `ai-model` | off                   | Optional AI diagnostics.                          |
| `plugin`                        | —                     | Comma-separated plugin module paths.              |
| `verbose`                       | `false`               | Debug logging.                                    |

## Outputs

`run-id`, `status`, `report-dir`, `json-report`, `markdown-report`, `junit-report`.

## Job summary

The Action appends a Markdown summary to `$GITHUB_STEP_SUMMARY`, including status, scenario verdicts and
failed checks. Failures include the report path so the artifact can be inspected.

## Status propagation

`fail-on` defaults to `failed,inconclusive`. A run that could not verify anything therefore fails the job;
this is deliberate. Set `fail-on: failed` only if you explicitly accept inconclusive results in CI.

## Security notes

- **Fork pull requests:** the Action runs untrusted Compose files and images. Do not expose repository
  secrets to workflows triggered by `pull_request_target`. Use `pull_request` with read-only permissions, or
  a separate trusted workflow.
- **Self-hosted runners:** Docker access is effectively root on the host. Run untrusted scenarios on
  disposable runners, never on a shared machine with unrelated containers.
- **Plugins** execute in-process. Only load plugin paths that are part of the reviewed repository.
- **AI** is disabled by default. If enabled, export the key as a secret and review the provider's data policy.

## Caching images

Build or pull fixture images in a previous step; the Action only runs the scenario. For private registries,
log in with `docker/login-action` and grant only the required packages permission.

## Matrix testing

```yaml
strategy:
  matrix:
    scenario: [upgrade-1-to-2, upgrade-2-to-3]
steps:
  - uses: your-org/UpgradeLab@main
    with:
      scenarios: ${{ matrix.scenario }}
```

Each scenario gets its own `upgradelab-*` Compose project, so parallel jobs do not collide as long as each
runner is independent.
