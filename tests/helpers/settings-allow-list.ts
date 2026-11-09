import { settingsBlockSpecFor } from '../../server/core/settings-block-core.ts';
import type { SettingsBlockSpec } from '../../server/core/settings-block-core.ts';
import { ConfigUpdate } from '../../shared/contracts/config.ts';
import { isRecord } from '../../shared/coerce.ts';
import { SETTINGS_REGISTRY } from '../../shared/settings/registry.ts';
import { settingsOf } from '../../shared/settings/registry-core.ts';

function specAllows(spec: SettingsBlockSpec, parts: readonly string[]): boolean {
  if (parts.length === 0) return true;
  const [key, ...remaining] = parts;
  if (remaining.length === 0) return spec.booleans.includes(key) || Object.hasOwn(spec.values ?? {}, key);
  const block = spec.blocks[key];
  if (!block) return false;
  return specAllows(block, remaining);
}

function registeredSetting(settingPath: string) {
  return [...settingsOf(SETTINGS_REGISTRY.sections), ...SETTINGS_REGISTRY.fileOnly].find((setting) => setting.path === settingPath);
}

function updateSchemaKeeps(settingPath: string): boolean {
  const setting = registeredSetting(settingPath);
  if (!setting || setting.defaultValue === undefined) return true;
  const parts = settingPath.split('.');
  const update = parts.reduceRight<unknown>((value, key) => ({ [key]: value }), setting.defaultValue);
  const parsed = ConfigUpdate.safeParse(update);
  if (!parsed.success) return false;
  const kept = parts.reduce<unknown>((node, key) => (isRecord(node) && Object.hasOwn(node, key) ? node[key] : undefined), parsed.data);
  return kept !== undefined;
}

function settableFromDashboard(settingPath: string): boolean {
  const [topLevel, ...remaining] = settingPath.split('.');
  if (!Object.hasOwn(ConfigUpdate.shape, topLevel)) return false;
  if (!specAllows(settingsBlockSpecFor(topLevel), remaining)) return false;
  return updateSchemaKeeps(settingPath);
}

export { settableFromDashboard };
