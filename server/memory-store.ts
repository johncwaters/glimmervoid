import { createJsonStateStore } from './json-file.ts';
import { forgetMemory, UNTRUSTED_MEMORY_NOTE, upsertMemory, visibleMemory } from './core/memory-core.ts';
import { MemoryStoreFile } from '../shared/contracts/memory.ts';
import type { AgentMemoryReply, AgentMemoryRequest, MemoryEntry } from '../shared/contracts/memory.ts';
import { clock } from '../shared/clock.ts';

type MemoryCaller = { projectPath: string; name: string };
type MemoryOutcome = { ok: true; reply: AgentMemoryReply } | { ok: false; status: number; error: string };

const STORE_VERSION = 1;
const NOT_FOUND_STATUS = 404;
const REFUSED_STATUS = 409;
const UNAVAILABLE_STATUS = 503;

function createMemoryStore({ filePath, logger }: { filePath: string | null; logger: Pick<Console, 'warn'> }) {
  let entries: MemoryEntry[] = [];
  let isLoaded = filePath === null;
  const store = createJsonStateStore<MemoryStoreFile>({
    name: 'memory',
    filePath,
    parse: (raw) => MemoryStoreFile.safeParse(raw).data ?? null,
    adopt: (loaded) => {
      entries = loaded?.entries ?? [];
      isLoaded = true;
    },
    warn: (message, fields) => logger.warn(`[memory] ${message} ${JSON.stringify(fields)}`),
  });

  async function persist(nextEntries: MemoryEntry[]): Promise<boolean> {
    const file: MemoryStoreFile = { version: STORE_VERSION, entries: nextEntries };
    const isWritten = await store.write(file, () => `${JSON.stringify(file, null, 2)}\n`);
    if (!isWritten && filePath !== null) return false;
    entries = nextEntries;
    return true;
  }

  async function applyRequest(caller: MemoryCaller, request: AgentMemoryRequest): Promise<MemoryOutcome> {
    await store.load();
    if (!isLoaded) return { ok: false, status: UNAVAILABLE_STATUS, error: 'the memory file could not be read, so try again shortly' };
    if (request.sub === 'list') {
      const listed = visibleMemory(entries, caller.projectPath).map(({ key, updatedBy, updatedAt }) => ({ key, updatedBy, updatedAt }));
      return { ok: true, reply: { ok: true, entries: listed, note: UNTRUSTED_MEMORY_NOTE } };
    }
    if (request.sub === 'read') {
      const found = visibleMemory(entries, caller.projectPath).find((entry) => entry.key === request.key);
      if (!found) return { ok: false, status: NOT_FOUND_STATUS, error: `no memory entry named ${request.key} in this project` };
      return { ok: true, reply: { ok: true, entry: { key: found.key, text: found.text, updatedBy: found.updatedBy, updatedAt: found.updatedAt }, note: UNTRUSTED_MEMORY_NOTE } };
    }
    if (request.sub === 'forget') {
      const kept = forgetMemory(entries, caller.projectPath, request.key);
      if (kept === null) return { ok: false, status: NOT_FOUND_STATUS, error: `no memory entry named ${request.key} in this project` };
      if (!(await persist(kept))) return { ok: false, status: UNAVAILABLE_STATUS, error: 'the memory file could not be written' };
      return { ok: true, reply: { ok: true, forgotten: request.key } };
    }
    const upsert = upsertMemory(entries, { key: request.key, projectPath: caller.projectPath, text: request.text, updatedBy: caller.name, updatedAt: clock.nowMs() });
    if (!upsert.ok) return { ok: false, status: REFUSED_STATUS, error: upsert.reason };
    if (!(await persist(upsert.entries))) return { ok: false, status: UNAVAILABLE_STATUS, error: 'the memory file could not be written' };
    return { ok: true, reply: { ok: true, written: request.key } };
  }

  let pendingRequests: Promise<unknown> = Promise.resolve();

  function handle(caller: MemoryCaller, request: AgentMemoryRequest): Promise<MemoryOutcome> {
    const outcome = pendingRequests.then(() => applyRequest(caller, request));
    pendingRequests = outcome.catch(() => {});
    return outcome;
  }

  return { handle, idle: () => store.idle() };
}

type MemoryStore = ReturnType<typeof createMemoryStore>;

export { createMemoryStore };
export type { MemoryStore };
