# ADR 0004 — Read-only SQL enforced by the database

**Status:** Accepted

## Context

Verification queries must never mutate data or disguise a migration bug. Text scanning alone is
insufficient: PostgreSQL has many ways to write data (CTEs, functions, `SELECT INTO`).

## Decision

Two independent layers:

1. A static guard accepts a single statement with a read-only leading keyword, rejects mutating keywords,
   `FOR UPDATE`, `SET`, transaction control and dangerous functions, and strips comments and literals before
   analysis.
2. The PostgreSQL adapter executes inside `BEGIN TRANSACTION READ ONLY` with
   `default_transaction_read_only=on`, a statement timeout and an idle-in-transaction timeout.

The database is the final authority.

## Consequences

- SQL assertions and invariants cannot modify the database.
- Unsupported statements (for example multi-statement scripts) are rejected early.
- Other databases must implement equivalent enforcement in their adapter.
