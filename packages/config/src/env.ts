import { UpgradeLabError } from '@upgradelab/contracts';

/**
 * Resolves `${VAR}` and `${VAR:-default}` references in configuration strings.
 *
 * Resolution happens before schema validation so that a missing required
 * variable is reported with the exact configuration path that referenced it.
 * `$${VAR}` escapes a literal `${VAR}`. Nested references are not expanded;
 * values are inserted verbatim.
 */

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$\$\{/g;

export interface EnvResolutionContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Records resolved values whose variable name looks sensitive. */
  readonly secretValues: Set<string>;
  readonly secretEnvNames?: readonly RegExp[];
  readonly path?: readonly (string | number)[];
}

const DEFAULT_SECRET_NAME = /pass|secret|token|key|credential|auth/i;

function isSensitiveName(name: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(name));
}

function resolveString(value: string, context: EnvResolutionContext): string {
  return value.replace(REFERENCE, (match, name?: string, fallback?: string) => {
    if (match === '$${') {
      return '${';
    }
    if (!name) {
      return match;
    }
    const raw = context.env[name];
    if (raw === undefined || raw === '') {
      if (fallback !== undefined) {
        if (isSensitiveName(name, context.secretEnvNames ?? [DEFAULT_SECRET_NAME])) {
          context.secretValues.add(fallback);
        }
        return fallback;
      }
      throw new UpgradeLabError(
        `Environment variable "${name}" referenced by configuration is not set.`,
        {
          code: 'CONFIG_SECRET_UNRESOLVED',
          details: { variable: name, path: context.path?.join('.') ?? '' },
          hint: `Set ${name} or provide a default with \${${name}:-default}.`,
        },
      );
    }
    if (isSensitiveName(name, context.secretEnvNames ?? [DEFAULT_SECRET_NAME]) && raw.length >= 4) {
      context.secretValues.add(raw);
    }
    return raw;
  });
}

function resolveValue(value: unknown, context: EnvResolutionContext): unknown {
  if (typeof value === 'string') {
    return resolveString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      resolveValue(item, { ...context, path: [...(context.path ?? []), index] }),
    );
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = resolveValue(item, { ...context, path: [...(context.path ?? []), key] });
    }
    return output;
  }
  return value;
}

export interface ResolveEnvironmentOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secretEnvNames?: readonly RegExp[];
}

export interface ResolvedEnvironment {
  readonly value: unknown;
  readonly secrets: readonly string[];
}

/** Recursively resolves environment references in a parsed configuration document. */
export function resolveEnvironmentReferences(
  document: unknown,
  options: ResolveEnvironmentOptions,
): ResolvedEnvironment {
  const secretValues = new Set<string>();
  const value = resolveValue(document, {
    env: options.env,
    secretValues,
    ...(options.secretEnvNames ? { secretEnvNames: options.secretEnvNames } : {}),
  });
  return { value, secrets: [...secretValues].sort() };
}

/** Lists `${VAR}` references in a document, without resolving them. */
export function collectEnvironmentReferences(document: unknown): readonly string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const name = match[1];
        if (name) {
          found.add(name);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value !== null && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };
  walk(document);
  return [...found].sort();
}
