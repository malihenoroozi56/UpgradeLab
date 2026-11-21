import { z } from 'zod';
import { CONFIG_SCHEMA_VERSION } from './version.js';

/**
 * Strict, versioned configuration schema.
 *
 * The schema is the single source of truth for the YAML format. Resources
 * (services, assertions, invariants) are intentionally data-only: UpgradeLab
 * never interpolates configuration into a shell command line.
 */

export const DEFAULTS = {
  scenarioTimeoutMs: 600_000,
  assertionTimeoutMs: 15_000,
  logTailLines: 500,
  failFast: false,
  applicationPort: 3000,
  databasePort: 5432,
  databaseName: 'upgradelab',
  databaseUser: 'upgradelab',
  databasePassword: 'upgradelab',
  databaseStatementTimeoutMs: 5_000,
  databaseConnectionTimeoutMs: 10_000,
  databaseMaxRows: 1_000,
  readinessMs: 60_000,
  startMs: 120_000,
  stopMs: 60_000,
  commandMs: 60_000,
  memoryLimit: '1g',
  cpus: 1,
  pidsLimit: 512,
  bindAddress: '127.0.0.1',
} as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SERVICE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;

export const resourceIdSchema = z
  .string()
  .regex(
    ID_PATTERN,
    'must start with a lowercase letter or digit and contain only a-z, 0-9, ".", "_" or "-" (max 64 characters)',
  );

export const serviceNameSchema = z
  .string()
  .regex(
    SERVICE_PATTERN,
    'must be a Docker Compose service name (letters, digits, ".", "_" or "-")',
  );

export const imageReferenceSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(IMAGE_PATTERN, 'must be a valid container image reference, e.g. "ghcr.io/acme/app:1.2.0"');

export const commandSchema = z
  .array(z.string().min(1))
  .min(1, 'must contain at least one argument')
  .max(128)
  .describe('Argument array executed without a shell. Shell operators are not supported.');

const timeoutSchema = z
  .number()
  .int()
  .positive()
  .max(24 * 60 * 60 * 1000);

export const healthcheckSchema = z
  .strictObject({
    type: z.enum(['http', 'tcp', 'command']),
    path: z.string().startsWith('/').optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    command: commandSchema.optional(),
    intervalMs: z.number().int().min(100).max(60_000).default(1_000),
    timeoutMs: z.number().int().min(100).max(300_000).default(5_000),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'http' && value.command) {
      ctx.addIssue({ code: 'custom', message: 'command is not allowed for an http healthcheck' });
    }
    if (value.type === 'command' && !value.command) {
      ctx.addIssue({ code: 'custom', message: 'command is required for a command healthcheck' });
    }
    if (value.type === 'command' && value.path) {
      ctx.addIssue({ code: 'custom', message: 'path is not allowed for a command healthcheck' });
    }
  });

export type HealthcheckConfig = z.infer<typeof healthcheckSchema>;

export const setupCommandSchema = z.strictObject({
  target: serviceNameSchema,
  command: commandSchema,
  timeoutMs: timeoutSchema.optional(),
  expectedExitCode: z.number().int().min(0).max(255).default(0),
  env: z
    .record(
      z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an upper-case environment variable name'),
      z.string(),
    )
    .optional(),
  description: z.string().max(200).optional(),
});

export type SetupCommandConfig = z.infer<typeof setupCommandSchema>;

const assertionCommon = {
  id: resourceIdSchema,
  description: z.string().max(500).optional(),
  required: z.boolean().default(true),
  timeoutMs: timeoutSchema.optional(),
};

