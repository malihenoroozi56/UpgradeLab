# ADR 0002 — Strict, versioned configuration

**Status:** Accepted

## Context

Configuration typos silently weaken verification: `assertions` misspelled as `assertion` would leave a run
with no checks. Unversioned formats make later migrations guesswork.

## Decision

`upgradelab.yaml` is a Zod strict object with `schemaVersion: 1`. Unknown keys are rejected with the exact
path. `from`/`to` and `path` are mutually exclusive; duplicate scenario/check ids are rejected; SQL
invariants require a configured database; non-loopback bind addresses require explicit consent.

Environment references (`${VAR}`, `${VAR:-default}`, `$${` escaping) are resolved during parsing and their
values are recorded as secrets for redaction.

## Consequences

- Typos fail before any container starts.
- Adding a field requires updating the schema and documentation.
- A breaking format change requires a new `schemaVersion`, an ADR and a migration note.
