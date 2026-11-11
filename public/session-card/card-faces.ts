import type { SessionState } from '#shared/states.ts';
import { KILLABLE_STATES, RESTARTABLE_STATES, STATES } from '#shared/states.ts';
import { isDebugModeEnabled } from './card-debug.ts';
import type { SessionUi } from './card-registry.ts';

const isKillable = (state: string) => KILLABLE_STATES.includes(state as SessionState);
const isRestartable = (state: string) => RESTARTABLE_STATES.includes(state as SessionState);

function updateButtonVisibility(ui: SessionUi) {
  const state = ui.currentState;
  ui.btnRestart.classList.toggle('visible', isKillable(state) || isRestartable(state) || state === STATES.DORMANT);
  ui.btnWorkspaceRepos.classList.toggle('visible', ui.card.dataset.workspace !== undefined);
  ui.btnTrace.classList.toggle('visible', isDebugModeEnabled());
}

export { updateButtonVisibility };
