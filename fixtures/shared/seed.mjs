#!/usr/bin/env node
/**
 * Seeds the demo database with a small, deterministic data set.
 *
 * Safe to run more than once: existing rows are left untouched so the setup
 * command can be replayed without changing the baseline.
 */
import { execFileSync } from 'node:child_process';

const pgEnv = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? 'db',
  PGPORT: process.env.PGPORT ?? '5432',
  PGUSER: process.env.PGUSER ?? 'upgradelab',
  PGPASSWORD: process.env.PGPASSWORD ?? 'upgradelab',
  PGDATABASE: process.env.PGDATABASE ?? 'upgradelab',
};

const sql = `
BEGIN;
INSERT INTO users (id, email, name) VALUES
  (1, 'ada@example.test', 'Ada'),
  (2, 'grace@example.test', 'Grace'),
  (3, 'linus@example.test', 'Linus')
ON CONFLICT (id) DO NOTHING;

INSERT INTO accounts (id, user_id, balance) VALUES
  (1, 1, 1000.00),
  (2, 2, 1000.00),
  (3, 3, 1000.00)
ON CONFLICT (id) DO NOTHING;

SELECT setval('users_id_seq', (SELECT MAX(id) FROM users));
SELECT setval('accounts_id_seq', (SELECT MAX(id) FROM accounts));
COMMIT;
`;

execFileSync('psql', ['-v', 'ON_ERROR_STOP=1'], {
  env: pgEnv,
  input: sql,
  stdio: ['pipe', 'inherit', 'inherit'],
});
console.log('seeded 3 users and 3 accounts');
