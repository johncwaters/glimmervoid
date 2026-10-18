import type { ProjectCoherenceCheckResult } from '#shared/contracts/coherence.ts';
import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { nextRequestId, sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { coherenceCheckStageText, coherenceCheckStatus } from './check-core.ts';

const CHECK_REPLY_TIMEOUT_MS = 120_000;
const checksByProjectId = new Map<string, { requestId: string | null; reply?: ProjectCoherenceCheckResult; replyTimer?: ReturnType<typeof setTimeout> }>();
let openAction: { projectId: string; paint: () => void } | null = null;

function settleCheck(projectId: string, reply: ProjectCoherenceCheckResult) {
  clearTimeout(checksByProjectId.get(projectId)?.replyTimer);
  checksByProjectId.set(projectId, { requestId: null, reply });
  if (openAction?.projectId === projectId) openAction.paint();
}

function failCheck(projectId: string, error: string) {
  settleCheck(projectId, { projectId, ok: false, stages: [], error });
}

export function applyProjectCoherenceCheckResponse(message: ServerMessageOf<'project-coherence-check-response'>) {
  const check = checksByProjectId.get(message.projectId);
  if (!check?.requestId || check.requestId !== message.requestId) return;
  settleCheck(message.projectId, message);
}

export function abandonPendingCoherenceChecks() {
  for (const [projectId, check] of checksByProjectId) {
    if (check.requestId) failCheck(projectId, 'Connection lost');
  }
}

export function buildProjectCoherenceCheckAction(projectId: string) {
  const element = el('section', 'coherence-check');
  const controls = el('div', 'coherence-check-controls');
  const button = el('button', 'coherence-journal-button', 'Check Coherence');
  button.type = 'button';
  const pendingStatus = el('span', 'coherence-check-status');
  pendingStatus.setAttribute('role', 'status');
  const stages = el('ul', 'coherence-check-stages');
  const summary = el('p', 'coherence-check-status');
  summary.setAttribute('role', 'status');
  controls.append(button, pendingStatus);
  element.append(controls, stages, summary);
  const action = { projectId, paint: () => {
    const check = checksByProjectId.get(projectId);
    const isPending = check?.requestId != null;
    button.disabled = isPending;
    pendingStatus.textContent = coherenceCheckStatus(isPending);
    stages.replaceChildren(...(check?.reply?.stages ?? []).map((stage) => {
      const row = el('li', 'coherence-check-stage');
      row.dataset.status = stage.status;
      row.append(el('span', 'coherence-check-stage-heading', coherenceCheckStageText(stage)), el('span', 'coherence-check-detail', stage.detail));
      return row;
    }));
    summary.textContent = coherenceCheckStatus(false, check?.reply);
    summary.dataset.error = String(check?.reply?.ok === false);
  } };
  openAction = action;
  button.addEventListener('click', () => {
    if (checksByProjectId.get(projectId)?.requestId) return;
    const requestId = nextRequestId('coherence-check');
    if (!sendControlMsg({ type: 'project-coherence-check', projectId, requestId })) {
      failCheck(projectId, 'Not connected');
      return;
    }
    const replyTimer = setTimeout(() => {
      if (checksByProjectId.get(projectId)?.requestId === requestId) failCheck(projectId, 'Check timed out');
    }, CHECK_REPLY_TIMEOUT_MS);
    checksByProjectId.set(projectId, { requestId, replyTimer });
    action.paint();
  });
  action.paint();
  return { element, dispose: () => {
    if (openAction === action) openAction = null;
  } };
}
