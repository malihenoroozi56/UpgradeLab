# Getting started

## Prerequisites

- Node.js ≥ 22.12
- pnpm 10
- Docker with the Compose plugin ≥ 2.20 (required for real runs; `validate` and `doctor` work without it)

## Install from source

```bash
git clone https://github.com/upgradelab/upgradelab.git
cd upgradelab
pnpm install
pnpm build
node apps/cli/dist/bin.js --help
```

The CLI entry point is `apps/cli/dist/bin.js` until packages are published. Every command below works the
same way.

## Create a configuration

In the repository you want to verify:

```bash
node /path/to/upgradelab/apps/cli/dist/bin.js init
```

This writes `upgradelab.yaml` with a documented example. Adjust:

- `environment.composeFile` to your Compose file;
- `environment.application.service` and `port`;
- `environment.database` if you have one;
- the scenario images (`from`/`to`);
- the seed command and SQL invariants.

## Validate without Docker

```bash
node /path/to/upgradelab/apps/cli/dist/bin.js validate
```

Validation loads the configuration, resolves plugins, checks assertion support, rejects duplicate ids and
prints the upgrade paths. No container is started.

## Check your environment

```bash
node /path/to/upgradelab/apps/cli/dist/bin.js doctor
```

`doctor` checks Node, configuration, plugins, the database adapter and Docker/Compose. A missing Docker
installation produces exit code `3` with an explanation; it is not reported as success.

## Run an upgrade

```bash
node /path/to/upgradelab/apps/cli/dist/bin.js run --scenario upgrade-1-to-2
```

Reports are written to `.upgradelab/reports/<run-id>/`. Use `--format`, `--output-dir` and `--skip-reports`
to control output, and `--json` for a machine-readable document on stdout.

## Try the shipped example

```bash
# from the UpgradeLab repository
./fixtures/build-images.sh
node apps/cli/dist/bin.js run --config examples/basic-upgrade/upgradelab.yaml
```

Expected result: `PASSED`, exit code 0. The multi-hop example ends with an intentionally destructive
migration and is expected to be `FAILED`:

```bash
node apps/cli/dist/bin.js run --config examples/multi-hop-upgrade/upgradelab.yaml
```

## Next steps

- [How a run works](/concepts/how-runs-work)
- [Configuration reference](/configuration/reference)
- [Add UpgradeLab to GitHub Actions](/guides/github-actions)
- [Write a plugin](/guides/plugins)
