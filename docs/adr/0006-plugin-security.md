# ADR 0006 — Explicit, versioned plugin loading

**Status:** Accepted

## Context

Plugins extend coverage but execute with the runner's privileges. Automatic discovery or loading plugins
from a cloned repository would turn `git clone && upgradelab run` into arbitrary code execution.

## Decision

- Plugins are ES modules loaded only from explicit paths (`--plugin`) or config entries when
  `security.allowConfigPlugins: true`.
- Paths must be `.js`/`.mjs` and inside the project root unless explicitly allowed.
- `apiVersion` must equal the implemented plugin API version.
- Registration is scoped per plugin; built-in assertion types and report formats cannot be overridden.
- Plugins are never downloaded or resolved from remote configuration.

## Consequences

- Plugin loading is an auditable, operator-controlled decision.
- Compiled output is required; TypeScript plugins must be built first.
- A malicious plugin remains a supply-chain risk that users must review.
