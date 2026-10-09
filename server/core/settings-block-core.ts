import { SOURCE_NAMES } from './ingest-core.ts';
import { isRecord } from '../../shared/coerce.ts';

export interface SettingsBlockSpec {
  name: string;
  booleans: readonly string[];
  blocks: Readonly<Record<string, SettingsBlockSpec>>;
}

const NO_BLOCKS: Readonly<Record<string, SettingsBlockSpec>> = Object.freeze({});

const INGEST_SOURCES_SPEC: SettingsBlockSpec = Object.freeze({
  name: 'ingest.sources',
  booleans: Object.freeze([]),
  blocks: Object.freeze(Object.fromEntries(SOURCE_NAMES.map((source) => [source, Object.freeze({
    name: `ingest.sources.${source}`,
    booleans: Object.freeze(['enabled']),
    blocks: NO_BLOCKS,
  })]))),
});

const INGEST_SPEC: SettingsBlockSpec = Object.freeze({
  name: 'ingest',
  booleans: Object.freeze(['enabled']),
  blocks: Object.freeze({ sources: INGEST_SOURCES_SPEC }),
});

function validateSettingsBlock(block: unknown, spec: SettingsBlockSpec): string | null {
  if (block == null) return null;
  if (!isRecord(block)) return `${spec.name} must be an object`;
  for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
    if (value == null) continue;
    if (spec.booleans.includes(key)) {
      if (typeof value !== 'boolean') return `${spec.name}.${key} must be a boolean`;
      continue;
    }
    if (Object.hasOwn(spec.blocks, key)) {
      const error = validateSettingsBlock(value, spec.blocks[key]);
      if (error) return error;
      continue;
    }
    return `${spec.name}.${key} is not settable from the dashboard`;
  }
  return null;
}

function pickSettingsBlock(stored: unknown, spec: SettingsBlockSpec): Record<string, unknown> | null {
  if (!isRecord(stored)) return null;
  const fields = stored as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of spec.booleans) {
    if (fields[key] != null) out[key] = !!fields[key];
  }
  for (const [key, nested] of Object.entries(spec.blocks)) {
    const picked = pickSettingsBlock(fields[key], nested);
    if (picked) out[key] = picked;
  }
  return out;
}

function mergeSettingsBlock(stored: unknown, incoming: unknown, spec: SettingsBlockSpec): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(stored) ? { ...(stored as Record<string, unknown>) } : {};
  if (!isRecord(incoming)) return out;
  const fields = incoming as Record<string, unknown>;
  for (const key of spec.booleans) {
    if (fields[key] != null) out[key] = !!fields[key];
  }
  for (const [key, nested] of Object.entries(spec.blocks)) {
    if (fields[key] == null) continue;
    out[key] = mergeSettingsBlock(out[key], fields[key], nested);
  }
  return out;
}

export { INGEST_SPEC, mergeSettingsBlock, pickSettingsBlock, validateSettingsBlock };