export const httpAssertionSchema = z
  .strictObject({
    ...assertionCommon,
    type: z.literal('http'),
    path: z.string().startsWith('/').optional(),
    url: z.string().url().optional(),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    headers: z.record(z.string(), z.string()).optional(),
    bodyContains: z.string().optional(),
    jsonPath: z.string().min(1).optional(),
    jsonEquals: z.unknown().optional(),
    jsonMatches: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.path && !value.url) {
      ctx.addIssue({ code: 'custom', message: 'either "path" or "url" is required' });
    }
    if (value.path && value.url) {
      ctx.addIssue({ code: 'custom', message: 'only one of "path" or "url" may be set' });
    }
    if (value.jsonPath && value.jsonEquals === undefined && value.jsonMatches === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'jsonPath requires "jsonEquals" or "jsonMatches"',
      });
    }
    if (!value.jsonPath && (value.jsonEquals !== undefined || value.jsonMatches !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: '"jsonEquals" and "jsonMatches" require "jsonPath"',
      });
    }
  });

export type HttpAssertionConfig = z.infer<typeof httpAssertionSchema>;

export const commandAssertionSchema = z.strictObject({
  ...assertionCommon,
  type: z.literal('command'),
  target: serviceNameSchema,
  command: commandSchema,
  expectedExitCode: z.number().int().min(0).max(255).default(0),
  stdoutContains: z.string().optional(),
  stdoutMatches: z.string().optional(),
  stderrContains: z.string().optional(),
});

export type CommandAssertionConfig = z.infer<typeof commandAssertionSchema>;

export const sqlComparisonSchema = z.enum([
  'equal',
  'equal-before-after',
  'numeric-equal-before-after',
  'non-empty',
  'empty',
  'matches',
  'at-least',
  'at-most',
]);

export type SqlComparison = z.infer<typeof sqlComparisonSchema>;

/**
 * Resolves the effective comparison strategy.
 *
 * When `comparison` is omitted, providing `expected` means "compare to this
 * value" and omitting it means "compare with the pre-upgrade baseline".
 */
function resolveComparison(
  comparison: SqlComparison | undefined,
  expected: unknown,
): SqlComparison {
  if (comparison) {
    return comparison;
  }
  return expected === undefined ? 'equal-before-after' : 'equal';
}

export const sqlAssertionSchema = z
  .strictObject({
    ...assertionCommon,
    type: z.literal('sql'),
    query: z.string().min(1).max(20_000),
    comparison: sqlComparisonSchema.optional(),
    expected: z.unknown().optional(),
    tolerance: z.number().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    const comparison = resolveComparison(value.comparison, value.expected);
    const requiresExpected =
      comparison === 'equal' ||
      comparison === 'matches' ||
      comparison === 'at-least' ||
      comparison === 'at-most';
    if (requiresExpected && value.expected === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `"expected" is required when comparison is "${comparison}"`,
      });
    }
    if (comparison === 'matches' && typeof value.expected !== 'string') {
      ctx.addIssue({ code: 'custom', message: '"expected" must be a regular expression string' });
    }
    if (
      (comparison === 'at-least' || comparison === 'at-most') &&
      typeof value.expected !== 'number'
    ) {
      ctx.addIssue({ code: 'custom', message: '"expected" must be a number' });
    }
    if (value.tolerance !== undefined) {
      const numeric = comparison === 'equal' || comparison === 'numeric-equal-before-after';
      if (!numeric) {
        ctx.addIssue({
          code: 'custom',
          message: '"tolerance" is only valid for numeric comparisons',
        });
      }
    }
  })
  .transform((value) => ({
    ...value,
    comparison: resolveComparison(value.comparison, value.expected),
  }));

export type SqlAssertionConfig = z.infer<typeof sqlAssertionSchema>;

export const containerAssertionSchema = z.strictObject({
  ...assertionCommon,
  type: z.literal('container'),
  target: serviceNameSchema,
  state: z.enum(['running', 'healthy', 'stopped']).default('running'),
});

export type ContainerAssertionConfig = z.infer<typeof containerAssertionSchema>;

export const healthAssertionSchema = z.strictObject({
  ...assertionCommon,
  type: z.literal('health'),
  target: serviceNameSchema.optional(),
});

export type HealthAssertionConfig = z.infer<typeof healthAssertionSchema>;

export const BUILTIN_ASSERTION_TYPES = ['http', 'command', 'sql', 'container', 'health'] as const;
export type BuiltinAssertionType = (typeof BUILTIN_ASSERTION_TYPES)[number];

