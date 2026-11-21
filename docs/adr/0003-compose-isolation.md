# ADR 0003 — One generated, hardened Compose project per run

**Status:** Accepted

## Context

Tests must not interfere with a developer's existing Docker resources or expose databases on the network.
The user's Compose file may contain unsafe options that are acceptable locally but unacceptable in CI.

## Decision

For each scenario, the provider resolves the user file with `docker compose config --format json`, analyzes
it for unsafe options, then writes a run-owned generated file with:

- a `upgradelab-*` project name and `upgradelab.run-id` labels;
- loopback-published ports with ephemeral host ports;
- memory/CPU/PID limits and `no-new-privileges`;
- removed `container_name`, build contexts, privileged mode and host namespaces.

Cleanup only removes resources whose labels match the run id.

## Consequences

- Concurrent runs do not collide.
- Unsafe Compose files are rejected with an actionable error.
- The generated file is evidence and is written into the run directory.
- The provider depends on Compose ≥ 2.20 for JSON config output.
