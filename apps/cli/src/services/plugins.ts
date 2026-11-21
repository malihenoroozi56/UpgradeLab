import path from 'node:path';
import { EXIT_CODES, isUpgradeLabError, type LoadedPlugin } from '@upgradelab/contracts';
import { loadConfig } from '@upgradelab/config';
import { createLogger, createNullLogger } from '@upgradelab/core';
import { createRedactor } from '@upgradelab/contracts';
import { builtinAssertionHandlers } from '@upgradelab/assertion-engine';
import { createReporterRegistry } from '@upgradelab/reporters';
import { loadPlugins } from '@upgradelab/plugin-sdk';
import { renderTable, type Ui } from '../ui.js';

export interface PluginListFlags {
  readonly cwd: string;
  readonly configPath?: string;
  readonly pluginPaths: readonly string[];
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export interface PluginListOutcome {
  readonly exitCode: number;
  readonly plugins: readonly LoadedPlugin[];
  readonly assertionTypes: readonly string[];
  readonly reportFormats: readonly string[];
}

/** Lists plugins that would be loaded for the given configuration and flags. */
export async function executePluginList(
  flags: PluginListFlags,
  ui: Ui,
): Promise<PluginListOutcome> {
  let configReferences: { path: string; config?: Record<string, unknown> }[] = [];
  let configDirectory = flags.cwd;
  let logger = createNullLogger();
  try {
    const loaded = await loadConfig({
      cwd: flags.cwd,
      ...(flags.configPath ? { configPath: flags.configPath } : {}),
    });
    configDirectory = loaded.configDirectory;
    configReferences = loaded.config.plugins.map((plugin) => ({
      path: plugin.path,
      ...(plugin.config ? { config: plugin.config } : {}),
    }));
    logger = createLogger({
      level: flags.logLevel,
      redactor: createRedactor({ secrets: loaded.secrets }),
    });
  } catch (error) {
    if (!(isUpgradeLabError(error) && error.code === 'CONFIG_NOT_FOUND')) {
      throw error;
    }
  }

  const cliReferences = flags.pluginPaths.map((pluginPath) => ({
    path: path.resolve(flags.cwd, pluginPath),
  }));
  const loadedPlugins = await loadPlugins([...configReferences, ...cliReferences], {
    logger,
    configDirectory,
    allowOutsideProjectRoot: true,
  });

  const pluginAssertions = loadedPlugins.assertionHandlers.map(
    (registration) => registration.handler.type,
  );
  const assertionTypes = [
    ...builtinAssertionHandlers.map((handler) => handler.type),
    ...pluginAssertions,
  ].sort();
  const reportFormats = createReporterRegistry(loadedPlugins.reporters).list();

  if (ui.json) {
    ui.line(
      JSON.stringify(
        {
          ok: true,
          plugins: loadedPlugins.loaded,
          assertionTypes,
          reportFormats,
        },
        null,
        2,
      ),
    );
  } else {
    ui.heading('Loaded plugins');
    if (loadedPlugins.loaded.length === 0) {
      ui.line('  (none)');
    } else {
      ui.line(
        renderTable(
          loadedPlugins.loaded.map((plugin) => [
            plugin.name,
            plugin.version,
            plugin.kinds.join(', ') || 'none',
            plugin.file,
          ]),
          ['Name', 'Version', 'Registers', 'Path'],
        ),
      );
    }
    ui.line('');
    ui.line(
      `Built-in assertion types: ${builtinAssertionHandlers.map((handler) => handler.type).join(', ')}`,
    );
    if (pluginAssertions.length > 0) {
      ui.line(`Plugin assertion types:  ${pluginAssertions.join(', ')}`);
    }
    ui.line(`Report formats:           ${reportFormats.join(', ')}`);
  }

  return {
    exitCode: EXIT_CODES.OK,
    plugins: loadedPlugins.loaded,
    assertionTypes,
    reportFormats,
  };
}
