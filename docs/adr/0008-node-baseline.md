# ADR 0008 — Node.js 22.12 baseline

**Status:** Accepted

## Context

The project needs modern Node APIs (`AbortSignal.any`, `AbortSignal.timeout`, built-in fetch) and current
tooling. The original brief suggested Node 26 LTS; at implementation time the toolchain (Vitest 5.1.1)
supports `^22.12 || ^24 || >=26`, while the development host runs Node 22.15.

## Decision

Set `engines.node >= 22.12.0` and use Node 22-compatible APIs. CI tests the current LTS lines; future
LTS versions are supported when their dependencies allow it.

## Consequences

- The project runs on the host used to build it.
- No hard dependency on a not-yet-released LTS.
- Raising the baseline is a minor/major release decision with an ADR update.
