import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  CONFIG_SCHEMA_VERSION,
  UpgradeLabError,
  type AssertionConfig,
} from '@upgradelab/contracts';
import {
  applyOverrides,
  parseConfigText,
  renderInitConfig,
  selectScenarios,
} from '@upgradelab/config';
import { buildConfigYaml } from '../helpers/test-runtime.js';

function mutate(yaml: string, mutate: (document: Record<string, unknown>) => void): string {
  const document = parseYaml(yaml) as Record<string, unknown>;
  mutate(document);
  return stringifyYaml(document, { lineWidth: 0 });
}

function scenarioOf(document: Record<string, unknown>): Record<string, unknown> {
  const scenarios = document['scenarios'] as Record<string, unknown>[];
  const scenario = scenarios[0];
  if (!scenario) {
    throw new Error('test fixture has no scenario');
  }
  return scenario;
}

function expectConfigError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected configuration error');
  } catch (error) {
    expect(error).toBeInstanceOf(UpgradeLabError);
    expect((error as UpgradeLabError).code).toBe(code);
  }
}

describe('configuration parsing', () => {
  it('applies documented defaults and normalizes from/to into a path', () => {
    const parsed = parseConfigText(buildConfigYaml(), { sourcePath: 'test.yaml' });
    const config = parsed.config;
    expect(config.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(config.environment.resources).toEqual({ memoryLimit: '1g', cpus: 1, pidsLimit: 128 });
    expect(config.environment.application.port).toBe(3000);
    expect(config.environment.network.bindAddress).toBe('127.0.0.1');
    expect(config.defaults.logTailLines).toBe(100);
    expect(config.ai.enabled).toBe(false);
    const scenario = config.scenarios[0];
    expect(scenario?.path).toHaveLength(2);
    expect(scenario?.path[0]?.image).toBe('app:1.0.0');
    expect(scenario?.path[1]?.image).toBe('app:2.0.0');
    expect(scenario?.path[0]?.setup[0]?.command).toEqual(['node', 'scripts/seed.mjs']);
    const health = scenario?.assertions.find(
      (assertion): assertion is Extract<AssertionConfig, { type: 'http' }> =>
        assertion.type === 'http',
    );
    expect(health?.method).toBe('GET');
    expect(health?.expectedStatus).toBe(200);
  });

  it('rejects unknown fields with a precise path', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      (document['project'] as Record<string, unknown>)['unknownField'] = true;
    });
    try {
      parseConfigText(yaml, { sourcePath: 'typo.yaml' });
      throw new Error('expected failure');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).toContain('project');
      expect(message).toContain('Unrecognized key');
      expect((error as UpgradeLabError).code).toBe('CONFIG_VALIDATION_ERROR');
    }
  });

  it('rejects unsupported schema versions with a migration hint', () => {
    const yaml = buildConfigYaml().replace('schemaVersion: 1', 'schemaVersion: 2');
    expectConfigError(
      () => parseConfigText(yaml, { sourcePath: 'future.yaml' }),
      'CONFIG_UNSUPPORTED_VERSION',
    );
  });

  it('reports YAML syntax errors with line information', () => {
    const yaml = 'schemaVersion: 1\nproject:\n  name: [unclosed\n';
    try {
      parseConfigText(yaml, { sourcePath: 'broken.yaml' });
      throw new Error('expected failure');
    } catch (error) {
      expect((error as UpgradeLabError).code).toBe('CONFIG_PARSE_ERROR');
      expect((error as Error).message).toContain('broken.yaml');
      expect((error as Error).message).toMatch(/line \d+/);
    }
  });

  it('rejects an empty configuration file', () => {
    expectConfigError(
      () => parseConfigText('\n', { sourcePath: 'empty.yaml' }),
      'CONFIG_PARSE_ERROR',
    );
  });

  it('rejects duplicate scenario ids', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      const scenarios = document['scenarios'] as unknown[];
      scenarios.push(scenarios[0]);
    });
    expectConfigError(
      () => parseConfigText(yaml, { sourcePath: 'duplicate.yaml' }),
      'CONFIG_VALIDATION_ERROR',
    );
  });

  it('rejects mixing path with from/to', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      scenarioOf(document)['path'] = [{ image: 'app:1.0.0' }, { image: 'app:2.0.0' }];
    });
    expectConfigError(
      () => parseConfigText(yaml, { sourcePath: 'mixed.yaml' }),
      'CONFIG_VALIDATION_ERROR',
    );
  });

  it('accepts a single-image fresh-install path', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      const scenario = scenarioOf(document);
      delete scenario['from'];
      delete scenario['to'];
      scenario['path'] = [{ image: 'app:2.0.0' }];
    });
    const parsed = parseConfigText(yaml, { sourcePath: 'fresh.yaml' });
    expect(parsed.config.scenarios[0]?.path).toHaveLength(1);
  });

  it('supports custom assertion types as plugin parameters', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      const scenario = scenarioOf(document);
      const assertions = scenario['assertions'] as unknown[];
      assertions.push({ id: 'custom-check', type: 'my-check', rows: 3, mode: 'strict' });
    });
    const parsed = parseConfigText(yaml, { sourcePath: 'custom.yaml' });
    const custom = parsed.config.scenarios[0]?.assertions.find(
      (assertion) => assertion.id === 'custom-check',
    );
    expect(custom?.type).toBe('my-check');
    expect(custom && 'params' in custom ? custom.params : undefined).toEqual({
      rows: 3,
      mode: 'strict',
    });
  });

  it('rejects unknown fields on built-in assertions', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      const assertions = scenarioOf(document)['assertions'] as Record<string, unknown>[];
      const health = assertions.find((assertion) => assertion['id'] === 'application-healthy');
      if (health) {
        health['bogus'] = true;
      }
    });
    expectConfigError(
      () => parseConfigText(yaml, { sourcePath: 'assertion.yaml' }),
      'CONFIG_VALIDATION_ERROR',
    );
  });

  it('infers "equal" when an expected value is supplied', () => {
    const parsed = parseConfigText(buildConfigYaml(), { sourcePath: 'infer.yaml' });
    const invariant = parsed.config.scenarios[0]?.invariants.find(
      (entry) => entry.id === 'email-column-present',
    );
    expect(invariant?.comparison).toBe('equal');
    expect(invariant?.expected).toBe(1);
    const baseline = parsed.config.scenarios[0]?.invariants.find(
      (entry) => entry.id === 'users-preserved',
    );
    expect(baseline?.comparison).toBe('equal-before-after');
  });

  it('rejects SQL invariants without a configured database', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      delete (document['environment'] as Record<string, unknown>)['database'];
    });
    expectConfigError(
      () => parseConfigText(yaml, { sourcePath: 'nodb.yaml' }),
      'CONFIG_VALIDATION_ERROR',
    );
  });

  it('requires explicit consent for non-loopback port binding', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      const environment = document['environment'] as Record<string, unknown>;
      environment['network'] = { bindAddress: '0.0.0.0' };
    });
    expectConfigError(
      () => parseConfigText(yaml, { sourcePath: 'exposed.yaml' }),
      'CONFIG_VALIDATION_ERROR',
    );
    const allowed = mutate(yaml, (document) => {
      document['security'] = { allowNonLoopbackPorts: true };
    });
    const parsed = parseConfigText(allowed, { sourcePath: 'exposed.yaml' });
    expect(parsed.config.environment.network.bindAddress).toBe('0.0.0.0');
  });

  it('refuses to load config plugins without explicit opt-in', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      document['plugins'] = [{ path: './plugin.mjs' }];
    });
    expectConfigError(
      () => parseConfigText(yaml, { sourcePath: 'plugins.yaml' }),
      'CONFIG_UNSAFE_PLUGIN_LOAD',
    );
  });

  it('resolves environment references and collects secret values', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      const environment = document['environment'] as Record<string, unknown>;
      const database = environment['database'] as Record<string, unknown>;
      database['password'] = '${DB_PASSWORD}';
    });
    const parsed = parseConfigText(yaml, {
      sourcePath: 'secrets.yaml',
      env: { DB_PASSWORD: 'sup3r-s3cret-value' },
    });
    expect(parsed.config.environment.database?.password).toBe('sup3r-s3cret-value');
    expect(parsed.secrets).toContain('sup3r-s3cret-value');
  });

  it('fails on missing environment references and supports defaults', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      const environment = document['environment'] as Record<string, unknown>;
      const database = environment['database'] as Record<string, unknown>;
      database['password'] = '${MISSING_SECRET}';
    });
    expectConfigError(
      () => parseConfigText(yaml, { sourcePath: 'missing.yaml', env: {} }),
      'CONFIG_SECRET_UNRESOLVED',
    );
    const withDefault = yaml.replace('${MISSING_SECRET}', '${MISSING_SECRET:-fallback-value}');
    const parsed = parseConfigText(withDefault, { sourcePath: 'missing.yaml', env: {} });
    expect(parsed.config.environment.database?.password).toBe('fallback-value');
  });

  it('escapes dollar references with $$', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      const environment = document['environment'] as Record<string, unknown>;
      const application = environment['application'] as Record<string, unknown>;
      application['port'] = 3000;
      (document['project'] as Record<string, unknown>)['description'] = 'literal $${HOME}';
    });
    const parsed = parseConfigText(yaml, { sourcePath: 'escape.yaml', env: {} });
    expect(parsed.config.project.description).toBe('literal ${HOME}');
  });

  it('rejects invalid memory limits', () => {
    const yaml = mutate(buildConfigYaml(), (document) => {
      const environment = document['environment'] as Record<string, unknown>;
      const resources = environment['resources'] as Record<string, unknown>;
      resources['memoryLimit'] = '1x';
    });
    expectConfigError(
      () => parseConfigText(yaml, { sourcePath: 'memory.yaml' }),
      'CONFIG_VALIDATION_ERROR',
    );
  });

  it('parses the init template', () => {
    const parsed = parseConfigText(renderInitConfig({ projectName: 'demo' }), {
      sourcePath: 'init.yaml',
      env: {},
    });
    expect(parsed.config.project.name).toBe('demo');
    expect(parsed.config.scenarios[0]?.id).toBe('upgrade-1-to-2');
  });
});

describe('scenario selection and overrides', () => {
  const parsed = parseConfigText(buildConfigYaml(), { sourcePath: 'select.yaml' });
  const config = parsed.config;

  it('selects every scenario by default and rejects unknown ids', () => {
    expect(selectScenarios(config, [])).toHaveLength(1);
    expect(selectScenarios(config, ['upgrade-1-to-2'])).toHaveLength(1);
    expectConfigError(() => selectScenarios(config, ['missing']), 'CONFIG_VALIDATION_ERROR');
  });

  it('overrides only the first and last image of a path', () => {
    const [scenario] = selectScenarios(config, []);
    if (!scenario) {
      throw new Error('missing scenario');
    }
    const overridden = applyOverrides([scenario], {
      fromImage: 'app:9.0.0',
      toImage: 'app:10.0.0',
      timeoutMs: 1_000,
    });
    expect(overridden[0]?.path.map((step) => step.image)).toEqual(['app:9.0.0', 'app:10.0.0']);
    expect(overridden[0]?.timeoutMs).toBe(1_000);
  });
});
