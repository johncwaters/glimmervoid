import { clockDurationText } from '#shared/display-text.ts';
import { STATES } from '#shared/states.ts';
import { refreshSessionActivity } from './activity.ts';
import type { SessionUi } from './card-registry.ts';
import { sessionUIs } from './card-registry.ts';

const ELAPSED_STATES = new Set<string>([STATES.RUNNING, STATES.WAITING, STATES.STARTING, STATES.INITIALIZING]);
const showsElapsed = (state: string) => ELAPSED_STATES.has(state);

export function sessionElapsedText(ui: SessionUi) {
  return showsElapsed(ui.currentState) ? clockDurationText(Date.now() - (ui.stateSince || Date.now()), { rounding: 'floor', showsHours: true }) : '';
}

const tickSubscribers = new Set<() => void>();
const liveTickVisitors = new Set<(id: string, ui: SessionUi) => void>();
const liveSessionIds = new Set<string>();

export function syncLiveSession(id: string, ui: SessionUi | undefined) {
  if (ui && showsElapsed(ui.currentState)) {
    liveSessionIds.add(id);
    return;
  }
  liveSessionIds.delete(id);
}

export function onLiveSessionTick(visit: (id: string, ui: SessionUi) => void) {
  liveTickVisitors.add(visit);
  return () => liveTickVisitors.delete(visit);
}

function visitLiveSessions() {
  for (const id of liveSessionIds) {
    const ui = sessionUIs.get(id);
    if (!ui) continue;
    refreshSessionActivity(ui);
    for (const visit of liveTickVisitors) {
      try { visit(id, ui); } catch {  }
    }
  }
}

export function onSessionTick(notify: () => void) {
  tickSubscribers.add(notify);
  return () => tickSubscribers.delete(notify);
}

function runSessionTick() {
  visitLiveSessions();
  for (const notify of tickSubscribers) {
    try { notify(); } catch {  }
  }
}

setInterval(() => {
  if (document.hidden) return;
  runSessionTick();
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  runSessionTick();
});
