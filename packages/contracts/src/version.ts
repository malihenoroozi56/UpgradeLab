/**
 * Version constants for every public, versioned surface of UpgradeLab.
 *
 * Changing any of these is a breaking change and requires an ADR plus a
 * migration note in the documentation. See docs/configuration/migration.md.
 */

/** Version of the `upgradelab.yaml` configuration document. */
export const CONFIG_SCHEMA_VERSION = 1 as const;

/** Version of the JSON execution report document. */
export const REPORT_SCHEMA_VERSION = 1 as const;

/** Version of the plugin API (`plugin.apiVersion`). */
export const PLUGIN_API_VERSION = 1 as const;

/** Version reported by `upgradelab version`. Kept in sync with package.json by scripts/sync-version.mjs. */
export const TOOL_VERSION = '1.0.0-dev.0';

export const TOOL_NAME = 'upgradelab';
