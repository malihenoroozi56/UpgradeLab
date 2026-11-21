# Architecture decisions

Each decision is recorded with its context, the choice and the consequences. Changing a decision requires
a new ADR that supersedes the old one.

| ADR                                    | Decision                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| [0001](0001-deterministic-verdicts.md) | Verdicts are deterministic and check-driven; AI is advisory.                  |
| [0002](0002-versioned-config.md)       | Strict, versioned YAML with unknown-key rejection.                            |
| [0003](0003-compose-isolation.md)      | One generated, hardened Compose project per run.                              |
| [0004](0004-read-only-sql.md)          | SQL is enforced by PostgreSQL read-only transactions, not just text scanning. |
| [0005](0005-optional-ai.md)            | AI is opt-in, redacted, provider-independent and never authoritative.         |
| [0006](0006-plugin-security.md)        | Plugins load only from explicit paths with a versioned API.                   |
| [0007](0007-report-schema.md)          | Reports are versioned and rendered after a single redaction pass.             |
| [0008](0008-node-baseline.md)          | Node.js ≥ 22.12 is the supported baseline.                                    |
| [0009](0009-loopback-ports.md)         | Published ports bind to loopback with ephemeral host ports.                   |
| [0010](0010-lint-strategy.md)          | ESLint is type-unaware; `tsc -b` is authoritative.                            |
| [0011](0011-start-dependencies.md)     | Dependencies start on the first `up`; hops use `--no-deps`.                   |

Planning documents live in the repository:
[roadmap](https://github.com/upgradelab/upgradelab/blob/main/docs/plan/ROADMAP.md),
[implementation status](https://github.com/upgradelab/upgradelab/blob/main/docs/plan/IMPLEMENTATION_STATUS.md),
[tasks](https://github.com/upgradelab/upgradelab/blob/main/docs/plan/TASKS.md) and
[decisions index](https://github.com/upgradelab/upgradelab/blob/main/docs/plan/DECISIONS.md).
