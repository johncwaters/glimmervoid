import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import type { PlanDraftPush } from '#shared/contracts/plan-review.ts';
import type { SessionState } from '#shared/states.ts';
import { KILLABLE_STATES, RESTARTABLE_STATES, STATES } from '#shared/states.ts';
import type { PlanResponse } from '../plan/plan-face.ts';
import { mergePlanChanged } from '../plan/plan-view-core.ts';
import type { PlanChangedMessage } from '../plan/plan-view-core.ts';
import { isDebugModeEnabled } from './card-debug.ts';
import type { SessionUi } from './card-registry.ts';
import { findSessionUi, sessionIdOf, sessionUIs } from './card-registry.ts';
import { decidePlanHeaderAction } from './face-core.ts';
import { syncTerminalOutputFlow } from './terminal-data-socket.ts';

const isKillable = (state: string) => KILLABLE_STATES.includes(state as SessionState);
const isRestartable = (state: string) => RESTARTABLE_STATES.includes(state as SessionState);

function updateButtonVisibility(ui: SessionUi) {
  const state = ui.currentState;
  ui.btnRestart.classList.toggle('visible', isKillable(state) || isRestartable(state) || state === STATES.DORMANT);
  ui.btnWorkspaceRepos.classList.toggle('visible', ui.card.dataset.workspace !== undefined);
  ui.btnTrace.classList.toggle('visible', isDebugModeEnabled());
  ui.btnPlan.hidden = decidePlanHeaderAction(ui) === 'hidden';
}

type SessionPlanChangedMessage = PlanChangedMessage;
type SessionPlanDraftMessage = PlanDraftPush;

export function showSessionPlanFace(sessionId: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui?.isBorrowed || !ui.hasPlan) return false;
  ui.face = 'plan';
  ui.card.dataset.face = 'plan';
  ui.termWrap.hidden = true;
  ui.planFace.show(sessionIdOf(sessionId));
  updateButtonVisibility(ui);
  syncTerminalOutputFlow(ui, sessionIdOf(sessionId));
  return true;
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

export { updateButtonVisibility };
