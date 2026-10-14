import { isRecord } from '../../shared/coerce.ts';
import { cloneValue, settingsOf } from '../../shared/settings/registry-core.ts';
import type { SettingsBlockSpec as SettingsToggleBlockSpec } from '../../shared/settings/registry-core.ts';
import { SETTINGS_REGISTRY } from '../../shared/settings/registry.ts';
import type { SettingsRegistry, SettingsSetting } from '../../shared/settings/registry.ts';

type SettingsValueControl = Exclude<SettingsSetting['control'], 'toggle' | 'readonly'>;

interface SettingsValueSpec {
  control: SettingsValueControl;
  nullable: boolean;
  valueKind?: string;
}

export interface SettingsBlockSpec extends SettingsToggleBlockSpec {
  blocks: Readonly<Record<string, SettingsBlockSpec>>;
  values?: Readonly<Record<string, SettingsValueSpec>>;
  passthrough?: true;
}

interface MutableBlockSpec {
  name: string;
  booleans: string[];
  blocks: Record<string, MutableBlockSpec>;
  values?: Record<string, SettingsValueSpec>;
  passthrough?: true;
}

const SECRET_PRESENCE_SUFFIX = 'Configured';
const NO_VALUES: Readonly<Record<string, SettingsValueSpec>> = Object.freeze({});
const MAX_SETTINGS_VALUE_DEPTH = 32;

function valueSpecOf(setting: SettingsSetting, control: SettingsValueControl): SettingsValueSpec {
  const spec: SettingsValueSpec = { control, nullable: setting.nullable === true };
  if (setting.valueKind) spec.valueKind = setting.valueKind;
  return spec;
}

function freezeSpec(spec: MutableBlockSpec): SettingsBlockSpec {
  for (const nested of Object.values(spec.blocks)) freezeSpec(nested);
  Object.freeze(spec.booleans);
  Object.freeze(spec.blocks);
  if (spec.values) Object.freeze(spec.values);
  return Object.freeze(spec);
}

function buildBlockSpec(topLevelKey: string, registry: SettingsRegistry): SettingsBlockSpec {
  const root: MutableBlockSpec = { name: topLevelKey, booleans: [], blocks: {} };
  const prefix = `${topLevelKey}.`;
  for (const setting of [...settingsOf(registry.sections), ...registry.fileOnly]) {
    const control = setting.control;
    if (control === 'readonly') continue;
    if (setting.path === topLevelKey) {
      root.passthrough = true;
      continue;
    }
    if (!setting.path.startsWith(prefix)) continue;
    const parts = setting.path.slice(prefix.length).split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node.blocks[part] ??= { name: `${node.name}.${part}`, booleans: [], blocks: {} };
      node = node.blocks[part];
    }
    const leaf = parts.at(-1) as string;
    if (control === 'toggle') {
      node.booleans.push(leaf);
      continue;
    }
    node.values ??= {};
    node.values[leaf] = valueSpecOf(setting, control);
  }
  return freezeSpec(root);
}

const registrySpecs = new Map<string, SettingsBlockSpec>();

function settingsBlockSpecFor(topLevelKey: string, registry: SettingsRegistry = SETTINGS_REGISTRY): SettingsBlockSpec {
  if (registry !== SETTINGS_REGISTRY) return buildBlockSpec(topLevelKey, registry);
  const cached = registrySpecs.get(topLevelKey);
  if (cached) return cached;
  const built = buildBlockSpec(topLevelKey, registry);
  registrySpecs.set(topLevelKey, built);
  return built;
}

const INGEST_SPEC: SettingsBlockSpec = settingsBlockSpecFor('ingest');

