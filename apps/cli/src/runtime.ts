import path from 'node:path';
import {
  createRedactor,
  UpgradeLabError,
  type DatabaseAdapter,
  type EnvironmentProvider,
  type Redactor,
  type StructuredLogger,
  type UpgradeLabConfig,
} from '@upgradelab/contracts';
import { loadConfig, type LoadedConfig } from '@upgradelab/config';
import { createLogger, createNullLogger, type LogLevel } from '@upgradelab/core';
import { createCheckRunner, type CheckRunnerInstance } from '@upgradelab/assertion-engine';
import { createPostgresAdapter } from '@upgradelab/database-postgres';
import { createDockerComposeProvider } from '@upgradelab/docker-compose-provider';
import { createReporterRegistry, type ReporterRegistry } from '@upgradelab/reporters';
import { loadPlugins, type PluginLoadResult } from '@upgradelab/plugin-sdk';

export interface RuntimeOptions {
  readonly cwd: string;
  readonly configPath?: string;
  readonly pluginPaths: readonly string[];
  readonly logLevel: LogLevel;
}

export interface Runtime {
  readonly config: UpgradeLabConfig;
  readonly loaded: LoadedConfig;
  readonly logger: StructuredLogger;
  readonly redactor: Redactor;
  readonly plugins: PluginLoadResult;
  readonly reporters: ReporterRegistry;
  readonly provider: EnvironmentProvider;
  readonly databaseAdapter: DatabaseAdapter | undefined;
  readonly checkRunner: CheckRunnerInstance;
}

/** Loads configuration, plugins and runtime components in dependency order. */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const loaded = await loadConfig({
    cwd: options.cwd,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });
  const redactor = createRedactor({ secrets: loaded.secrets });
  const logger = createLogger({
    level: options.logLevel,
    redactor,
    bindings: { config: loaded.configPath },
  });
  for (const warning of loaded.warnings) {
    logger.warn(warning);
  }

  const configReferences = loaded.config.plugins.map((plugin) => ({
    path: plugin.path,
    ...(plugin.config ? { config: plugin.config } : {}),
  }));
  const cliReferences = options.pluginPaths.map((pluginPath) => ({
    path: path.resolve(options.cwd, pluginPath),
  }));
  const pluginConfig: Record<string, Record<string, unknown>> = {};
  for (const plugin of loaded.config.plugins) {
    if (plugin.config) {
      pluginConfig[plugin.path] = { ...plugin.config };
    }
  }

  const plugins = await loadPlugins([...configReferences, ...cliReferences], {
    logger,
    configDirectory: loaded.configDirectory,
    pluginConfig,
    projectRoot: loaded.configDirectory,
    allowOutsideProjectRoot: true,
  });

  const reporters = createReporterRegistry(plugins.reporters);
  const adapters = new Map<string, DatabaseAdapter>();
  adapters.set('postgres', createPostgresAdapter());
  for (const adapter of plugins.databaseAdapters) {
    if (adapters.has(adapter.id)) {
      throw new UpgradeLabError(`Database adapter "${adapter.id}" is already registered.`, {
        code: 'PLUGIN_DUPLICATE',
        details: { adapter: adapter.id },
      });
    }
    adapters.set(adapter.id, adapter);
  }

  const providers = new Map<string, EnvironmentProvider>();
  providers.set(
    'docker-compose',
    createDockerComposeProvider({
      composeFile: loaded.composeFile,
      projectDirectory: loaded.projectDirectory,
      composeEnv: loaded.config.environment.composeEnv,
      security: loaded.config.security,
      environment: loaded.config.environment,
      defaults: loaded.config.defaults,
    }),
  );
  for (const provider of plugins.environmentProviders) {
    if (providers.has(provider.id)) {
      throw new UpgradeLabError(`Environment provider "${provider.id}" is already registered.`, {
        code: 'PLUGIN_DUPLICATE',
        details: { provider: provider.id },
      });
    }
    providers.set(provider.id, provider);
  }

  const providerId = loaded.config.environment.provider;
  const provider = providers.get(providerId);
  if (!provider) {
    throw new UpgradeLabError(
      `Environment provider "${providerId}" is not available in this build or any loaded plugin.`,
      {
        code: 'CONFIG_VALIDATION_ERROR',
        details: { provider: providerId, available: [...providers.keys()] },
        hint: `Use one of: ${[...providers.keys()].join(', ')}, or load a plugin that registers it.`,
      },
    );
  }

  let databaseAdapter: DatabaseAdapter | undefined;
  if (loaded.config.environment.database) {
    const adapterId = loaded.config.environment.database.adapter;
    databaseAdapter = adapters.get(adapterId);
    if (!databaseAdapter) {
      throw new UpgradeLabError(
        `Database adapter "${adapterId}" is not available in this build or any loaded plugin.`,
        {
          code: 'CONFIG_VALIDATION_ERROR',
          details: { adapter: adapterId, available: [...adapters.keys()] },
          hint: `Use one of: ${[...adapters.keys()].join(', ')}, or load a plugin that registers it.`,
        },
      );
    }
  }

  const checkRunner = createCheckRunner({
    assertionHandlers: plugins.assertionHandlers,
  });

  return {
    config: loaded.config,
    loaded,
    logger,
    redactor,
    plugins,
    reporters,
    provider,
    databaseAdapter,
    checkRunner,
  };
}

/**
 * Loads enough of the runtime to run `doctor` without requiring a valid
 * configuration: missing configuration is reported, not fatal.
 */
export async function tryCreateRuntime(
  options: RuntimeOptions,
): Promise<
  { ok: true; runtime: Runtime } | { ok: false; error: unknown; logger: StructuredLogger }
> {
  try {
    return { ok: true, runtime: await createRuntime(options) };
  } catch (error) {
    return {
      ok: false,
      error,
      logger: createNullLogger(),
    };
  }
}
