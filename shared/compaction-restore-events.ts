import { STATES } from './states.ts';

export const COMPACTION_RESTORE_EVENTS = Object.freeze({
  [STATES.IDLE]: 'compaction_restore_idle',
  [STATES.COMPLETE]: 'compaction_restore_complete',
  [STATES.WAITING]: 'compaction_restore_waiting',
} as const);

export function isCompactionRestoreEvent(event: string | null | undefined): boolean {
  return Object.values(COMPACTION_RESTORE_EVENTS).some((restoreEvent) => restoreEvent === event);
}
