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

export function refreshElapsed(ui: SessionUi) {
  if (ui.elapsedEl) ui.elapsedEl.textContent = sessionElapsedText(ui);
}

const tickSubscribers = new Set<() => void>();

export function onSessionTick(notify: () => void) {
  tickSubscribers.add(notify);
  return () => tickSubscribers.delete(notify);
}

function runSessionTick() {
  for (const [, ui] of sessionUIs) {
    refreshElapsed(ui);
    refreshSessionActivity(ui);
  }
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
