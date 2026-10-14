import { settingsBlockSpecFor } from '../../server/core/settings-block-core.ts';
import type { SettingsBlockSpec } from '../../server/core/settings-block-core.ts';
import { ConfigUpdate } from '../../shared/contracts/config.ts';

function specAllows(spec: SettingsBlockSpec, parts: readonly string[]): boolean {
  if (parts.length === 0) return true;
  const [key, ...remaining] = parts;
  if (remaining.length === 0) return spec.booleans.includes(key) || Object.hasOwn(spec.values ?? {}, key);
  const block = spec.blocks[key];
  if (!block) return false;
  return specAllows(block, remaining);
}

function settableFromDashboard(settingPath: string): boolean {
  const [topLevel, ...remaining] = settingPath.split('.');
  if (!Object.hasOwn(ConfigUpdate.shape, topLevel)) return false;
  return specAllows(settingsBlockSpecFor(topLevel), remaining);
}

export { settableFromDashboard, specAllows };
