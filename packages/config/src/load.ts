import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { ZodError, type ZodIssue } from 'zod';
import {
  CONFIG_SCHEMA_VERSION,
  UpgradeLabError,
  normalizeScenario,
  parseAssertion,
  resourceIdSchema,
  rawConfigSchema,
  type AssertionConfig,
  type ScenarioConfig,
  type ScenarioInput,
  type UpgradeLabConfig,
} from '@upgradelab/contracts';
import { resolveEnvironmentReferences } from './env.js';

export const CONFIG_FILE_CANDIDATES = [
  'upgradelab.yaml',
  'upgradelab.yml',
  '.upgradelab/config.yaml',
] as const;

const MAX_CONFIG_BYTES = 1024 * 1024;

export interface LoadedConfig {
  readonly config: UpgradeLabConfig;
  readonly configPath: string;
  readonly configDirectory: string;
  /** Absolute path of the Docker Compose file. */
  readonly composeFile: string;
  /** Absolute Compose project directory (build contexts resolve from here). */
  readonly projectDirectory: string;
  /** Literal secret values that must be redacted from logs and reports. */
  readonly secrets: readonly string[];
  readonly configHash: string;
  readonly rawText: string;
  readonly warnings: readonly string[];
}

export interface LoadConfigOptions {
  readonly configPath?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ParseConfigOptions {
  readonly sourcePath: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ParsedConfig {
  readonly config: UpgradeLabConfig;
  readonly secrets: readonly string[];
  readonly warnings: readonly string[];
}

function configError(
  message: string,
  details: Record<string, unknown>,
  hint?: string,
): UpgradeLabError {
  return new UpgradeLabError(message, {
    code: 'CONFIG_VALIDATION_ERROR',
    details,
    ...(hint ? { hint } : {}),
  });
}

function formatPath(segments: readonly PropertyKey[]): string {
  let output = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      output += `[${segment}]`;
    } else if (output.length === 0) {
      output += String(segment);
    } else {
      output += `.${String(segment)}`;
    }
  }
  return output || '<root>';
}

