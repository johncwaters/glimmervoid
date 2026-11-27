import { createSignal } from 'solid-js';
import { localStorageBackend, removeKeysWithPrefix, setString } from '../local-store.ts';
import { createPersistedCore, extractSessionIdFromPrefixedKey } from './persist-core.ts';
import type { PersistedSchema, StorageAdapter } from './persist-core.ts';

export interface PersistedOptions<Value> {
  key: string;
  schema: PersistedSchema<Value>;
  fallback: Value;
}

export interface PersistedValue<Value> {
  read(): Value;
  write(value: Value): Value;
  clear(): Value;
}

const browserStorageAdapter: StorageAdapter = {
  getItem: (key) => localStorageBackend.getItem(key),
  setItem: (key, value) => localStorageBackend.setItem(key, value),
  removeItem: (key) => setString(key, ''),
};

export function definePersisted<Value>({ key, schema, fallback }: PersistedOptions<Value>): PersistedValue<Value> {
  const core = createPersistedCore({ key, schema, fallback, storage: browserStorageAdapter });
  const [box, setBox] = createSignal({ current: core.read() });

  function read(): Value {
    return box().current;
  }

  function write(value: Value): Value {
    const written = core.write(value);
    setBox({ current: written });
    return written;
  }

  function clear(): Value {
    const cleared = core.clear();
    setBox({ current: cleared });
    return cleared;
  }

  return { read, write, clear };
}

export function cleanupSessionPersistedKeys(prefix: string, liveSessionIds: ReadonlySet<string>): void {
  removeKeysWithPrefix(prefix, (key) => {
    const sessionId = extractSessionIdFromPrefixedKey(prefix, key);
    return sessionId === null || liveSessionIds.has(sessionId);
  });
}
