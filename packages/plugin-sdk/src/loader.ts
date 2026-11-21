import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BUILTIN_ASSERTION_TYPES,
  PLUGIN_API_VERSION,
  UpgradeLabError,
  type AssertionHandler,
  type AssertionHandlerRegistration,
  type DatabaseAdapter,
  type EnvironmentProvider,
  type LoadedPlugin,
  type PluginKind,
  type PluginRegistration,
  type Reporter,
  type StructuredLogger,
  type UpgradeLabPlugin,
} from '@upgradelab/contracts';

const ASSERTION_TYPE_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const REPORT_FORMAT_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

const BUILTIN_ASSERTION_TYPE_SET = new Set<string>(BUILTIN_ASSERTION_TYPES);
const BUILTIN_REPORT_FORMATS = new Set(['json', 'markdown', 'junit']);

export interface PluginReference {
  readonly path: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface PluginLoadOptions {
  readonly logger: StructuredLogger;
  /** Base directory for relative plugin paths (usually the config directory). */
  readonly configDirectory?: string;
  /** Per-plugin configuration, keyed by the plugin reference path. */
  readonly pluginConfig?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** When set, plugin files must resolve inside this directory. */
  readonly projectRoot?: string;
  /** Explicit CLI plugins are operator-controlled; config plugins are not. */
  readonly allowOutsideProjectRoot?: boolean;
}

export interface PluginLoadResult {
  readonly loaded: readonly LoadedPlugin[];
  readonly assertionHandlers: readonly AssertionHandlerRegistration[];
  readonly databaseAdapters: readonly DatabaseAdapter[];
  readonly environmentProviders: readonly EnvironmentProvider[];
  readonly reporters: readonly Reporter[];
}

function pluginError(
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): UpgradeLabError {
  return new UpgradeLabError(message, {
    code: 'PLUGIN_INVALID',
    details,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function validatePluginShape(candidate: unknown, source: string): UpgradeLabPlugin {
  if (candidate === null || typeof candidate !== 'object') {
    throw pluginError(`Plugin ${source} must export a plugin object.`, { source });
  }
  const plugin = candidate as Partial<UpgradeLabPlugin>;
  if (typeof plugin.name !== 'string' || plugin.name.trim().length === 0) {
    throw pluginError(`Plugin ${source} is missing a valid "name".`, { source });
  }
  if (typeof plugin.version !== 'string' || plugin.version.trim().length === 0) {
    throw pluginError(`Plugin ${source} is missing a valid "version".`, { source });
  }
  if (plugin.apiVersion !== PLUGIN_API_VERSION) {
    throw pluginError(
      `Plugin ${plugin.name} targets API version ${String(plugin.apiVersion)} but this UpgradeLab release implements ${PLUGIN_API_VERSION}.`,
      { source, plugin: plugin.name, expected: PLUGIN_API_VERSION, actual: plugin.apiVersion },
    );
  }
  if (typeof plugin.register !== 'function') {
    throw pluginError(`Plugin ${plugin.name} must export a "register" function.`, {
      source,
      plugin: plugin.name,
    });
  }
  return plugin as UpgradeLabPlugin;
}

interface Registries {
  readonly assertions: Map<string, AssertionHandlerRegistration>;
  readonly adapters: Map<string, DatabaseAdapter>;
  readonly providers: Map<string, EnvironmentProvider>;
  readonly reporters: Map<string, Reporter>;
}

function createScopedRegistration(
  plugin: UpgradeLabPlugin,
  registries: Registries,
  kinds: Set<PluginKind>,
  logger: StructuredLogger,
): PluginRegistration {
  return {
    logger,
    registerAssertion(handler: AssertionHandler) {
      if (typeof handler?.type !== 'string' || !ASSERTION_TYPE_PATTERN.test(handler.type)) {
        throw pluginError(
          `Plugin ${plugin.name} registered an assertion with an invalid type "${String(handler?.type)}".`,
          { plugin: plugin.name },
        );
      }
      if (BUILTIN_ASSERTION_TYPE_SET.has(handler.type)) {
        throw new UpgradeLabError(
          `Plugin ${plugin.name} attempted to override built-in assertion type "${handler.type}".`,
          {
            code: 'PLUGIN_DUPLICATE',
            details: { plugin: plugin.name, type: handler.type },
            hint: 'Choose a unique assertion type such as "mysql-count".',
          },
        );
      }
      if (typeof handler.execute !== 'function') {
        throw pluginError(`Assertion handler "${handler.type}" must implement execute().`, {
          plugin: plugin.name,
        });
      }
      if (registries.assertions.has(handler.type)) {
        throw new UpgradeLabError(`Assertion type "${handler.type}" is already registered.`, {
          code: 'PLUGIN_DUPLICATE',
          details: { plugin: plugin.name, type: handler.type },
        });
      }
      registries.assertions.set(handler.type, { handler });
      kinds.add('assertion');
      logger.debug('Plugin registered assertion.', { plugin: plugin.name, type: handler.type });
    },
    registerDatabaseAdapter(adapter: DatabaseAdapter) {
      if (typeof adapter?.id !== 'string' || !ADAPTER_ID_PATTERN.test(adapter.id)) {
        throw pluginError(
          `Plugin ${plugin.name} registered a database adapter with an invalid id.`,
          { plugin: plugin.name },
        );
      }
      if (
        typeof adapter.connect !== 'function' ||
        typeof adapter.validateReadOnlyQuery !== 'function'
      ) {
        throw pluginError(
          `Database adapter "${adapter.id}" must implement connect() and validateReadOnlyQuery().`,
          { plugin: plugin.name },
        );
      }
      if (registries.adapters.has(adapter.id)) {
        throw new UpgradeLabError(`Database adapter "${adapter.id}" is already registered.`, {
          code: 'PLUGIN_DUPLICATE',
          details: { plugin: plugin.name, adapter: adapter.id },
        });
      }
      registries.adapters.set(adapter.id, adapter);
      kinds.add('database-adapter');
      logger.debug('Plugin registered database adapter.', {
        plugin: plugin.name,
        adapter: adapter.id,
      });
    },
    registerEnvironmentProvider(provider: EnvironmentProvider) {
      if (typeof provider?.id !== 'string' || provider.id.trim().length === 0) {
        throw pluginError(
          `Plugin ${plugin.name} registered an environment provider with an invalid id.`,
          { plugin: plugin.name },
        );
      }
      if (
        typeof provider.createEnvironment !== 'function' ||
        typeof provider.destroyEnvironment !== 'function'
      ) {
        throw pluginError(
          `Environment provider "${provider.id}" must implement createEnvironment() and destroyEnvironment().`,
          { plugin: plugin.name },
        );
      }
      if (registries.providers.has(provider.id)) {
        throw new UpgradeLabError(`Environment provider "${provider.id}" is already registered.`, {
          code: 'PLUGIN_DUPLICATE',
          details: { plugin: plugin.name, provider: provider.id },
        });
      }
      registries.providers.set(provider.id, provider);
      kinds.add('environment-provider');
      logger.debug('Plugin registered environment provider.', {
        plugin: plugin.name,
        provider: provider.id,
      });
    },
    registerReporter(format: string, reporter: Reporter) {
      if (!REPORT_FORMAT_PATTERN.test(format)) {
        throw pluginError(
          `Plugin ${plugin.name} registered an invalid report format "${format}".`,
          {
            plugin: plugin.name,
          },
        );
      }
      if (BUILTIN_REPORT_FORMATS.has(format)) {
        throw new UpgradeLabError(`Report format "${format}" is reserved.`, {
          code: 'PLUGIN_DUPLICATE',
          details: { plugin: plugin.name, format },
          hint: 'Plugin reporters must use a unique format name.',
        });
      }
      if (registries.reporters.has(format)) {
        throw new UpgradeLabError(`Report format "${format}" is already registered.`, {
          code: 'PLUGIN_DUPLICATE',
          details: { plugin: plugin.name, format },
        });
      }
      if (typeof reporter?.render !== 'function') {
        throw pluginError(`Reporter "${format}" must implement render().`, { plugin: plugin.name });
      }
      registries.reporters.set(format, { ...reporter, format });
      kinds.add('reporter');
      logger.debug('Plugin registered report format.', { plugin: plugin.name, format });
    },
  };
}

function resolvePluginFile(reference: string, options: PluginLoadOptions): string {
  const base = options.configDirectory ?? process.cwd();
  const resolved = reference.startsWith('file:')
    ? fileURLToPath(reference)
    : path.resolve(base, reference);
  const extension = path.extname(resolved);
  if (extension !== '.js' && extension !== '.mjs') {
    throw new UpgradeLabError(
      `Plugin path "${reference}" is not a compiled ES module (.js or .mjs).`,
      {
        code: 'PLUGIN_LOAD_FAILED',
        details: { reference, resolved },
        hint: 'Plugins are loaded as ES modules; build TypeScript plugins before loading them.',
      },
    );
  }
  if (options.projectRoot && options.allowOutsideProjectRoot === false) {
    const root = path.resolve(options.projectRoot);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new UpgradeLabError(
        `Plugin path "${resolved}" is outside the project root and plugin loading outside the project is disabled.`,
        {
          code: 'PLUGIN_UNTRUSTED_PATH',
          details: { resolved, projectRoot: root },
          hint: 'Place the plugin inside the repository or pass --allow-external-plugins explicitly.',
        },
      );
    }
  }
  return resolved;
}

/** Validates that a plugin file exists and is readable before importing it. */
async function assertPluginFile(resolved: string, reference: string): Promise<void> {
  try {
    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new Error('not a regular file');
    }
  } catch (error) {
    throw new UpgradeLabError(`Plugin file not found: ${resolved}`, {
      code: 'PLUGIN_LOAD_FAILED',
      details: { reference, resolved },
      cause: error,
      hint: 'Build the plugin and check --plugin path.',
    });
  }
}

/**
 * Loads explicitly referenced plugins.
 *
 * UpgradeLab never discovers plugins automatically, never downloads them and
 * never evaluates plugin code from imported remote configuration.
 */
export async function loadPlugins(
  references: readonly PluginReference[],
  options: PluginLoadOptions,
): Promise<PluginLoadResult> {
  const registries: Registries = {
    assertions: new Map(),
    adapters: new Map(),
    providers: new Map(),
    reporters: new Map(),
  };
  const loaded: LoadedPlugin[] = [];
  const seenFiles = new Set<string>();

  for (const reference of references) {
    const resolved = resolvePluginFile(reference.path, options);
    if (seenFiles.has(resolved)) {
      throw new UpgradeLabError(`Plugin "${reference.path}" was loaded twice.`, {
        code: 'PLUGIN_DUPLICATE',
        details: { path: resolved },
      });
    }
    seenFiles.add(resolved);
    await assertPluginFile(resolved, reference.path);

    let module: Record<string, unknown>;
    try {
      module = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
    } catch (error) {
      throw new UpgradeLabError(
        `Failed to import plugin ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
        {
          code: 'PLUGIN_LOAD_FAILED',
          details: { reference: reference.path, resolved },
          cause: error,
        },
      );
    }

    const candidate = module['default'] ?? module['plugin'];
    const plugin = validatePluginShape(candidate, resolved);
    const kinds = new Set<PluginKind>();
    const config = reference.config ?? options.pluginConfig?.[reference.path] ?? undefined;
    try {
      plugin.register(createScopedRegistration(plugin, registries, kinds, options.logger), config);
    } catch (error) {
      if (error instanceof UpgradeLabError) {
        throw error;
      }
      throw new UpgradeLabError(
        `Plugin ${plugin.name} failed during registration: ${error instanceof Error ? error.message : String(error)}`,
        {
          code: 'PLUGIN_LOAD_FAILED',
          details: { plugin: plugin.name, resolved },
          cause: error,
        },
      );
    }
    loaded.push({
      name: plugin.name,
      version: plugin.version,
      path: reference.path,
      file: resolved,
      kinds: [...kinds].sort(),
    });
    options.logger.info('Plugin loaded.', {
      plugin: plugin.name,
      version: plugin.version,
      kinds: [...kinds],
    });
  }

  return {
    loaded,
    assertionHandlers: [...registries.assertions.values()],
    databaseAdapters: [...registries.adapters.values()],
    environmentProviders: [...registries.providers.values()],
    reporters: [...registries.reporters.values()],
  };
}
