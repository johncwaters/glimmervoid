import type { PlanDecision, PlanGate } from '#shared/contracts/plan-gate.ts';
import { PLAN_GATE_FEEDBACK_MAX_CHARS } from '#shared/contracts/plan-gate.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { findSessionUi } from '../session-card/card-registry.ts';
import { parsePlanMarkdown } from './plan-markdown-core.ts';
import { renderPlanBlocks } from './plan-render.ts';

const DECIDED_STATUS_TEXT: Readonly<Record<PlanGate['status'], string>> = {
  pending: 'Waiting for your decision.',
  approved: 'Approved.',
  rejected: 'Rejected. The agent is revising the plan.',
};

function sendPlanDecision(sessionId: string, decision: PlanDecision, feedback: string) {
  const trimmedFeedback = feedback.trim();
  sendControlMsg({ type: 'plan-decision', id: sessionId, decision, ...(trimmedFeedback.length > 0 ? { feedback: trimmedFeedback } : {}) });
}

function buildPlanGatePanel(sessionId: string, planGate: PlanGate): HTMLElement {
  const panel = el('section', 'plan-gate-panel');
  panel.setAttribute('aria-label', 'Proposed plan');
  panel.dataset.planText = planGate.planText;
  const heading = el('p', 'plan-gate-heading');
  heading.textContent = 'Proposed plan';
  const status = el('span', 'plan-gate-status');
  status.setAttribute('role', 'status');
  const body = el('div', 'plan-gate-body');
  body.append(renderPlanBlocks(parsePlanMarkdown(planGate.planText)));
  if (planGate.isPlanTruncated) {
    const cut = el('p', 'plan-gate-cut');
    cut.textContent = 'The plan is longer than the card shows; read the rest in the terminal.';
    body.append(cut);
  }
  const feedback = el('textarea', 'plan-gate-feedback');
  feedback.placeholder = 'Feedback for the agent (optional)';
  feedback.maxLength = PLAN_GATE_FEEDBACK_MAX_CHARS;
  feedback.rows = 2;
  feedback.setAttribute('aria-label', 'Feedback for the agent');
  const actions = el('div', 'plan-gate-actions');
  const decide = (decision: PlanDecision) => () => {
    for (const control of actions.querySelectorAll('button')) control.disabled = true;
    sendPlanDecision(sessionId, decision, feedback.value);
  };
  actions.append(
    button({ variant: 'primary', size: 'small', label: 'Approve', onClick: decide('approve') }),
    button({ variant: 'secondary', size: 'small', label: 'Reject', onClick: decide('reject') }),
    button({ variant: 'quiet', size: 'small', label: 'Answer in terminal', onClick: decide('terminal') }),
  );
  panel.append(heading, status, body, feedback, actions);
  return panel;
}

function paintPlanGateStatus(panel: HTMLElement, planGate: PlanGate) {
  const status = panel.querySelector<HTMLElement>('.plan-gate-status');
  if (status) status.textContent = DECIDED_STATUS_TEXT[planGate.status];
  const isPending = planGate.status === 'pending';
  panel.querySelector<HTMLTextAreaElement>('.plan-gate-feedback')?.toggleAttribute('hidden', !isPending);
  panel.querySelector<HTMLElement>('.plan-gate-actions')?.toggleAttribute('hidden', !isPending);
}

export function setSessionPlanGate(sessionId: string, planGate: PlanGate | null) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const existingPanel = ui.card.querySelector<HTMLElement>(':scope > .plan-gate-panel');
  if (planGate === null) {
    existingPanel?.remove();
    return;
  }
  const isSamePlan = existingPanel?.dataset.planText === planGate.planText;
  const panel = isSamePlan && existingPanel ? existingPanel : buildPlanGatePanel(sessionId, planGate);
  if (!isSamePlan) existingPanel?.remove();
  if (planGate.status === 'pending') for (const control of panel.querySelectorAll<HTMLButtonElement>('.plan-gate-actions button')) control.disabled = false;
  paintPlanGateStatus(panel, planGate);
  if (panel !== existingPanel) ui.termWrap.before(panel);
}