function isNestedDeeperThan(value: unknown, maxDepth: number): boolean {
  const pending: [node: unknown, depth: number][] = [[value, 0]];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [node, depth] = next;
    if (!node || typeof node !== 'object') continue;
    if (depth >= maxDepth) return true;
    for (const nested of Object.values(node)) pending.push([nested, depth + 1]);
  }
  return false;
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function valueError(path: string, spec: SettingsValueSpec, value: unknown): string | null {
  if (value === null) return spec.nullable ? null : `${path} must not be null`;
  if (isNestedDeeperThan(value, MAX_SETTINGS_VALUE_DEPTH)) return `${path} is nested too deeply`;
  if (spec.valueKind) return null;
  if (spec.control === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : `${path} must be a number`;
  if (spec.control === 'list' || spec.control === 'projects') return isStringArray(value) ? null : `${path} must be an array of strings`;
  if (spec.control === 'json') return isRecord(value) || Array.isArray(value) ? null : `${path} must be an object`;
  return typeof value === 'string' ? null : `${path} must be a string`;
}

function validateSettingsBlock(block: unknown, spec: SettingsBlockSpec): string | null {
  if (block == null) return null;
  if (!isRecord(block)) return `${spec.name} must be an object`;
  const values = spec.values ?? NO_VALUES;
  for (const [key, value] of Object.entries(block)) {
    if (value === undefined) continue;
    if (Object.hasOwn(values, key)) {
      const error = valueError(`${spec.name}.${key}`, values[key], value);
      if (error) return error;
      continue;
    }
    if (value === null) continue;
    if (spec.booleans.includes(key)) {
      if (typeof value !== 'boolean') return `${spec.name}.${key} must be a boolean`;
      continue;
    }
    if (Object.hasOwn(spec.blocks, key)) {
      const error = validateSettingsBlock(value, spec.blocks[key]);
      if (error) return error;
      continue;
    }
    if (!spec.passthrough) return `${spec.name}.${key} is not settable from the dashboard`;
    if (isNestedDeeperThan(value, MAX_SETTINGS_VALUE_DEPTH)) return `${spec.name}.${key} is nested too deeply`;
  }
  return null;
}

function isStoredSecret(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function clonedEntries(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = cloneValue(value);
  }
  return out;
}

function isCopiedIntoPick(key: string, spec: SettingsBlockSpec): boolean {
  const values = spec.values ?? NO_VALUES;
  if (!Object.hasOwn(values, key)) return spec.passthrough === true;
  return values[key].control !== 'password';
}

function pickSettingsBlock(stored: unknown, spec: SettingsBlockSpec, tooDeepPaths: string[] = []): Record<string, unknown> | null {
  if (!isRecord(stored)) return null;
  const tooDeepKeys = Object.keys(stored).filter((key) => isCopiedIntoPick(key, spec) && isNestedDeeperThan(stored[key], MAX_SETTINGS_VALUE_DEPTH));
  tooDeepPaths.push(...tooDeepKeys.map((key) => `${spec.name}.${key}`));
  const pickable = Object.fromEntries(Object.entries(stored).filter(([key]) => !tooDeepKeys.includes(key)));
  const out: Record<string, unknown> = spec.passthrough ? clonedEntries(pickable) : {};
  for (const key of spec.booleans) {
    if (typeof pickable[key] === 'boolean') out[key] = pickable[key];
  }
  for (const [key, value] of Object.entries(spec.values ?? NO_VALUES)) {
    if (value.control === 'password') {
      delete out[key];
      out[`${key}${SECRET_PRESENCE_SUFFIX}`] = isStoredSecret(pickable[key]);
      continue;
    }
    if (pickable[key] !== undefined) out[key] = cloneValue(pickable[key]);
  }
  for (const [key, nested] of Object.entries(spec.blocks)) {
    const picked = pickSettingsBlock(pickable[key], nested, tooDeepPaths);
    if (picked) out[key] = picked;
  }
  return out;
}

function mergeSettingsBlock(stored: unknown, incoming: unknown, spec: SettingsBlockSpec): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(stored) ? { ...stored } : {};
  if (!isRecord(incoming)) return out;
  if (spec.passthrough) Object.assign(out, clonedEntries(incoming));
  for (const key of spec.booleans) {
    if (incoming[key] != null) out[key] = !!incoming[key];
  }
  for (const [key, value] of Object.entries(spec.values ?? NO_VALUES)) {
    if (incoming[key] === undefined) continue;
    if (incoming[key] === null) {
      if (value.nullable) out[key] = null;
      continue;
    }
    out[key] = cloneValue(incoming[key]);
  }
  for (const [key, nested] of Object.entries(spec.blocks)) {
    if (incoming[key] === undefined) continue;
    out[key] = incoming[key] === null ? null : mergeSettingsBlock(out[key], incoming[key], nested);
  }
  return out;
}

export { INGEST_SPEC, SECRET_PRESENCE_SUFFIX, mergeSettingsBlock, pickSettingsBlock, settingsBlockSpecFor, validateSettingsBlock };
