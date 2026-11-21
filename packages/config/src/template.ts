export interface InitTemplateOptions {
  readonly projectName?: string;
  readonly composeFile?: string;
  readonly appService?: string;
  readonly databaseService?: string;
  readonly fromImage?: string;
  readonly toImage?: string;
}

/**
 * Starting configuration written by `upgradelab init`.
 *
 * It is deliberately small and heavily commented: every field is documented,
 * and the defaults come from `DEFAULTS` in @upgradelab/contracts.
 */
export function renderInitConfig(options: InitTemplateOptions = {}): string {
  const projectName = options.projectName ?? 'my-app';
  const composeFile = options.composeFile ?? './docker-compose.yml';
  const appService = options.appService ?? 'app';
  const databaseService = options.databaseService ?? 'db';
  const fromImage = options.fromImage ?? 'example/app:1.0.0';
  const toImage = options.toImage ?? 'example/app:2.0.0';

  return `# UpgradeLab configuration — schemaVersion 1
# Documentation: https://github.com/upgradelab/upgradelab/blob/main/docs/configuration/reference.md
schemaVersion: 1

project:
  name: ${projectName}

environment:
  provider: docker-compose
  composeFile: ${composeFile}
  application:
    service: ${appService}
    # Container port used for HTTP assertions and the default healthcheck.
    port: 3000
    healthcheck:
      type: http
      path: /health
      timeoutMs: 5000
  database:
    service: ${databaseService}
    adapter: postgres
    # Credentials are only used inside the isolated test network.
    # Prefer environment references for real secrets: \${UPGRADELAB_DB_PASSWORD}
    database: upgradelab
    user: upgradelab
    password: upgradelab
  # Test ports are published on loopback only.
  network:
    bindAddress: 127.0.0.1
  resources:
    memoryLimit: 1g
    cpus: 1
    pidsLimit: 512

security:
  # Plugins execute code in this process; keep this false and pass --plugin explicitly.
  allowConfigPlugins: false

defaults:
  scenarioTimeoutMs: 600000
  assertionTimeoutMs: 15000
  logTailLines: 500

scenarios:
  - id: upgrade-1-to-2
    description: Upgrade ${fromImage} to ${toImage} and prove that data survives.

    from:
      image: ${fromImage}
      # Seeding runs after the source release is ready and before the baseline
      # snapshot, so every invariant is measured against real data.
      setup:
        - target: ${appService}
          command:
            - node
            - scripts/seed-test-data.js

    to:
      image: ${toImage}

    invariants:
      - id: users-preserved
        type: sql
        query: SELECT COUNT(*) FROM users
        comparison: equal-before-after

      - id: database-available
        type: sql
        query: SELECT 1
        comparison: equal
        expected: 1

    assertions:
      - id: application-healthy
        type: http
        path: /health
        expectedStatus: 200
`;
}