export const builtinAssertionSchemas = {
  http: httpAssertionSchema,
  command: commandAssertionSchema,
  sql: sqlAssertionSchema,
  container: containerAssertionSchema,
  health: healthAssertionSchema,
} as const satisfies Record<BuiltinAssertionType, z.ZodType>;

export type BuiltinAssertionConfig =
  | HttpAssertionConfig
  | CommandAssertionConfig
  | SqlAssertionConfig
  | ContainerAssertionConfig
  | HealthAssertionConfig;

/**
 * Plugin-provided assertion. `params` holds every field that was not part of the
 * envelope, and is validated by the plugin's own schema at registration time.
 */
export interface CustomAssertionConfig {
  readonly id: string;
  readonly type: string;
  readonly description?: string;
  readonly required: boolean;
  readonly timeoutMs?: number;
  readonly params: Readonly<Record<string, unknown>>;
}

export type AssertionConfig = BuiltinAssertionConfig | CustomAssertionConfig;

export const assertionEnvelopeSchema = z
  .strictObject({
    id: resourceIdSchema,
    type: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,63}$/, 'must be a lower-case assertion type such as "http"'),
    description: z.string().max(500).optional(),
    required: z.boolean().default(true),
    timeoutMs: timeoutSchema.optional(),
  })
  .loose();

export type AssertionEnvelope = z.infer<typeof assertionEnvelopeSchema>;

export const invariantSchema = z
  .strictObject({
    id: resourceIdSchema,
    description: z.string().max(500).optional(),
    type: z.literal('sql'),
    query: z.string().min(1).max(20_000),
    comparison: sqlComparisonSchema.optional(),
    expected: z.unknown().optional(),
    tolerance: z.number().min(0).optional(),
    required: z.boolean().default(true),
    timeoutMs: timeoutSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const comparison = resolveComparison(value.comparison, value.expected);
    const requiresExpected =
      comparison === 'equal' ||
      comparison === 'matches' ||
      comparison === 'at-least' ||
      comparison === 'at-most';
    if (requiresExpected && value.expected === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `"expected" is required when comparison is "${comparison}"`,
      });
    }
    if (comparison === 'matches' && typeof value.expected !== 'string') {
      ctx.addIssue({ code: 'custom', message: '"expected" must be a regular expression string' });
    }
    if (value.tolerance !== undefined) {
      const numeric = comparison === 'equal' || comparison === 'numeric-equal-before-after';
      if (!numeric) {
        ctx.addIssue({
          code: 'custom',
          message: '"tolerance" is only valid for numeric comparisons',
        });
      }
    }
  })
  .transform((value) => ({
    ...value,
    comparison: resolveComparison(value.comparison, value.expected),
  }));

export type InvariantConfig = z.infer<typeof invariantSchema>;

const upgradeStepInputSchema = z.strictObject({
  image: imageReferenceSchema,
  healthcheck: healthcheckSchema.optional(),
  setup: z.array(setupCommandSchema).max(50).default([]),
  assertions: z.array(z.unknown()).max(200).default([]),
});

const scenarioInputSchema = z
  .strictObject({
    id: resourceIdSchema,
    description: z.string().max(500).optional(),
    timeoutMs: timeoutSchema.optional(),
    from: upgradeStepInputSchema.optional(),
    to: upgradeStepInputSchema.optional(),
    path: z.array(upgradeStepInputSchema).min(1).max(10).optional(),
    setup: z.array(setupCommandSchema).max(50).default([]),
    invariants: z.array(invariantSchema).max(200).default([]),
    assertions: z.array(z.unknown()).max(500).default([]),
  })
  .superRefine((value, ctx) => {
    const usesPath = value.path !== undefined;
    const usesFromTo = value.from !== undefined || value.to !== undefined;
    if (usesPath && usesFromTo) {
      ctx.addIssue({
        code: 'custom',
        message: 'use either "path" or "from"/"to", not both',
      });
    }
    if (!usesPath && !(value.from && value.to)) {
      ctx.addIssue({
        code: 'custom',
        message: 'either "path" (1-10 images) or both "from" and "to" are required',
      });
    }
    if (value.from && !value.to) {
      ctx.addIssue({ code: 'custom', message: '"to" is required when "from" is set' });
    }
    if (value.to && !value.from) {
      ctx.addIssue({ code: 'custom', message: '"from" is required when "to" is set' });
    }
  });

