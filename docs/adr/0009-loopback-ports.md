# ADR 0009 — Loopback-only published ports

**Status:** Accepted

## Context

Publishing a test database on `0.0.0.0` exposes seeded data and weak credentials to the local network and
CI network. Fixed host ports also collide between concurrent runs.

## Decision

The provider publishes required application and database ports on `127.0.0.1` using ephemeral host ports
allocated at runtime. Non-loopback binding requires `security.allowNonLoopbackPorts: true`, and the
configuration rejects `0.0.0.0` without that flag.

## Consequences

- Test services are reachable only from the host running UpgradeLab.
- Concurrent runs do not fight over host ports.
- Remote debugging requires an explicit, documented opt-in or an SSH tunnel.
