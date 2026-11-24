import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { WargamesEvent, WargamesMatchSummary } from '../../shared/contracts/wargames.ts';
import { errorMessage } from '../../shared/text.ts';
import { appendJsonLine, createJsonStateStore } from '../json-file.ts';

const IndexFile = z.strictObject({
  version: z.literal(1),
  summaries: z.array(WargamesMatchSummary),
});

export interface WargamesStore {
  load(): Promise<WargamesMatchSummary[]>;
  appendEvent(matchId: string, event: WargamesEvent): Promise<void>;
  readEvents(matchId: string): Promise<WargamesEvent[]>;
  saveSummary(summary: WargamesMatchSummary): Promise<void>;
  listSummaries(): WargamesMatchSummary[];
  idle(): Promise<void>;
}

export function wargamesDirectoryOf(glimmervoidHome: string): string {
  return path.join(glimmervoidHome, 'wargames');
}

export function createWargamesStore({ directory, log }: { directory: string; log: Pick<Console, 'warn'> }): WargamesStore {
  const summariesById = new Map<string, WargamesMatchSummary>();
  const indexPath = path.join(directory, 'index.json');
  const logFileOf = (matchId: string) => path.join(directory, `${matchId}.jsonl`);

  const indexStore = createJsonStateStore<WargamesMatchSummary[]>({
    name: 'wargames-index',
    filePath: indexPath,
    parse: (raw) => {
      const parsed = IndexFile.safeParse(raw);
      return parsed.success ? parsed.data.summaries : null;
    },
    adopt: (loaded) => {
      summariesById.clear();
      for (const summary of loaded ?? []) {
        summariesById.set(summary.matchId, summary);
      }
    },
    warn: (message, detail) => log.warn(`[wargames] ${message}: ${JSON.stringify(detail ?? {})}`),
  });

  async function load(): Promise<WargamesMatchSummary[]> {
    await fsp.mkdir(directory, { recursive: true });
    await indexStore.load();
    return listSummaries();
  }

  async function appendEvent(matchId: string, event: WargamesEvent): Promise<void> {
    await appendJsonLine(logFileOf(matchId), event, { mkdir: true });
  }

  async function readEvents(matchId: string): Promise<WargamesEvent[]> {
    const raw = await fsp.readFile(logFileOf(matchId), 'utf8').catch(() => null);
    if (raw === null) return [];
    const events: WargamesEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = WargamesEvent.safeParse(JSON.parse(trimmed));
        if (parsed.success) events.push(parsed.data);
      } catch (error) {
        log.warn(`[wargames] skipping malformed log line in ${matchId}: ${errorMessage(error)}`);
      }
    }
    return events;
  }

  async function saveSummary(summary: WargamesMatchSummary): Promise<void> {
    summariesById.set(summary.matchId, summary);
    const snapshot = { version: 1 as const, summaries: listSummaries() };
    await indexStore.write(snapshot, () => JSON.stringify(snapshot, null, 2));
  }

  function listSummaries(): WargamesMatchSummary[] {
    return [...summariesById.values()].sort((left, right) => right.createdAtMs - left.createdAtMs);
  }

  return {
    load,
    appendEvent,
    readEvents,
    saveSummary,
    listSummaries,
    idle: () => indexStore.idle(),
  };
}
