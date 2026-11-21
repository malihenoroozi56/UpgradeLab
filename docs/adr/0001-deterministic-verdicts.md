# ADR 0001 — Verdicts are deterministic and check-driven

**Status:** Accepted

## Context

An upgrade tool is only useful if its result is trustworthy. Container health checks and "the process
started" signals are weak evidence: a migration can start a healthy application on top of corrupted data.
AI-generated judgements would add non-determinism and make failures hard to audit.

## Decision

A scenario verdict is computed by a pure function from check results only:

- cancellation ⇒ `CANCELLED`;
- any required `FAILED` ⇒ `FAILED`;
- an orchestration error with no failed required check ⇒ `INCONCLUSIVE`;
- zero required checks, or a required check that is `SKIPPED`/`ERROR` ⇒ `INCONCLUSIVE`;
- otherwise `PASSED`.

Run-level aggregation fails a run if any scenario failed or if cancelled and non-cancelled scenarios are
mixed. AI output is stored separately as an advisory and is never read by the aggregation function.

## Consequences

- A started container cannot produce a pass by itself.
- Users must configure meaningful checks to get `PASSED`; the tool refuses to guess.
- Verdict logic is easy to unit test and reason about.
- AI failures cannot flip a verdict.
