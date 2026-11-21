# Threat model

UpgradeLab executes user-supplied containers and, optionally, user-supplied plugins on CI runners. This
document describes the assets, trust boundaries, threats and mitigations. It is a design document, not a
claim that the system is risk-free.

## Assets

- **User data under test** (seeded fixtures and databases).
- **Secrets** in environment variables: database passwords, AI API keys, registry credentials of the host.
- **The host/CI runner** and its Docker daemon, other containers, volumes and networks.
- **Reports and evidence** that may be attached to issues or artifacts.
- **Integrity of the verdict**, which must not be influenced by AI or by a failed container start.

## Trust boundaries

| Boundary                                | Trusted?               | Notes                                                                                    |
| --------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| UpgradeLab source and official packages | Yes                    | Reviewed, Apache-2.0, built from this repository.                                        |
| User configuration file                 | Semi-trusted           | Validated strictly; can request non-loopback ports or plugins only with explicit opt-in. |
| Docker images under test                | **Untrusted**          | They are the software being tested; they are isolated, but they can still misbehave.     |
| Plugins                                 | **Untrusted code**     | Plugins run in-process with full privileges. Loading is an explicit operator decision.   |
| AI provider response                    | **Untrusted**          | Treated as text; never parsed into commands, queries or verdicts.                        |
| Docker daemon                           | Trusted infrastructure | UpgradeLab never mounts its socket into test containers.                                 |
| CI runner filesystem                    | Trusted infrastructure | Reports are written to the configured output directory.                                  |

## Threats and mitigations

### T1 — Container escape / host compromise

**Threat:** a malicious or compromised image uses privileged mode, host namespaces, added capabilities,
host devices or a mounted Docker socket to control the host.

**Mitigations:** compose configurations are analyzed before start and rejected when they request
`privileged`, `network_mode: host`, `pid/ipc/uts: host`, `cap_add`, `devices`, `seccomp=unconfined` or any
`/var/run/docker.sock` mount. The generated file explicitly sets `privileged: false` and
`no-new-privileges:true`. Images still run as containers, so container-escape vulnerabilities in the kernel
or runtime remain the responsibility of Docker and the host.

### T2 — Damage to unrelated Docker resources

**Threat:** cleanup removes a user's volumes, networks or containers that happen to share a name.

**Mitigations:** every run uses a generated `upgradelab-*` project name. Cleanup only proceeds after listing
containers filtered by the Compose project label and verifying every container's `upgradelab.managed` and
`upgradelab.run-id` labels. Volumes and networks are inspected individually before removal. A failed
ownership check aborts cleanup and reports it; UpgradeLab never falls back to `docker system prune`.

### T3 — Secret leakage into logs, evidence or reports

**Threat:** a database password or API token appears in container logs, command output, error messages or an
AI prompt, and ends up in a public CI artifact.

**Mitigations:** environment references used as secrets are recorded and redacted literally; the redactor
also handles connection strings, bearer/basic headers, common token formats, JWTs, key/value assignments and
sensitive JSON keys. Reports are redacted once before any reporter runs, including plugin reporters. AI
prompts are redacted before the HTTP request. Redaction is best-effort: logs can contain arbitrary data, and
the documentation tells users to review artifacts before sharing them.

### T4 — Command injection via configuration

**Threat:** a project name, image, assertion parameter or environment value is interpolated into a shell
string and executes arbitrary commands on the runner.

**Mitigations:** all process execution uses argument arrays (Execa); no `shell: true` and no string
concatenation of commands. Compose values are passed as structured JSON/config, and interpolation of `${…}`
in generated Compose files is escaped. The SQL guard is not a shell boundary, but it prevents mutating SQL
from running.

### T5 — Read-only SQL is not actually read-only

**Threat:** an invariant or SQL assertion modifies data, hides a migration bug or escalates privileges.

**Mitigations:** only a single statement with a read-only leading keyword is accepted; comments, strings and
quoted identifiers are stripped before analysis; dangerous functions and `SELECT INTO`, `FOR UPDATE`, `SET`,
and transaction control are rejected. The connection sets `default_transaction_read_only=on` and executes
inside `BEGIN TRANSACTION READ ONLY` with a statement timeout. PostgreSQL enforces the final guarantee.

### T6 — False confidence from a passing run

**Threat:** a run reports `PASSED` although nothing meaningful was verified, for example because a container
started or all checks were skipped.

**Mitigations:** verdicts are computed only from check results. No required checks ⇒ `INCONCLUSIVE`; a
required check that was skipped or errored ⇒ `INCONCLUSIVE`; a container start alone never creates a
`PASSED` verdict. The documentation repeats this rule.

### T7 — AI manipulating the verdict

**Threat:** a prompt-injected log line or a malicious AI response changes the result or causes code
execution.

**Mitigations:** AI output is parsed as data, validated with a zod schema, rendered as text and stored as an
advisory. It has no path to check statuses or exit codes. AI is disabled by default and requires both
configuration and a CLI flag. Provider responses are never executed as commands or SQL.

### T8 — Malicious plugin code

**Threat:** a plugin exfiltrates secrets, modifies reports or runs arbitrary commands.

**Mitigations:** plugins are only loaded from explicit paths (CLI `--plugin`, or config references when
`security.allowConfigPlugins` is enabled). TypeScript plugin files must be compiled; paths outside the
project require `allowOutsideProjectRoot`. Built-in assertions and report formats cannot be overridden.
A plugin still executes in-process with the runner's privileges; treat plugin installation as a code
review and supply-chain decision.

### T9 — Denial of service against the runner

**Threat:** a scenario hangs, a migration loops, or a container consumes all memory/CPU.

**Mitigations:** per-check, per-command, per-scenario and cleanup timeouts; Compose memory, CPU and PID
limits; readiness timeouts; cancellation signals propagated to commands and cleanup. A determined malicious
image can still exhaust host resources within its limits; run untrusted scenarios on dedicated runners.

### T10 — Supply-chain compromise of dependencies

**Threat:** a compromised npm package or base image executes code in CI.

**Mitigations:** pinned dependency versions and a single lockfile; a minimal dependency set (`zod`,
`commander`, `pino`, `execa`, `pg`, `yaml`); no postinstall scripts in UpgradeLab itself; the GitHub Action
is bundled and committed. Dependency updates should be reviewed and tested like code changes.

## Residual risks

- Docker daemon compromise is out of scope: a host that lets untrusted users talk to Docker is already
  compromised.
- Redaction cannot recognise every secret format.
- Plugins and images are code; sandboxing them is not attempted.
- AI providers receive redacted prompts and may retain them according to their own policies; users choose
  the provider and model.
