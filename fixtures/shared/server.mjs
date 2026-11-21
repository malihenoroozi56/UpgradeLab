#!/usr/bin/env node
/**
 * Minimal demo application used by the UpgradeLab end-to-end fixtures.
 *
 * It deliberately has no npm dependencies: PostgreSQL access goes through the
 * `psql` client installed in the image. That keeps the fixture buildable
 * offline and makes the migration behaviour easy to audit.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const APP_VERSION = process.env.APP_VERSION ?? 'unknown';
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? '/app/migrations';
const AUTO_MIGRATE = (process.env.AUTO_MIGRATE ?? 'true') !== 'false';
const PORT = Number(process.env.PORT ?? 3000);

const pgEnv = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? 'db',
  PGPORT: process.env.PGPORT ?? '5432',
  PGUSER: process.env.PGUSER ?? 'upgradelab',
  PGPASSWORD: process.env.PGPASSWORD ?? 'upgradelab',
  PGDATABASE: process.env.PGDATABASE ?? 'upgradelab',
};

function psql(args, input) {
  return execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', ...args], {
    env: pgEnv,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function queryJson(sql) {
  const output = psql(['-tAc', sql]).trim();
  return output.length === 0 ? null : JSON.parse(output);
}

function waitForDatabase(attempts = 30) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      psql(['-tAc', 'SELECT 1']);
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    }
  }
}

function applyMigrations() {
  psql(
    [],
    'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());',
  );
  const applied = new Set(
    (psql(['-tAc', 'SELECT version FROM schema_migrations']).trim().split('\n') ?? []).filter(
      Boolean,
    ),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Migrations and their bookkeeping commit together, so a failed migration
    // is never recorded as applied.
    psql(
      [],
      `BEGIN;\n${sql}\nINSERT INTO schema_migrations (version) VALUES ('${file.replaceAll("'", "''")}');\nCOMMIT;`,
    );
    console.log(`applied migration ${file}`);
  }
}

function stats() {
  return queryJson(`
    SELECT json_build_object(
      'version', '${APP_VERSION}',
      'users', (SELECT COUNT(*) FROM users),
      'accounts', (SELECT COUNT(*) FROM accounts),
      'totalBalance', (SELECT COALESCE(SUM(balance), 0) FROM accounts)
    )
  `);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', version: APP_VERSION }));
      return;
    }
    if (url.pathname === '/stats') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(stats()));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

waitForDatabase();
if (AUTO_MIGRATE) {
  applyMigrations();
}
server.listen(PORT, '0.0.0.0', () => {
  console.log(`application ${APP_VERSION} listening on ${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
