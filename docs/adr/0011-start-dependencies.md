# ADR 0011 — Dependencies start on the first `up`, not on upgrades

**Status:** Accepted

## Context

The provider originally used `docker compose up --no-deps` for every service start. That prevented the
database from starting at all, and readiness of the application could fail on a fresh environment. Starting
dependencies again on each hop would recreate the database and destroy the data under test.

## Decision

- The source start (`startService`) runs `docker compose up -d --force-recreate … <service>` without
  `--no-deps`, so `depends_on` services (typically the database) start and honour their health conditions.
- Hops (`replaceService`) use `--no-deps` so only the application container is recreated and the database
  is never touched during the upgrade.

## Consequences

- A fresh environment works with a standard `depends_on` database.
- Database data persists across hops by construction.
- Services other than the app are not upgraded between hops; multi-service upgrades need explicit support
  later.
