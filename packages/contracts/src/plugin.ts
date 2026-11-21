import type { AssertionConfig } from './config.js';
import type { AssertionHandler } from './assertion.js';
import type { DatabaseAdapter } from './database.js';
import type { EnvironmentProvider } from './provider.js';
import type { ReportFormat, Reporter } from './report.js';
import type { StructuredLogger } from './execution.js';

/** Version of the plugin API implemented by this release. */
export type PluginApiVersion = 1;

export type PluginKind = 'assertion' | 'database-adapter' | 'environment-provider' | 'reporter';

export interface PluginRegistration {
  /** Adds a custom assertion type. Built-in type names may not be overridden. */
  registerAssertion(handler: AssertionHandler): void;
  /** Adds a database adapter. */
  registerDatabaseAdapter(adapter: DatabaseAdapter): void;
  /** Adds an environment provider for `environment.provider`. */
  registerEnvironmentProvider(provider: EnvironmentProvider): void;
  /** Adds a report format. `format` is the value passed to `--format`. */
  registerReporter(format: string, reporter: Reporter): void;
  readonly logger: StructuredLogger;
}

/**
 * Plugin contract.
 *
 * Plugins are loaded only from explicit, operator-controlled ES module paths
 * (CLI `--plugin` or `security.allowConfigPlugins: true`). UpgradeLab never
 * fetches plugins from the network and never evaluates plugin code from
 * imported remote configuration.
 */
export interface UpgradeLabPlugin {
  readonly name: string;
  readonly version: string;
  readonly apiVersion: PluginApiVersion;
  readonly description?: string;
  /** Called once during plugin loading. Must be synchronous and side-effect free. */
  readonly register: (
    registry: PluginRegistration,
    config?: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface LoadedPlugin {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly kinds: readonly PluginKind[];
  readonly file: string;
}

export interface PluginLoadOptions {
  /** Absolute path of the configuration file, used for relative plugin paths. */
  readonly configDirectory?: string;
  readonly logger: StructuredLogger;
  /** Configuration for each plugin, keyed by resolved plugin path. */
  readonly pluginConfig?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** When false, plugin paths outside the project root are rejected. */
  readonly allowOutsideProjectRoot?: boolean;
  readonly projectRoot?: string;
}

export interface PluginRegistrySnapshot {
  readonly assertions: ReadonlyMap<string, AssertionHandler>;
  readonly databaseAdapters: ReadonlyMap<string, DatabaseAdapter>;
  readonly environmentProviders: ReadonlyMap<string, EnvironmentProvider>;
  readonly reporters: ReadonlyMap<string, Reporter>;
}

export type { AssertionConfig, ReportFormat };
export type { EnvironmentProvider, DatabaseAdapter };
