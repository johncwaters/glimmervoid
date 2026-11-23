import { createJsonStateStore } from '../json-file.ts';
import { StudioGuideState } from '../../shared/contracts/studio-guide.ts';
import type { StudioGuideStep } from '../../shared/contracts/studio-guide.ts';

type StudioGuideStore = {
  doneSteps(): Promise<readonly StudioGuideStep[]>;
  markDone(step: StudioGuideStep): Promise<readonly StudioGuideStep[]>;
};

function createStudioGuideStore({ filePath, logger }: { filePath: string | null; logger: Pick<Console, 'warn'> }): StudioGuideStore {
  let state: StudioGuideState = { doneSteps: [] };
  const store = createJsonStateStore<StudioGuideState>({
    name: 'studio guide',
    filePath,
    parse: (raw) => StudioGuideState.safeParse(raw).data ?? null,
    adopt: (loaded) => { state = loaded ?? { doneSteps: [] }; },
    warn: (message, fields) => logger.warn(`[studio-guide] ${message} ${JSON.stringify(fields)}`),
  });

  async function doneSteps(): Promise<readonly StudioGuideStep[]> {
    await store.load();
    return state.doneSteps;
  }

  async function markDone(step: StudioGuideStep): Promise<readonly StudioGuideStep[]> {
    await store.load();
    if (state.doneSteps.includes(step)) return state.doneSteps;
    const written: StudioGuideState = { doneSteps: [...state.doneSteps, step] };
    const isWritten = await store.write(written, () => `${JSON.stringify(written, null, 2)}\n`);
    if (!isWritten) throw new Error('studio-guide.json could not be written');
    state = written;
    return written.doneSteps;
  }

  return { doneSteps, markDone };
}

export { createStudioGuideStore };
export type { StudioGuideStore };
