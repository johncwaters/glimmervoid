import { createJsonStateStore } from './json-file.ts';
import { StartPicksFile } from '../shared/contracts/start-picks.ts';
import type { StartPicks } from '../shared/contracts/start-picks.ts';
import { emptyStartPicks, rememberStart } from '../shared/start-picks-core.ts';
import type { RememberedStart } from '../shared/start-picks-core.ts';
import { clock } from '../shared/clock.ts';

type StartPicksStore = {
  current(): Promise<StartPicks>;
  record(start: RememberedStart): Promise<void>;
};

function createStartPicksStore({ filePath, logger }: { filePath: string | null; logger: Pick<Console, 'warn'> }): StartPicksStore {
  let picks = emptyStartPicks();
  const store = createJsonStateStore<StartPicks>({
    name: 'start picks',
    filePath,
    parse: (raw) => StartPicksFile.safeParse(raw).data ?? null,
    adopt: (loaded) => { picks = loaded ?? emptyStartPicks(); },
    warn: (message, fields) => logger.warn(`[start-picks] ${message} ${JSON.stringify(fields)}`),
  });

  async function current(): Promise<StartPicks> {
    await store.load();
    return picks;
  }

  async function record(start: RememberedStart): Promise<void> {
    await store.load();
    picks = rememberStart(picks, start, clock.nowMs());
    const written = picks;
    await store.write(written, () => `${JSON.stringify(written, null, 2)}\n`);
  }

  return { current, record };
}

export { createStartPicksStore };
export type { StartPicksStore };
