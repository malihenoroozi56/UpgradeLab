import { EXIT_CODES, PLUGIN_API_VERSION, TOOL_NAME, TOOL_VERSION } from '@upgradelab/contracts';
import type { Ui } from '../ui.js';

export interface VersionInfo {
  readonly name: string;
  readonly version: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly pluginApiVersion: number;
  readonly configSchemaVersion: number;
  readonly reportSchemaVersion: number;
}

export function getVersionInfo(): VersionInfo {
  return {
    name: TOOL_NAME,
    version: TOOL_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pluginApiVersion: PLUGIN_API_VERSION,
    configSchemaVersion: 1,
    reportSchemaVersion: 1,
  };
}

export function executeVersion(ui: Ui): VersionInfo {
  const info = getVersionInfo();
  if (ui.json) {
    ui.line(JSON.stringify({ ok: true, ...info }, null, 2));
  } else {
    ui.line(`${info.name} ${info.version}`);
    ui.line(`node ${info.node} (${info.platform}/${info.arch})`);
    ui.line(
      `plugin api v${info.pluginApiVersion}, config schema v${info.configSchemaVersion}, report schema v${info.reportSchemaVersion}`,
    );
  }
  return info;
}

export { EXIT_CODES };
