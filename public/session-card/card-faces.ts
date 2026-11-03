import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import type { PlanDraftPush } from '#shared/contracts/plan-review.ts';
import type { SessionState } from '#shared/states.ts';
import { KILLABLE_STATES, RESTARTABLE_STATES, STATES } from '#shared/states.ts';
import { loadShownFaceModule, markShownFilesOpened, shownFilesOf } from '../shown-files.ts';
import type { PlanResponse } from '../plan/plan-face.ts';
import { mergePlanChanged } from '../plan/plan-view-core.ts';
import type { PlanChangedMessage } from '../plan/plan-view-core.ts';
import { isDebugModeEnabled } from './card-debug.ts';
import type { SessionUi } from './card-registry.ts';
import { findSessionUi, sessionIdOf, sessionUIs } from './card-registry.ts';
import { decidePlanHeaderAction } from './face-core.ts';
import { syncTerminalOutputFlow } from './terminal-data-socket.ts';
import { reportSessionProblem } from './card-problems.ts';

const isKillable = (state: string) => KILLABLE_STATES.includes(state as SessionState);
const isRestartable = (state: string) => RESTARTABLE_STATES.includes(state as SessionState);



type ShownFaceModule = typeof import('../shown-face.ts');
function updateButtonVisibility(ui: SessionUi) {
  const state = ui.currentState;
  ui.btnRestart.classList.toggle('visible', isKillable(state) || isRestartable(state) || state === STATES.DORMANT);
  ui.btnWorkspaceRepos.classList.toggle('visible', ui.card.dataset.workspace !== undefined);
  ui.btnTrace.classList.toggle('visible', isDebugModeEnabled());
  ui.btnPlan.hidden = decidePlanHeaderAction(ui) === 'hidden';
  ui.btnTerminalTab.setAttribute('aria-selected', String(ui.face === 'terminal'));
  ui.btnShownTab.setAttribute('aria-selected', String(ui.face === 'shown'));
}

type SessionPlanChangedMessage = PlanChangedMessage;
type SessionPlanDraftMessage = PlanDraftPush;

export function showSessionPlanFace(sessionId: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui?.isBorrowed || !ui.hasPlan) return false;
  ui.face = 'plan';
  ui.card.dataset.face = 'plan';
  ui.termWrap.hidden = true;
  ui.shownFace?.hide();
  ui.planFace.show(sessionIdOf(sessionId));
  updateButtonVisibility(ui);
  syncTerminalOutputFlow(ui, sessionIdOf(sessionId));
  return true;
}

function switchToShownFace(ui: SessionUi, faceModule: ShownFaceModule, sessionId: string, fileId: string | null) {
  if (findSessionUi(sessionId) !== ui || !ui.isBorrowed) return;
  if (!ui.shownFace) {
    ui.shownFace = faceModule.createShownFace({ sessionId });
    ui.card.append(ui.shownFace.el);
  }
  ui.face = 'shown';
  ui.card.dataset.face = 'shown';
  ui.termWrap.hidden = true;
  ui.planFace.hide();
  ui.shownFace.show(fileId);
  markShownFilesOpened(sessionId);
  updateButtonVisibility(ui);
  syncTerminalOutputFlow(ui, sessionId);
}

function showSessionShownFace(sessionId: string, fileId: string | null) {
  const ui = findSessionUi(sessionId);
  if (!ui?.isBorrowed || shownFilesOf(sessionId).length === 0) return;
  void loadShownFaceModule().then((faceModule) => {
    if (!faceModule) {
      reportSessionProblem(sessionId, 'The shown files view did not load. Open it again to retry.');
      return;
    }
    switchToShownFace(ui, faceModule, sessionId, fileId);
  });
}

export function setSessionHasPlan(sessionId: unknown, hasPlan: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  ui.hasPlan = hasPlan === true;
  updateButtonVisibility(ui);
}

export function applySessionPlanChanged(message: SessionPlanChangedMessage) {
  const ui = findSessionUi(message.id);
  if (!ui) return;
  ui.planReviewState = mergePlanChanged(ui.planReviewState, message);
  ui.hasPlan = message.hasPlan;
  ui.planFace.update({ state: ui.planReviewState });
  updateButtonVisibility(ui);
}

export function applySessionPlanDraft(notice: SessionPlanDraftMessage) {
  const ui = findSessionUi(notice.id);
  if (!ui) return;
  ui.planFace.update({ draft: notice });
}

export function applySessionPlanResponse(response: PlanResponse) {
  const ui = findSessionUi(response.id);
  if (!ui) return;
  ui.planReviewState = { reviews: response.reviews };
  ui.hasPlan = true;
  ui.planFace.update({ response });
  updateButtonVisibility(ui);
}

export function applySessionPlanError(message: ServerMessage): boolean {
  if (message.type !== 'error' && message.type !== 'session-error') return false;
  if (message.scope !== 'plan' && message.scope !== 'plan-decision') return false;
  const ui = findSessionUi(message.id);
  if (!ui) return false;
  if (message.scope === 'plan') {
    ui.planFace.update({ requestFailed: true });
    return true;
  }
  ui.planFace.update({ decisionRefused: true, refusalText: message.message });
  return true;
}

export function applyPlanConnectionState(isConnected: boolean) {
  for (const [, ui] of sessionUIs) ui.planFace.update({ isConnected });
}

export { showSessionShownFace, updateButtonVisibility };
