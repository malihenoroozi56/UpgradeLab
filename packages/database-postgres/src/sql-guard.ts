import { UpgradeLabError } from '@upgradelab/contracts';

const ALLOWED_LEADING_KEYWORDS = new Set(['select', 'with', 'show', 'explain', 'values', 'table']);

const FORBIDDEN_PATTERNS: { readonly pattern: RegExp; readonly reason: string }[] = [
  {
    pattern: /\bpg_terminate_backend\b/,
    reason: 'terminating database sessions is not a read-only check',
  },
  {
    pattern: /\bpg_cancel_backend\b/,
    reason: 'cancelling database sessions is not a read-only check',
  },
  {
    pattern: /\bpg_reload_conf\b/,
    reason: 'reloading server configuration is not a read-only check',
  },
  { pattern: /\bpg_read_(?:binary_)?file\b/, reason: 'reading server files is not permitted' },
  { pattern: /\bpg_ls_dir\b/, reason: 'listing server directories is not permitted' },
  { pattern: /\blo_(?:import|export)\b/, reason: 'large object file I/O is not permitted' },
  { pattern: /\bdblink\b/, reason: 'cross-database connections are not permitted' },
  { pattern: /\bset_config\s*\(/, reason: 'changing session settings is not permitted' },
  {
    pattern: /\bset\s+(?:role|session|local)\b/,
    reason: 'changing session settings is not permitted',
  },
  {
    pattern: /\breset\s+(?:all|role|session)\b/,
    reason: 'changing session settings is not permitted',
  },
  {
    pattern: /\bfor\s+(?:update|share)\b/,
    reason: 'row locks are not permitted in read-only verification',
  },
  {
    pattern: /\binto\s+(?:out|temp|temporary|unlogged|table)?\b/,
    reason: 'SELECT INTO writes data',
  },
  {
    pattern: /\b(?:insert|update|delete|merge|truncate)\b/,
    reason: 'data modification is not permitted',
  },
  {
    pattern: /\b(?:create|alter|drop|grant|revoke|comment|vacuum|analyse|analyze)\b/,
    reason: 'DDL and maintenance statements are not permitted',
  },
  {
    pattern: /\bcommit\b|\brollback\b|\bbegin\b/,
    reason: 'transaction control statements are not permitted',
  },
];

/**
 * Replaces comments, string literals and quoted identifiers with spaces so the
 * validator cannot be bypassed by hiding keywords inside literals.
 */
export function stripSqlNoise(sql: string): string {
  let output = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      output += ' ';
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      output += ' ';
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') {
        index += 1;
      }
      output += ' ';
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      output += ' ';
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function unsafeQuery(
  message: string,
  details: Record<string, unknown>,
  hint: string,
): UpgradeLabError {
  return new UpgradeLabError(message, {
    code: 'ASSERTION_UNSAFE_QUERY',
    details,
    hint,
  });
}

/**
 * Validates that a query is a single, read-only statement.
 *
 * This is defence in depth: the adapter still executes every statement inside a
 * `READ ONLY` transaction, which is the authoritative database-level control.
 */
export function validateReadOnlySql(query: string): string {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw unsafeQuery(
      'SQL verification query is empty.',
      {},
      'Provide a single read-only statement.',
    );
  }
  if (/\$[A-Za-z_]*\$/.test(query)) {
    throw unsafeQuery(
      'Dollar-quoted SQL is not supported in verification queries.',
      {},
      'Use standard single-quoted string literals.',
    );
  }
  const normalized = stripSqlNoise(query).trim();
  if (normalized.length === 0) {
    throw unsafeQuery(
      'SQL verification query contains no statement.',
      {},
      'Provide a SELECT statement.',
    );
  }
  const statements = normalized
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  if (statements.length === 0) {
    throw unsafeQuery(
      'SQL verification query contains no statement.',
      {},
      'Provide a SELECT statement.',
    );
  }
  if (statements.length > 1) {
    throw unsafeQuery(
      'SQL verification queries must contain exactly one statement.',
      { statements: statements.length },
      'Split multiple checks into separate assertions or invariants.',
    );
  }
  const statement = statements[0] ?? '';
  const leading = statement.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!ALLOWED_LEADING_KEYWORDS.has(leading)) {
    throw unsafeQuery(
      `SQL verification queries must start with one of: ${[...ALLOWED_LEADING_KEYWORDS].join(', ')}.`,
      { leadingKeyword: leading },
      'Only read-only statements are accepted.',
    );
  }
  const lowercase = statement.toLowerCase();
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(lowercase)) {
      throw unsafeQuery(
        `SQL verification query is not allowed: ${rule.reason}.`,
        { pattern: rule.pattern.source },
        'Verification queries must be read-only and side-effect free.',
      );
    }
  }
  return query
    .trim()
    .replace(/;+\s*$/, '')
    .trim();
}
