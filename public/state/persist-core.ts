export interface PersistedSchema<Value> {
  safeParse(value: unknown): { success: true; data: Value } | { success: false };
  parse(value: unknown): Value;
}

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistedCoreOptions<Value> {
  key: string;
  schema: PersistedSchema<Value>;
  fallback: Value;
  storage: StorageAdapter;
}

export interface PersistedCore<Value> {
  read(): Value;
  write(value: Value): Value;
  clear(): Value;
}

export interface PruneSessionStorageKeysOptions {
  prefix: string;
  liveSessionIds: ReadonlySet<string>;
  keys: readonly string[];
  removeItem(key: string): void;
}

export function createPersistedCore<Value>({ key, schema, fallback, storage }: PersistedCoreOptions<Value>): PersistedCore<Value> {
  const cleanFallback = structuredClone(fallback);

  function cloneFallback(): Value {
    return structuredClone(cleanFallback);
  }

  function read(): Value {
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      return cloneFallback();
    }
    if (raw === null) return cloneFallback();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return cloneFallback();
    }
    const validated = schema.safeParse(parsedJson);
    if (!validated.success) return cloneFallback();
    return validated.data;
  }

  function write(value: Value): Value {
    const validated = schema.parse(value);
    const serialized = JSON.stringify(validated);
    try {
      if (serialized === undefined) {
        storage.removeItem(key);
        return validated;
      }
      storage.setItem(key, serialized);
    } catch {
    }
    return validated;
  }

  function clear(): Value {
    try {
      storage.removeItem(key);
    } catch {
    }
    return cloneFallback();
  }

  return { read, write, clear };
}

export function extractSessionIdFromPrefixedKey(prefix: string, key: string): string | null {
  if (!key.startsWith(prefix)) return null;
  const suffix = key.slice(prefix.length);
  if (suffix === '') return null;
  const separatorIndex = suffix.indexOf(':');
  const sessionId = separatorIndex === -1 ? suffix : suffix.slice(0, separatorIndex);
  if (sessionId === '') return null;
  return sessionId;
}

export function pruneSessionStorageKeys({ prefix, liveSessionIds, keys, removeItem }: PruneSessionStorageKeysOptions): string[] {
  const removedKeys: string[] = [];
  for (const key of keys) {
    const sessionId = extractSessionIdFromPrefixedKey(prefix, key);
    if (sessionId === null || liveSessionIds.has(sessionId)) continue;
    try {
      removeItem(key);
      removedKeys.push(key);
    } catch {
    }
  }
  return removedKeys;
}