export interface ScenarioInput {
  readonly id: string;
  readonly description?: string;
  readonly timeoutMs?: number;
  readonly from?: z.infer<typeof upgradeStepInputSchema>;
  readonly to?: z.infer<typeof upgradeStepInputSchema>;
  readonly path?: readonly z.infer<typeof upgradeStepInputSchema>[];
  readonly setup: readonly SetupCommandConfig[];
  readonly invariants: readonly InvariantConfig[];
  readonly assertions: readonly AssertionConfig[];
}

export interface UpgradeStepConfig {
  readonly image: string;
  readonly healthcheck?: HealthcheckConfig;
  readonly setup: readonly SetupCommandConfig[];
  readonly assertions: readonly AssertionConfig[];
}

export interface ScenarioConfig {
  readonly id: string;
  readonly description?: string;
  readonly timeoutMs?: number;
  /** Ordered images: index 0 is the source release, the last entry is the target. */
  readonly path: readonly UpgradeStepConfig[];
  readonly setup: readonly SetupCommandConfig[];
  readonly invariants: readonly InvariantConfig[];
  readonly assertions: readonly AssertionConfig[];
}

const environmentSchema = z.strictObject({
  provider: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/, 'must be a registered environment provider id')
    .default('docker-compose'),
  composeFile: z.string().min(1).default('./docker-compose.yml'),
  projectDirectory: z.string().min(1).optional(),
  composeEnv: z.record(z.string(), z.string()).default({}),
  application: z
    .strictObject({
      service: serviceNameSchema,
      port: z.number().int().min(1).max(65_535).optional(),
      healthcheck: healthcheckSchema.optional(),
    })
    .superRefine((value, ctx) => {
      if (
        value.healthcheck?.type === 'http' &&
        !value.healthcheck.port &&
        value.port === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'application.port or application.healthcheck.port is required for an http healthcheck',
        });
      }
      if (
        value.healthcheck?.type === 'tcp' &&
        !value.healthcheck.port &&
        value.port === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            'application.port or application.healthcheck.port is required for a tcp healthcheck',
        });
      }
    }),
  database: z
    .strictObject({
      service: serviceNameSchema,
      adapter: z.literal('postgres'),
      port: z.number().int().min(1).max(65_535).default(DEFAULTS.databasePort),
      database: z.string().min(1).max(63).default(DEFAULTS.databaseName),
      user: z.string().min(1).max(63).default(DEFAULTS.databaseUser),
      password: z.string().min(1).max(500).default(DEFAULTS.databasePassword),
      ssl: z.boolean().default(false),
      connectionTimeoutMs: timeoutSchema.default(DEFAULTS.databaseConnectionTimeoutMs),
      statementTimeoutMs: timeoutSchema.default(DEFAULTS.databaseStatementTimeoutMs),
      maxRows: z.number().int().min(1).max(100_000).default(DEFAULTS.databaseMaxRows),
    })
    .optional(),
  network: z
    .strictObject({
      internal: z.boolean().default(false),
      bindAddress: z
        .string()
        .regex(
          /^(127\.0\.0\.1|::1|0\.0\.0\.0)$/,
          'must be 127.0.0.1, ::1 or 0.0.0.0 (0.0.0.0 requires security.allowNonLoopbackPorts)',
        )
        .default(DEFAULTS.bindAddress),
    })
    .default({ internal: false, bindAddress: DEFAULTS.bindAddress }),
  resources: z
    .strictObject({
      memoryLimit: z
        .string()
        .regex(/^\d+(b|k|kb|m|mb|g|gb)$/i, 'must be a Docker memory limit such as "512mb" or "1g"')
        .default(DEFAULTS.memoryLimit),
      cpus: z.number().positive().max(64).default(DEFAULTS.cpus),
      pidsLimit: z.number().int().min(16).max(100_000).default(DEFAULTS.pidsLimit),
    })
    .default({
      memoryLimit: DEFAULTS.memoryLimit,
      cpus: DEFAULTS.cpus,
      pidsLimit: DEFAULTS.pidsLimit,
    }),
  timeouts: z
    .strictObject({
      startMs: timeoutSchema.default(DEFAULTS.startMs),
      readinessMs: timeoutSchema.default(DEFAULTS.readinessMs),
      stopMs: timeoutSchema.default(DEFAULTS.stopMs),
      commandMs: timeoutSchema.default(DEFAULTS.commandMs),
    })
    .default({
      startMs: DEFAULTS.startMs,
      readinessMs: DEFAULTS.readinessMs,
      stopMs: DEFAULTS.stopMs,
      commandMs: DEFAULTS.commandMs,
    }),
});

