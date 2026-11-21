import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UpgradeLabError } from '@upgradelab/contracts';
import { loadPlugins, validatePluginShape } from '@upgradelab/plugin-sdk';
import csvReporterPlugin from '@upgradelab/plugin-example-csv-reporter';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.resolve(here, '../fixtures/plugins');
const validPath = path.join(fixtureDirectory, 'valid.mjs');

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

async function load(
  references: { path: string; config?: Record<string, unknown> }[],
  options = {},
) {
  return loadPlugins(references, { logger, ...options });
}

describe('plugin loading', () => {
  it('loads an explicit plugin and exposes its scoped registrations', async () => {
    const result = await load([{ path: validPath }]);
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]).toMatchObject({
      name: 'fixture-plugin',
      version: '1.2.3',
      kinds: ['assertion', 'reporter'],
    });
    expect(result.assertionHandlers.map((entry) => entry.handler.type)).toEqual(['fixture-check']);
    expect(result.reporters.map((reporter) => reporter.format)).toEqual(['fixture-text']);
    expect(result.databaseAdapters).toEqual([]);
    expect(result.environmentProviders).toEqual([]);
  });

  it('supports file: URLs and relative paths', async () => {
    const fromUrl = await load([{ path: pathToFileURL(validPath).href }]);
    expect(fromUrl.loaded[0]?.name).toBe('fixture-plugin');
    const relative = await load([{ path: './valid.mjs' }], { configDirectory: fixtureDirectory });
    expect(relative.loaded[0]?.name).toBe('fixture-plugin');
  });

  it('rejects non-module paths', async () => {
    await expect(load([{ path: 'plugin.ts' }])).rejects.toMatchObject({
      code: 'PLUGIN_LOAD_FAILED',
    });
  });

  it('rejects missing plugin files', async () => {
    await expect(load([{ path: './does-not-exist.mjs' }])).rejects.toMatchObject({
      code: 'PLUGIN_LOAD_FAILED',
    });
  });

  it('enforces the plugin API version', async () => {
    await expect(
      load([{ path: path.join(fixtureDirectory, 'wrong-api.mjs') }]),
    ).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
  });

  it('never allows built-in assertion types to be replaced', async () => {
    await expect(
      load([{ path: path.join(fixtureDirectory, 'duplicate-builtin.mjs') }]),
    ).rejects.toMatchObject({ code: 'PLUGIN_DUPLICATE' });
  });

  it('reports plugin registration failures with context', async () => {
    try {
      await load([{ path: path.join(fixtureDirectory, 'throws.mjs') }]);
      throw new Error('expected failure');
    } catch (error) {
      const typed = error as UpgradeLabError;
      expect(typed.code).toBe('PLUGIN_LOAD_FAILED');
      expect(typed.message).toContain('throwing-plugin');
      expect(typed.message).toContain('registration exploded');
    }
  });

  it('rejects loading the same file twice', async () => {
    await expect(
      load([
        { path: path.join(fixtureDirectory, 'double-load.mjs') },
        { path: path.join(fixtureDirectory, 'double-load.mjs') },
      ]),
    ).rejects.toMatchObject({ code: 'PLUGIN_DUPLICATE' });
  });

  it('blocks plugins outside the project root unless explicitly allowed', async () => {
    const projectRoot = path.join(fixtureDirectory, 'nested');
    await expect(
      load([{ path: validPath }], {
        projectRoot,
        allowOutsideProjectRoot: false,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_UNTRUSTED_PATH' });
    const allowed = await load([{ path: validPath }], {
      projectRoot,
      allowOutsideProjectRoot: true,
    });
    expect(allowed.loaded).toHaveLength(1);
  });

  it('validates plugin shape independently of loading', () => {
    expect(() =>
      validatePluginShape({ name: 'x', version: '1', apiVersion: 1 }, 'inline'),
    ).toThrowError(/register/);
    expect(() => validatePluginShape(null, 'inline')).toThrowError(/plugin object/);
    expect(() =>
      validatePluginShape({ name: '', version: '1', apiVersion: 1, register: () => {} }, 'inline'),
    ).toThrowError(/name/);
  });

  it('exposes the example plugin as a typed module', () => {
    expect(csvReporterPlugin.name).toBe('csv-reporter');
    expect(csvReporterPlugin.apiVersion).toBe(1);
    const registered: string[] = [];
    csvReporterPlugin.register({
      logger,
      registerAssertion: () => undefined,
      registerDatabaseAdapter: () => undefined,
      registerEnvironmentProvider: () => undefined,
      registerReporter: (format: string) => {
        registered.push(format);
      },
    });
    expect(registered).toEqual(['csv']);
  });
});
