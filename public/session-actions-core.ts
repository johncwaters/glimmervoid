import { STATES } from '#shared/states.ts';

export interface SessionStateSource {
  currentState?: string | null;
}

export type SessionOpenStatePolicy = 'explicit-state' | 'dormant-fallback';

export function decideSessionOpenAction(
  currentState: string | null | undefined,
  statePolicy: SessionOpenStatePolicy = 'explicit-state',
): 'start-session' | 'dismiss' | null {
  const state = statePolicy === 'dormant-fallback' ? currentState || STATES.DORMANT : currentState;
  if (state === STATES.DORMANT) return 'start-session';
  if (state === STATES.COMPLETE) return 'dismiss';
  return null;
}

export function pickRestorableSessionId(
  lastFocusedSessionId: string | null | undefined,
  sessions: ReadonlyMap<string, SessionStateSource>,
): string | null {
  if (!lastFocusedSessionId) return null;
  const session = sessions.get(lastFocusedSessionId);
  if (!session || (session.currentState || STATES.DORMANT) === STATES.DORMANT) return null;
  return lastFocusedSessionId;
}
