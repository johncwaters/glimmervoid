import { STATES } from '#shared/states.ts';

export function createUnseenCompleteTracker() {
  const lastStateById = new Map<string, string>();
  const unseenCompleteIds = new Set<string>();

  function noteStates(entries: readonly { id: string; state: string }[]): void {
    const presentIds = new Set(entries.map((entry) => entry.id));
    for (const { id, state } of entries) {
      const previousState = lastStateById.get(id);
      lastStateById.set(id, state);
      if (state !== STATES.COMPLETE) {
        unseenCompleteIds.delete(id);
        continue;
      }
      if (previousState && previousState !== STATES.COMPLETE) unseenCompleteIds.add(id);
    }
    for (const id of lastStateById.keys()) {
      if (presentIds.has(id)) continue;
      lastStateById.delete(id);
      unseenCompleteIds.delete(id);
    }
  }

  function acknowledge(id: string): void {
    unseenCompleteIds.delete(id);
  }

  function isUnseen(id: string): boolean {
    return unseenCompleteIds.has(id);
  }

  return { noteStates, acknowledge, isUnseen };
}