export function formatZodIssues(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((issue: ZodIssue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

function zodErrorToUpgradeLab(
  error: ZodError,
  sourcePath: string,
  pathPrefix = '',
): UpgradeLabError {
  const issues = formatZodIssues(error).map((issue) => ({
    ...issue,
    path: pathPrefix
      ? `${pathPrefix}${issue.path === '<root>' ? '' : `.${issue.path}`}`
      : issue.path,
  }));
  const summary = issues
    .slice(0, 8)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('\n');
  return configError(
    `Invalid UpgradeLab configuration in ${sourcePath}:\n${summary}`,
    { source: sourcePath, issues },
    'Fix the listed fields. Unknown fields are rejected to catch typos early.',
  );
}

interface ParsedYamlDocument {
  readonly document: unknown;
}

function parseYamlText(text: string, sourcePath: string): ParsedYamlDocument {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    throw configError(`Configuration file ${sourcePath} exceeds the 1 MiB limit.`, {
      source: sourcePath,
      bytes: Buffer.byteLength(text, 'utf8'),
    });
  }
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: true });
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    const position = first?.linePos?.[0];
    const location = position ? `${sourcePath}:${position.line}:${position.col}` : sourcePath;
    const issues = doc.errors.map((error) => {
      const pos = error.linePos?.[0];
      return {
        path: pos ? `line ${pos.line}, column ${pos.col}` : '<yaml>',
        message: error.message.split('\n')[0] ?? error.message,
      };
    });
    throw new UpgradeLabError(
      `Failed to parse YAML configuration at ${location}: ${issues[0]?.message ?? 'unknown error'}`,
      {
        code: 'CONFIG_PARSE_ERROR',
        details: { source: sourcePath, issues },
        hint: 'YAML is indentation-sensitive. Check the reported line and column.',
      },
    );
  }
  if (doc.contents === null) {
    throw new UpgradeLabError(`Configuration file ${sourcePath} is empty.`, {
      code: 'CONFIG_PARSE_ERROR',
      details: { source: sourcePath },
      hint: 'Run "upgradelab init" to generate a documented starting configuration.',
    });
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 50 });
  } catch (error) {
    throw new UpgradeLabError(
      `Failed to read YAML configuration ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'CONFIG_PARSE_ERROR', details: { source: sourcePath }, cause: error },
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpgradeLabError(
      `Configuration ${sourcePath} must contain a YAML mapping at the top level.`,
      {
        code: 'CONFIG_PARSE_ERROR',
        details: { source: sourcePath },
      },
    );
  }
  return { document: value };
}

function checkSchemaVersion(raw: Record<string, unknown>, sourcePath: string): void {
  const version = raw['schemaVersion'];
  if (version === undefined) {
    throw configError(
      `Configuration ${sourcePath} is missing "schemaVersion".`,
      { source: sourcePath },
      `Add "schemaVersion: ${CONFIG_SCHEMA_VERSION}" at the top of the file.`,
    );
  }
  if (version !== CONFIG_SCHEMA_VERSION) {
    throw new UpgradeLabError(
      `Unsupported configuration schemaVersion ${JSON.stringify(version)} in ${sourcePath}. This release supports schemaVersion ${CONFIG_SCHEMA_VERSION}.`,
      {
        code: 'CONFIG_UNSUPPORTED_VERSION',
        details: { source: sourcePath, found: version, supported: CONFIG_SCHEMA_VERSION },
        hint: 'See docs/configuration/migration.md for the migration guide.',
      },
    );
  }
}

/**
 * Validates assertions with precise paths.
 *
 * `rawConfigSchema` accepts assertions as opaque values so plugin assertion
 * types can be introduced without changing the core schema; this function then
 * validates built-in types strictly and rejects malformed envelopes.
 */
function validateScenarioAssertions(
  scenario: ScenarioInput,
  index: number,
  sourcePath: string,
): void {
  const groups: { path: string; items: readonly unknown[] }[] = [
    { path: `scenarios[${index}].assertions`, items: scenario.assertions },
  ];
  for (const [stepIndex, step] of (scenario.path ?? []).entries()) {
    groups.push({
      path: `scenarios[${index}].path[${stepIndex}].assertions`,
      items: step.assertions,
    });
  }
  if (scenario.from) {
    groups.push({ path: `scenarios[${index}].from.assertions`, items: scenario.from.assertions });
  }
  if (scenario.to) {
    groups.push({ path: `scenarios[${index}].to.assertions`, items: scenario.to.assertions });
  }
  for (const group of groups) {
    group.items.forEach((item, assertionIndex) => {
      try {
        parseAssertion(item);
      } catch (error) {
        if (error instanceof ZodError) {
          throw zodErrorToUpgradeLab(error, sourcePath, `${group.path}[${assertionIndex}]`);
        }
        throw error;
      }
    });
  }
}

function assertUnique(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw configError(`${label} contain duplicate ids: ${[...duplicates].join(', ')}`, {
      ids: [...duplicates],
    });
  }
}

function assertUniqueStepIds(scenario: ScenarioInput, index: number): void {
  for (const [stepIndex, step] of (scenario.path ?? []).entries()) {
    const ids = step.assertions
      .map((assertion) =>
        assertion !== null && typeof assertion === 'object' && 'id' in assertion
          ? String((assertion as { id: unknown }).id)
          : '',
      )
      .filter(Boolean);
    assertUnique(ids, `scenarios[${index}].path[${stepIndex}].assertions`);
  }
  if (scenario.from) {
    const ids = scenario.from.assertions.map((assertion) => parseAssertion(assertion).id);
    assertUnique(ids, `scenarios[${index}].from.assertions`);
  }
  if (scenario.to) {
    const ids = scenario.to.assertions.map((assertion) => parseAssertion(assertion).id);
    assertUnique(ids, `scenarios[${index}].to.assertions`);
  }
}

function crossValidate(config: UpgradeLabConfig, sourcePath: string): string[] {
  const warnings: string[] = [];

  if (
    config.environment.network.bindAddress !== '127.0.0.1' &&
    config.environment.network.bindAddress !== '::1'
  ) {
    if (!config.security.allowNonLoopbackPorts) {
      throw configError(
        `environment.network.bindAddress is "${config.environment.network.bindAddress}", which publishes test ports beyond loopback.`,
        { source: sourcePath, bindAddress: config.environment.network.bindAddress },
        'Set security.allowNonLoopbackPorts: true only if you understand the exposure, or keep 127.0.0.1.',
      );
    }
  }

  if (config.plugins.length > 0 && !config.security.allowConfigPlugins) {
    throw new UpgradeLabError(
      `Configuration ${sourcePath} references ${config.plugins.length} plugin(s) but security.allowConfigPlugins is false.`,
      {
        code: 'CONFIG_UNSAFE_PLUGIN_LOAD',
        details: { source: sourcePath, plugins: config.plugins.map((plugin) => plugin.path) },
        hint: 'Plugins execute code in the UpgradeLab process. Pass them with --plugin, or explicitly set security.allowConfigPlugins: true.',
      },
    );
  }

  const scenarioIds = config.scenarios.map((scenario) => scenario.id);
  assertUnique(scenarioIds, 'scenarios');

  for (const [index, scenario] of config.scenarios.entries()) {
    const allChecks = [
      ...scenario.invariants.map((invariant) => invariant.id),
      ...scenario.assertions.map((assertion) => assertion.id),
    ];
    assertUnique(allChecks, `scenarios[${index}] (invariants + assertions)`);
    if (allChecks.length === 0) {
      warnings.push(
        `Scenario "${scenario.id}" has no invariants or assertions; it will be reported as INCONCLUSIVE because a successful start is not proof of a safe upgrade.`,
      );
    }
    for (const step of scenario.path) {
      if (!step.image) {
        throw configError(`Scenario "${scenario.id}" contains a step without an image.`, {
          scenario: scenario.id,
        });
      }
    }
  }

  const needsDatabase = config.scenarios.some(
    (scenario) =>
      scenario.invariants.length > 0 ||
      scenario.assertions.some((assertion) => assertion.type === 'sql'),
  );
  if (needsDatabase && !config.environment.database) {
    throw configError(
      'SQL invariants or assertions are configured but environment.database is missing.',
      { source: sourcePath },
      'Add environment.database with service and adapter: postgres, or remove the SQL checks.',
    );
  }

  if (config.environment.database) {
    const hasSqlCheck = config.scenarios.some(
      (scenario) =>
        scenario.invariants.length > 0 ||
        scenario.assertions.some((assertion) => assertion.type === 'sql'),
    );
    if (!hasSqlCheck) {
      warnings.push(
        'environment.database is configured but no SQL invariants or assertions use it.',
      );
    }
  }

  return warnings;
}

function collectConfigSecrets(
  config: UpgradeLabConfig,
  resolvedSecrets: readonly string[],
): string[] {
  const secrets = new Set(resolvedSecrets);
  if (config.environment.database?.password && config.environment.database.password.length >= 4) {
    secrets.add(config.environment.database.password);
  }
  for (const [key, value] of Object.entries(config.environment.composeEnv)) {
    if (/pass|secret|token|key|credential/i.test(key) && value.length >= 4) {
      secrets.add(value);
    }
  }
  return [...secrets].filter((secret) => secret.length >= 4).sort();
}

/** Computes a stable hash of the raw configuration text for report traceability. */
export function computeConfigHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Parses and validates configuration text without touching the filesystem. */
export function parseConfigText(text: string, options: ParseConfigOptions): ParsedConfig {
  const { sourcePath } = options;
  const env = options.env ?? process.env;
  const parsed = parseYamlText(text, sourcePath);
  const raw = parsed.document as Record<string, unknown>;
  checkSchemaVersion(raw, sourcePath);

  const resolved = resolveEnvironmentReferences(raw, { env });
  if (
    resolved.value !== null &&
    typeof resolved.value === 'object' &&
    (resolved.value as Record<string, unknown>)['schemaVersion'] !== CONFIG_SCHEMA_VERSION
  ) {
    throw new UpgradeLabError(`schemaVersion must remain ${CONFIG_SCHEMA_VERSION}.`, {
      code: 'CONFIG_UNSUPPORTED_VERSION',
      details: { source: sourcePath },
    });
  }

  const result = rawConfigSchema.safeParse(resolved.value);
  if (!result.success) {
    throw zodErrorToUpgradeLab(result.error, sourcePath);
  }
  const rawConfig = result.data;

  for (const [index, scenario] of rawConfig.scenarios.entries()) {
    validateScenarioAssertions(scenario as ScenarioInput, index, sourcePath);
    assertUniqueStepIds(scenario as ScenarioInput, index);
  }

  let scenarios: ScenarioConfig[];
  try {
    scenarios = rawConfig.scenarios.map((scenario) => normalizeScenario(scenario as ScenarioInput));
  } catch (error) {
    if (error instanceof ZodError) {
      throw zodErrorToUpgradeLab(error, sourcePath);
    }
    throw error;
  }

  const config: UpgradeLabConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    project: rawConfig.project,
    environment: rawConfig.environment,
    security: rawConfig.security,
    defaults: rawConfig.defaults,
    ai: rawConfig.ai,
    plugins: rawConfig.plugins,
    scenarios,
  };

  const warnings = crossValidate(config, sourcePath);
  const secrets = collectConfigSecrets(config, resolved.secrets);
  return { config, secrets, warnings };
}

async function findConfigFile(cwd: string): Promise<string | undefined> {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const candidatePath = path.resolve(cwd, candidate);
    try {
      const stat = await fs.stat(candidatePath);
      if (stat.isFile()) {
        return candidatePath;
      }
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

/** Loads, resolves and validates an UpgradeLab configuration file. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const configPath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : await findConfigFile(cwd);

  if (!configPath) {
    throw new UpgradeLabError(
      `No UpgradeLab configuration found in ${cwd}. Looked for: ${CONFIG_FILE_CANDIDATES.join(', ')}.`,
      {
        code: 'CONFIG_NOT_FOUND',
        details: { cwd, candidates: [...CONFIG_FILE_CANDIDATES] },
        hint: 'Run "upgradelab init" to create upgradelab.yaml.',
      },
    );
  }

  let text: string;
  try {
    text = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new UpgradeLabError(`Configuration file ${configPath} does not exist.`, {
        code: 'CONFIG_NOT_FOUND',
        details: { configPath },
        cause: error,
        hint: 'Check --config or run "upgradelab init".',
      });
    }
    throw new UpgradeLabError(`Unable to read configuration file ${configPath}.`, {
      code: 'CONFIG_NOT_FOUND',
      details: { configPath, systemCode: code ?? 'unknown' },
      cause: error,
    });
  }

  const parsed = parseConfigText(text, { sourcePath: configPath, env });

  const configDirectory = path.dirname(configPath);
  const composeFile = path.resolve(configDirectory, parsed.config.environment.composeFile);
  const projectDirectory = path.resolve(
    configDirectory,
    parsed.config.environment.projectDirectory ??
      path.dirname(parsed.config.environment.composeFile),
  );

  try {
    const stat = await fs.stat(composeFile);
    if (!stat.isFile()) {
      throw new Error('not a file');
    }
  } catch (error) {
    throw new UpgradeLabError(
      `Docker Compose file ${composeFile} referenced by ${configPath} was not found.`,
      {
        code: 'CONFIG_VALIDATION_ERROR',
        details: { source: configPath, composeFile },
        cause: error,
        hint: 'Set environment.composeFile relative to the configuration file.',
      },
    );
  }

  return {
    config: parsed.config,
    configPath,
    configDirectory,
    composeFile,
    projectDirectory,
    secrets: parsed.secrets,
    configHash: computeConfigHash(text),
    rawText: text,
    warnings: parsed.warnings,
  };
}

/** Validates a scenario id exists and returns the selected scenarios. */
export function selectScenarios(
  config: UpgradeLabConfig,
  scenarioIds: readonly string[],
  options: { readonly allWhenEmpty?: boolean } = {},
): readonly ScenarioConfig[] {
  const allWhenEmpty = options.allWhenEmpty ?? true;
  if (scenarioIds.length === 0) {
    if (!allWhenEmpty) {
      throw configError('No scenario selected.', {});
    }
    return config.scenarios;
  }
  const requested = new Set<string>();
  for (const id of scenarioIds) {
    if (!resourceIdSchema.safeParse(id).success) {
      throw configError(`Invalid scenario id "${id}".`, { scenarioId: id });
    }
    requested.add(id);
  }
  const selected = config.scenarios.filter((scenario) => requested.has(scenario.id));
  const missing = [...requested].filter((id) => !selected.some((scenario) => scenario.id === id));
  if (missing.length > 0) {
    throw configError(
      `Unknown scenario id(s): ${missing.join(', ')}. Available: ${config.scenarios.map((scenario) => scenario.id).join(', ')}.`,
      { missing, available: config.scenarios.map((scenario) => scenario.id) },
      'Run "upgradelab validate" to list scenarios.',
    );
  }
  return selected;
}

export interface ConfigOverrides {
  readonly fromImage?: string;
  readonly toImage?: string;
  readonly timeoutMs?: number;
}

/**
 * Applies CLI/Action overrides without mutating the validated configuration.
 * Version overrides keep the upgrade path length intact: only the first and the
 * last image are replaced, which is the documented behaviour for multi-hop paths.
 */
export function applyOverrides(
  scenarios: readonly ScenarioConfig[],
  overrides: ConfigOverrides,
): readonly ScenarioConfig[] {
  if (!overrides.fromImage && !overrides.toImage && overrides.timeoutMs === undefined) {
    return scenarios;
  }
  return scenarios.map((scenario) => {
    const path = [...scenario.path];
    if (overrides.fromImage) {
      const first = path[0];
      if (first) {
        path[0] = { ...first, image: overrides.fromImage };
      }
    }
    if (overrides.toImage) {
      const lastIndex = path.length - 1;
      const last = path[lastIndex];
      if (last) {
        path[lastIndex] = { ...last, image: overrides.toImage };
      }
    }
    return {
      ...scenario,
      path,
      ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    };
  });
}

export type { AssertionConfig };
