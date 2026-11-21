# Tasks

Open work, ordered by priority. Completed work is recorded in
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Validation

- [ ] Build fixture images: `./fixtures/build-images.sh`.
- [ ] Run `examples/basic-upgrade` with Docker → expect `PASSED` and exit 0.
- [ ] Run `examples/multi-hop-upgrade` with Docker → expect `FAILED` on the destructive hop.
- [ ] Run `examples/postgres-migration` with Docker → expect `PASSED`.
- [ ] Run `UPGRADELAB_TEST_DOCKER=1 pnpm test:docker` on Linux, macOS and Windows runners.
- [ ] Run the live PostgreSQL contract with `UPGRADELAB_TEST_POSTGRES_URL`.
- [ ] Execute the GitHub Action on a pull request, including a failing scenario and artifact upload.

## Release

- [ ] Add repository URL, maintainer contacts and security reporting link to package metadata.
- [ ] Review the dependency lockfile and enable Dependabot.
- [ ] Add a Docker-enabled CI matrix and a scheduled action self-test.
- [ ] Generate changesets for the initial release and bump versions from `1.0.0-dev.0`.
- [ ] Publish `@upgradelab/*` packages and the CLI.
- [ ] Build and host the VitePress documentation.
- [ ] Tag a signed `v1.0.0` release.

## Features

- [ ] MySQL database adapter plugin with equivalent read-only enforcement.
- [ ] Kubernetes environment provider plugin.
- [ ] Per-hop invariant checks (currently invariants are evaluated after the target).
- [ ] Parallel scenario execution with isolated run directories.
- [ ] Evidence download for large logs (currently inline with truncation).
- [ ] Additional report formats (SARIF, HTML) as plugins.

## Hardening

- [ ] Fuzz the SQL guard and compose security analyzer.
- [ ] Test report redaction against a corpus of secret formats.
- [ ] Add property-based tests for verdict aggregation.
- [ ] Benchmark startup and verification overhead.
