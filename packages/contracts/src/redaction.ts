/**
 * Secret redaction.
 *
 * Every log line, evidence blob, report field and AI prompt passes through this
 * module before leaving the process. Redaction is intentionally conservative:
 * a false positive only costs readability, while a false negative leaks a
 * credential into CI artifacts.
 */

export const REDACTED = '[REDACTED]';

export interface RedactorOptions {
  /** Literal secret values (for example resolved environment variables). */
  readonly secrets?: readonly string[];
  /** Extra patterns supplied by callers or plugins. */
  readonly patterns?: readonly RegExp[];
  readonly replacement?: string;
}

export interface Redactor {
  /** Redacts secrets from a single string. */
  redact(text: string): string;
  /** Recursively redacts strings inside arbitrary JSON-like values. */
  redactDeep<T>(value: T): T;
  /** Number of redaction operations performed so far. */
  readonly redactionCount: number;
}

const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|authorization|cookie/i;

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: (match: string, ...groups: string[]) => string;
}

function buildRules(marker: string): readonly RedactionRule[] {
  const replaceAll = (): string => marker;
  return [
    // PEM private keys
    {
      pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      replacement: replaceAll,
    },
    // Credentials embedded in connection strings (postgres://user:pass@host)
    {
      pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi,
      replacement: (_match, scheme = '') => `${scheme}${marker}:${marker}@`,
    },
    // Authorization headers
    {
      pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
      replacement: (_match, scheme = '') => `${scheme} ${marker}`,
    },
    // Well-known provider token shapes
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: replaceAll },
    { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: replaceAll },
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: replaceAll },
    { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: replaceAll },
    { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: replaceAll },
    { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: replaceAll },
    // JSON Web Tokens
    {
      pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      replacement: replaceAll,
    },
    // JSON-style "key": "value" pairs for sensitive keys
    {
      pattern:
        /("(?:[^"\\]|\\.)*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)(?:[^"\\]|\\.)*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
      replacement: (_match, prefix = '') => `${prefix}"${marker}"`,
    },
    // key=value / key: value assignments for sensitive keys
    {
      pattern:
        /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'}\]]+)/gi,
      replacement: (_match, key = '', separator = '') => `${key}${separator}${marker}`,
    },
    // Sensitive query-string parameters
    {
      pattern:
        /([?&](?:token|key|api[_-]?key|password|secret|access[_-]?token|signature)=)[^&\s"']+/gi,
      replacement: (_match, prefix = '') => `${prefix}${marker}`,
    },
  ];
}

function applyRules(
  text: string,
  rules: readonly RedactionRule[],
  secrets: readonly string[],
  marker: string,
): string {
  let result = text;
  for (const secret of secrets) {
    result = result.split(secret).join(marker);
  }
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, (...args: unknown[]) => {
      const match = String(args[0] ?? '');
      const groups = args.slice(1, -2).map((group) => (typeof group === 'string' ? group : ''));
      return rule.replacement(match, ...groups);
    });
    rule.pattern.lastIndex = 0;
  }
  return result;
}

/**
 * Creates a redactor. Literal secrets are replaced first, then structural
 * patterns. Secrets shorter than 4 characters are ignored to avoid destroying
 * unrelated output; rotate such values instead of relying on redaction.
 */
export function createRedactor(options: RedactorOptions = {}): Redactor {
  const marker = options.replacement ?? REDACTED;
  const rules = buildRules(marker);
  const literalSecrets = (options.secrets ?? [])
    .filter((secret) => typeof secret === 'string' && secret.length >= 4)
    .sort((a, b) => b.length - a.length);
  const extraRules = (options.patterns ?? []).map<RedactionRule>((pattern) => ({
    pattern,
    replacement: () => marker,
  }));
  const allRules = [...rules, ...extraRules];
  let redactionCount = 0;

  const redact = (text: string): string => {
    if (text.length === 0) {
      return text;
    }
    const redacted = applyRules(text, allRules, literalSecrets, marker);
    if (redacted !== text) {
      redactionCount += 1;
    }
    return redacted;
  };

  const redactDeep = <T>(value: T): T => {
    const seen = new WeakSet<object>();

    const walk = (input: unknown, keyHint?: string): unknown => {
      if (typeof input === 'string') {
        if (keyHint && SENSITIVE_KEY.test(keyHint) && input.length > 0) {
          redactionCount += 1;
          return marker;
        }
        return redact(input);
      }
      if (Array.isArray(input)) {
        return input.map((item) => walk(item));
      }
      if (input !== null && typeof input === 'object') {
        if (seen.has(input)) {
          return '[Circular]';
        }
        seen.add(input);
        const output: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
          output[key] = walk(item, key);
        }
        return output;
      }
      return input;
    };

    return walk(value) as T;
  };

  return {
    redact,
    redactDeep,
    get redactionCount() {
      return redactionCount;
    },
  };
}

/** Convenience helper for one-off redaction without keeping state. */
export function redactText(text: string, options?: RedactorOptions): string {
  return createRedactor(options).redact(text);
}

/** Recursively redacts sensitive object keys and string values. */
export function redactDeep<T>(value: T, options?: RedactorOptions): T {
  return createRedactor(options).redactDeep(value);
}
