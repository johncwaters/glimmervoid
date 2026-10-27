import { isRecord } from '../../shared/coerce.ts';
import { isExperimentalSetting, SETTINGS_REGISTRY } from '../../shared/settings/registry.ts';
import type { SettingsSetting } from '../../shared/settings/registry.ts';
import { settingsOf } from '../../shared/settings/registry-core.ts';

const EXPERIMENTAL_MACHINE_SETTINGS: readonly SettingsSetting[] = settingsOf(SETTINGS_REGISTRY.sections)
  .filter((setting) => setting.scope === 'machine' && isExperimentalSetting(setting));

function replaceAtPath(target: object, [key, ...nestedKeys]: readonly string[], value: unknown): void {
  if (nestedKeys.length === 0) {
    Reflect.set(target, key, value);
    return;
  }
  const child: unknown = Reflect.get(target, key);
  const copiedChild = isRecord(child) ? { ...child } : {};
  Reflect.set(target, key, copiedChild);
  replaceAtPath(copiedChild, nestedKeys, value);
}

function withExperimentalFeaturesGated<T extends object>(config: T, isExperimentalBuild: boolean): T {
  if (isExperimentalBuild) return config;
  const gated = { ...config };
  for (const setting of EXPERIMENTAL_MACHINE_SETTINGS) replaceAtPath(gated, setting.path.split('.'), setting.defaultValue);
  return gated;
}

function isSettingAvailable(setting: Pick<SettingsSetting, 'keywords'>, isExperimentalBuild: boolean): boolean {
  return isExperimentalBuild || !isExperimentalSetting(setting);
}

export { isSettingAvailable, withExperimentalFeaturesGated };
