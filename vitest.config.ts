import path from 'node:path';
import { defineConfig } from 'vitest/config';

const here = import.meta.dirname;
const alias = (relative: string): string => path.resolve(here, relative);

export default defineConfig({
  resolve: {
    alias: {
      '@upgradelab/contracts': alias('packages/contracts/src/index.ts'),
      '@upgradelab/config': alias('packages/config/src/index.ts'),
      '@upgradelab/core': alias('packages/core/src/index.ts'),
      '@upgradelab/assertion-engine': alias('packages/assertion-engine/src/index.ts'),
      '@upgradelab/database-postgres': alias('packages/database-postgres/src/index.ts'),
      '@upgradelab/docker-compose-provider': alias('packages/docker-compose-provider/src/index.ts'),
      '@upgradelab/reporters': alias('packages/reporters/src/index.ts'),
      '@upgradelab/plugin-sdk': alias('packages/plugin-sdk/src/index.ts'),
      '@upgradelab/ai-assistant': alias('packages/ai-assistant/src/index.ts'),
      '@upgradelab/plugin-example-csv-reporter': alias(
        'examples/plugins/csv-reporter/src/index.ts',
      ),
      '@upgradelab/cli': alias('apps/cli/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
    pool: 'threads',
  },
});
