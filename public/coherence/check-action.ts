import type { ProjectCoherenceCheckResult } from '#shared/contracts/coherence.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { coherenceCheckStageText, coherenceCheckStatus } from './check-core.ts';

const CHECK_REPLY_TIMEOUT_MS = 120_000;
const checksByProjectId = new Map<string, { isPending: boolean; reply?: ProjectCoherenceCheckResult }>();
let openAction: { projectId: string; paint: () => void } | null = null;

function settleCheck(projectId: string, reply: ProjectCoherenceCheckResult) {
  checksByProjectId.set(projectId, { isPending: false, reply });
  if (openAction?.projectId === projectId) openAction.paint();
}

function failCheck(projectId: string, error: string) {
  settleCheck(projectId, { projectId, ok: false, stages: [], error });
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
    const isPending = check?.isPending === true;
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
    if (checksByProjectId.get(projectId)?.isPending) return;
    const check = { isPending: true };
    checksByProjectId.set(projectId, check);
    void sendControlRequest('project-coherence-check', { projectId }, { timeoutMs: CHECK_REPLY_TIMEOUT_MS })
      .then((message) => {
        if (checksByProjectId.get(projectId) !== check) return;
        if (message.type !== 'project-coherence-check-response' || message.projectId !== projectId) return;
        settleCheck(projectId, message);
      })
      .catch((error: unknown) => {
        if (checksByProjectId.get(projectId) !== check) return;
        failCheck(projectId, error instanceof Error ? error.message : 'Connection lost');
      });
    action.paint();
  });
  action.paint();
  return { element, dispose: () => {
    if (openAction === action) openAction = null;
  } };
}