export type EnvironmentConfig = z.infer<typeof environmentSchema>;

export const securitySchema = z
  .strictObject({
    allowConfigPlugins: z.boolean().default(false),
    allowNonLoopbackPorts: z.boolean().default(false),
    extraMountRoots: z.array(z.string().min(1)).max(20).default([]),
  })
  .default({ allowConfigPlugins: false, allowNonLoopbackPorts: false, extraMountRoots: [] });

export type SecurityConfig = z.infer<typeof securitySchema>;

const defaultsSchema = z
  .strictObject({
    scenarioTimeoutMs: timeoutSchema.default(DEFAULTS.scenarioTimeoutMs),
    assertionTimeoutMs: timeoutSchema.default(DEFAULTS.assertionTimeoutMs),
    logTailLines: z.number().int().min(0).max(100_000).default(DEFAULTS.logTailLines),
    failFast: z.boolean().default(DEFAULTS.failFast),
  })
  .default({
    scenarioTimeoutMs: DEFAULTS.scenarioTimeoutMs,
    assertionTimeoutMs: DEFAULTS.assertionTimeoutMs,
    logTailLines: DEFAULTS.logTailLines,
    failFast: DEFAULTS.failFast,
  });

export type DefaultsConfig = z.infer<typeof defaultsSchema>;

export const AI_FEATURES = [
  'explain-failure',
  'analyze-logs',
  'schema-review',
  'suggest-invariants',
  'failure-summary',
  'prepare-issue',
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

export const aiConfigSchema = z
  .strictObject({
    /** AI is disabled unless the user explicitly opts in. */
    enabled: z.boolean().default(false),
    provider: z.enum(['openai', 'anthropic', 'gemini', 'openai-compatible']).default('openai'),
    model: z.string().min(1).max(200).optional(),
    /** Required for OpenAI-compatible endpoints such as Ollama or LM Studio. */
    baseUrl: z.string().url().optional(),
    /** Name of the environment variable holding the API key (never the key itself). */
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an upper-case environment variable name')
      .optional(),
    maxOutputTokens: z.number().int().min(64).max(16_000).default(1_200),
    timeoutMs: timeoutSchema.default(60_000),
    features: z
      .array(z.enum(AI_FEATURES))
      .max(AI_FEATURES.length)
      .default([...AI_FEATURES]),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && !value.model) {
      ctx.addIssue({
        code: 'custom',
        message: '"model" is required when ai.enabled is true',
      });
    }
    if (value.provider === 'openai-compatible' && !value.baseUrl) {
      ctx.addIssue({
        code: 'custom',
        message: '"baseUrl" is required for the openai-compatible provider',
      });
    }
  });

export type AiConfig = z.infer<typeof aiConfigSchema>;

export const pluginReferenceSchema = z.strictObject({
  path: z.string().min(1).max(1000),
  config: z.record(z.string(), z.unknown()).optional(),
});

