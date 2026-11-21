# Decisions

Architectural decisions are recorded as ADRs in [`docs/adr/`](../adr/). This page lists them with their
current status.

| ADR                                           | Decision                                                                        | Status   |
| --------------------------------------------- | ------------------------------------------------------------------------------- | -------- |
| [0001](../adr/0001-deterministic-verdicts.md) | Verdicts are computed only from check results; AI is advisory.                  | Accepted |
| [0002](../adr/0002-versioned-config.md)       | Strict, versioned YAML configuration with unknown-key rejection.                | Accepted |
| [0003](../adr/0003-compose-isolation.md)      | One generated, hardened Compose project per scenario run.                       | Accepted |
| [0004](../adr/0004-read-only-sql.md)          | SQL is validated statically and enforced by a PostgreSQL read-only transaction. | Accepted |
| [0005](../adr/0005-optional-ai.md)            | AI is opt-in, provider-independent, redacted and never authoritative.           | Accepted |
| [0006](../adr/0006-plugin-security.md)        | Plugins load only from explicit paths with a versioned API.                     | Accepted |
| [0007](../adr/0007-report-schema.md)          | Reports are versioned JSON documents rendered after one redaction pass.         | Accepted |
| [0008](../adr/0008-node-baseline.md)          | Node.js ≥ 22.12 is the supported baseline.                                      | Accepted |
| [0009](../adr/0009-loopback-ports.md)         | Published ports bind to loopback with ephemeral host ports.                     | Accepted |
| [0010](../adr/0010-lint-strategy.md)          | ESLint is type-unaware; `tsc -b` is the type authority.                         | Accepted |
| [0011](../adr/0011-start-dependencies.md)     | The first `up` starts dependencies; later hops use `--no-deps`.                 | Accepted |

## Rejected alternatives

- **Simulate upgrades in a mock database.** Rejected: migrations and image behaviour are exactly what must
  be verified.
- **Mount the Docker socket to simplify orchestration.** Rejected: it grants host control to tested code.
- **Let AI judge the result.** Rejected: non-deterministic, unauditable, unsafe.
- **Publish to host ports for convenience.** Rejected as a default: it exposes test databases on the network.
- **Allow config-file plugins by default.** Rejected: cloning a repository would execute arbitrary code.
- **Use a shell for command assertions.** Rejected: command injection through configuration values.
- **Treat a started container as a pass.** Rejected: the core failure mode this project exists to prevent.
