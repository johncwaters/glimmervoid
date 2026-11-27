import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  createPersistedCore,
  extractSessionIdFromPrefixedKey,
  pruneSessionStorageKeys,
} from '../public/state/persist-core.ts';
import type {
  PersistedCore,
  PersistedCoreOptions,
  PruneSessionStorageKeysOptions,
  StorageAdapter,
} from '../public/state/persist-core.ts';

function memoryStorage(initial: Record<string, string> = {}, options: { failWrites?: boolean } = {}): {
  adapter: StorageAdapter;
  backing: Map<string, string>;
} {
  const backing = new Map<string, string>(Object.entries(initial));
  const adapter: StorageAdapter = {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => {
      if (options.failWrites) throw new Error('QuotaExceededError');
      backing.set(key, value);
    },
    removeItem: (key) => {
      backing.delete(key);
    },
  };
  return { adapter, backing };
}

test('persist-core validates reads with Zod, falls back on corrupt or invalid values, writes through, and clears', () => {
  const draftSchema = z.object({ text: z.string(), count: z.number().int().nonnegative() });
  const { adapter, backing } = memoryStorage();
  const options: PersistedCoreOptions<{ text: string; count: number }> = {
    key: 'gv:draft',
    schema: draftSchema,
    fallback: { text: '', count: 0 },
    storage: adapter,
  };
  const persisted: PersistedCore<{ text: string; count: number }> = createPersistedCore(options);

  const initialFallback = persisted.read();
  initialFallback.count = -999;
  assert.deepEqual(persisted.read(), { text: '', count: 0 });

  backing.set('gv:draft', '{not-json');
  assert.deepEqual(persisted.read(), { text: '', count: 0 });

  backing.set('gv:draft', JSON.stringify({ text: 'ok', count: -5 }));
  assert.deepEqual(persisted.read(), { text: '', count: 0 });

  const written = persisted.write({ text: 'hello', count: 2 });
  assert.deepEqual(written, { text: 'hello', count: 2 });
  assert.equal(backing.get('gv:draft'), JSON.stringify({ text: 'hello', count: 2 }));
  assert.deepEqual(persisted.read(), { text: 'hello', count: 2 });

  assert.throws(() => persisted.write({ text: 'bad', count: -1 }));

  const cleared = persisted.clear();
  assert.deepEqual(cleared, { text: '', count: 0 });
  cleared.count = -123;
  assert.deepEqual(persisted.read(), { text: '', count: 0 });
  assert.equal(backing.has('gv:draft'), false);

  const optionalStorage = memoryStorage();
  const optionalPersisted = createPersistedCore({
    key: 'gv:optional',
    schema: z.string().optional(),
    fallback: 'default',
    storage: optionalStorage.adapter,
  });
  optionalPersisted.write('saved');
  assert.equal(optionalPersisted.read(), 'saved');
  assert.equal(optionalPersisted.write(undefined), undefined);
  assert.equal(optionalStorage.backing.has('gv:optional'), false);
  assert.equal(optionalPersisted.read(), 'default');

  const quotaStorage = memoryStorage({}, { failWrites: true });
  const quotaPersisted = createPersistedCore({
    key: 'gv:quota',
    schema: draftSchema,
    fallback: { text: '', count: 0 },
    storage: quotaStorage.adapter,
  });
  assert.deepEqual(quotaPersisted.write({ text: 'survives', count: 1 }), { text: 'survives', count: 1 });
});

test('persist-core prunes stale per-session keys while preserving live sessions and unrelated prefixes', () => {
  assert.equal(extractSessionIdFromPrefixedKey('gv:draft:', 'gv:draft:sess-1'), 'sess-1');
  assert.equal(extractSessionIdFromPrefixedKey('gv:draft:', 'gv:draft:sess-1:scroll'), 'sess-1');
  assert.equal(extractSessionIdFromPrefixedKey('gv:draft:', 'gv:other:sess-1'), null);

  const { adapter, backing } = memoryStorage({
    'gv:draft:sess-live': '"keep"',
    'gv:draft:sess-live:cursor': '12',
    'gv:draft:sess-dead': '"drop"',
    'gv:draft:sess-dead:cursor': '4',
    'gv:other:sess-dead': '"untouched"',
  });

  const pruneOptions: PruneSessionStorageKeysOptions = {
    prefix: 'gv:draft:',
    liveSessionIds: new Set(['sess-live']),
    keys: [...backing.keys()],
    removeItem: (key) => adapter.removeItem(key),
  };
  const removed = pruneSessionStorageKeys(pruneOptions);
  assert.deepEqual(removed, ['gv:draft:sess-dead', 'gv:draft:sess-dead:cursor']);
  assert.deepEqual([...backing.keys()].sort(), [
    'gv:draft:sess-live',
    'gv:draft:sess-live:cursor',
    'gv:other:sess-dead',
  ]);
});
