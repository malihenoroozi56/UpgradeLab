# Hardening Compose files

UpgradeLab analyzes the resolved Compose configuration before starting anything. This page lists what is
rejected, what is rewritten, and what you must do instead.

## Rejected outright

| Setting                                                   | Why                                    |
| --------------------------------------------------------- | -------------------------------------- |
| `privileged: true`                                        | Full host device access.               |
| `network_mode: host`                                      | Removes network isolation.             |
| `pid`, `ipc`, `uts: host`                                 | Shares host namespaces.                |
| `cap_add`                                                 | Grants kernel capabilities.            |
| `devices`                                                 | Exposes host devices.                  |
| `security_opt: seccomp=unconfined`, `apparmor=unconfined` | Disables confinement.                  |
| `/var/run/docker.sock` or `/run/docker.sock` mount        | Container can control the host daemon. |
| Bind mount outside the project / allowed roots            | Reads or writes arbitrary host files.  |
| Build context outside the project                         | Builds arbitrary host content.         |
| Secret/config `file` outside allowed roots                | Reads host files.                      |
| Published port without a loopback `host_ip`               | Exposes the service to the network.    |

Sensitive host paths (`/proc`, `/sys`, `/etc`, `/root`, `/home`, `/var/lib/docker`, SSH directories) are
rejected even if they are inside an allowed root.

## Rewritten automatically

The generated Compose file:

- removes `container_name` (prevents collisions);
- removes build contexts when an image override is provided;
- sets `privileged: false` and `security_opt: no-new-privileges:true`;
- applies memory, CPU and PID limits;
- publishes required ports on the configured loopback address with ephemeral host ports;
- adds `upgradelab.managed`, `upgradelab.run-id` and `upgradelab.scenario-id` labels;
- optionally marks networks `internal: true`.

Publish ports like this when you need explicit control:

```yaml
ports:
  - target: 5432
    host_ip: 127.0.0.1
    protocol: tcp
```

Do not hard-code a host port; UpgradeLab allocates one and resolves it with `docker compose port`.

## Recommended development Compose file

```yaml
services:
  app:
    image: my-app:1.0.0
    environment:
      PGHOST: db
    depends_on:
      db:
        condition: service_healthy
    expose:
      - '3000'

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: upgradelab
      POSTGRES_PASSWORD: ${UPGRADELAB_DB_PASSWORD:-upgradelab}
      POSTGRES_DB: upgradelab
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U upgradelab -d upgradelab']
      interval: 2s
      timeout: 3s
      retries: 30
    expose:
      - '5432'
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

No host ports, no privileged mode, no socket mount. The database starts on the first `up` because of
`depends_on`, and is preserved across upgrade hops.

## Cleanup ownership

Cleanup lists containers by Compose project label and inspects each container's `upgradelab.managed` and
`upgradelab.run-id` labels. Volumes and networks are inspected individually. Anything unlabelled or labelled
with another run is left in place and reported as a warning.

## Network egress

If your upgrade must not reach the internet, set:

```yaml
environment:
  network:
    internal: true
```

All generated networks become `internal: true`. Images must already be present locally; pulls will fail.

## Secrets

Use environment references rather than literal values:

```yaml
environment:
  database:
    password: ${UPGRADELAB_DB_PASSWORD}
```

Values are redacted from logs and reports, but the Compose file itself still receives the value. Keep it out
of committed files and CI logs.
