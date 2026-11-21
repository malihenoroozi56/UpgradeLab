# ADR 0010 — ESLint is type-unaware; TypeScript is authoritative

**Status:** Accepted

## Context

Type-aware ESLint rules require a program that includes every linted file. Test fixtures, generated bundle
scripts and test helpers caused parser-project churn and slow feedback. `tsc -b` already type-checks every
package, app and test file through project references.

## Decision

Use the flat ESLint config with syntactic and correctness rules only (no `parserOptions.project`).
`pnpm typecheck` (`tsc -b --force`) is the authoritative type check and runs in CI before lint.

## Consequences

- Lint is fast and does not fail on files outside a tsconfig project.
- Type-aware rules are not enforced by ESLint; `tsc` and review cover type safety.
- New files must be added to the relevant tsconfig project to be type-checked.