export type PluginReferenceConfig = z.infer<typeof pluginReferenceSchema>;

export const rawConfigSchema = z.strictObject({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  project: z.strictObject({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
  }),
  environment: environmentSchema,
  security: securitySchema,
  defaults: defaultsSchema,
  ai: aiConfigSchema.default({
    enabled: false,
    provider: 'openai',
    maxOutputTokens: 1200,
    timeoutMs: 60000,
    features: [...AI_FEATURES],
  }),
  plugins: z.array(pluginReferenceSchema).max(20).default([]),
  scenarios: z.array(scenarioInputSchema).min(1).max(200),
});

export type RawConfig = z.input<typeof rawConfigSchema>;

/** Fully validated, immutable-by-convention configuration document. */
export interface UpgradeLabConfig {
  readonly schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  readonly project: { readonly name: string; readonly description?: string };
  readonly environment: EnvironmentConfig;
  readonly security: SecurityConfig;
  readonly defaults: DefaultsConfig;
  readonly ai: AiConfig;
  readonly plugins: readonly PluginReferenceConfig[];
  readonly scenarios: readonly ScenarioConfig[];
}

export function isBuiltinAssertionType(type: string): type is BuiltinAssertionType {
  return (BUILTIN_ASSERTION_TYPES as readonly string[]).includes(type);
}

const ASSERTION_ENVELOPE_KEYS = new Set(['id', 'type', 'description', 'required', 'timeoutMs']);

/**
 * Validates one assertion.
 *
 * Built-in types are validated with their strict schema, so unknown fields are
 * rejected. Any other type is treated as a plugin assertion: the envelope is
 * validated here and the remaining fields are handed to the plugin, which owns
 * validation of its own parameters.
 */
export function parseAssertion(raw: unknown): AssertionConfig {
  const envelope = assertionEnvelopeSchema.parse(raw);
  if (isBuiltinAssertionType(envelope.type)) {
    return builtinAssertionSchemas[envelope.type].parse(raw) as BuiltinAssertionConfig;
  }
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ASSERTION_ENVELOPE_KEYS.has(key)) {
      extras[key] = value;
    }
  }
  return {
    id: envelope.id,
    type: envelope.type,
    ...(envelope.description === undefined ? {} : { description: envelope.description }),
    required: envelope.required,
    ...(envelope.timeoutMs === undefined ? {} : { timeoutMs: envelope.timeoutMs }),
    params: extras,
  };
}

export function parseAssertions(raw: readonly unknown[]): AssertionConfig[] {
  return raw.map((entry) => parseAssertion(entry));
}

/**
 * Normalizes the `from`/`to` shorthand into the canonical multi-hop `path`.
 * Throws a plain Error for the (already validated) contradictory case.
 */
export function normalizeScenario(input: ScenarioInput): ScenarioConfig {
  const steps: UpgradeStepConfig[] = [];
  if (input.path) {
    for (const step of input.path) {
      steps.push({
        image: step.image,
        ...(step.healthcheck ? { healthcheck: step.healthcheck } : {}),
        setup: step.setup,
        assertions: parseAssertions(step.assertions),
      });
    }
  } else if (input.from && input.to) {
    for (const step of [input.from, input.to]) {
      steps.push({
        image: step.image,
        ...(step.healthcheck ? { healthcheck: step.healthcheck } : {}),
        setup: step.setup,
        assertions: parseAssertions(step.assertions),
      });
    }
  } else {
    throw new Error('scenario requires either "path" or "from"/"to"');
  }

  // Scenario-level setup runs after the source release starts, which is where
  // seeding belongs; it is prepended to the source step's own setup commands.
  const source = steps[0];
  if (!source) {
    throw new Error('scenario requires at least one upgrade step');
  }
  steps[0] = { ...source, setup: [...input.setup, ...source.setup] };

  return {
    id: input.id,
    ...(input.description ? { description: input.description } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    path: steps,
    setup: input.setup,
    invariants: input.invariants,
    assertions: parseAssertions(input.assertions),
  };
}
