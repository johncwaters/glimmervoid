import { STATES } from '#shared/states.ts';
import { el } from '../dom-helpers.ts';
import { sessionActionStatus } from './card-dom.ts';
import { findSessionUi } from './card-registry.ts';
import { reportHeaderError } from '../action-status.ts';

export function reportSessionProblem(sessionId: unknown, message: string) {
  const ui = findSessionUi(sessionId);
  if (!ui) { reportHeaderError({ source: 'Session', sessionId: typeof sessionId === 'string' ? sessionId : undefined, message }); return; }
  sessionActionStatus(ui).show('error', message);
}

export function setSessionFailureReason(sessionId: unknown, failureReason: string | null | undefined) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const existingLine = ui.card.querySelector<HTMLElement>(':scope > .session-failure-reason');
  const shouldShow = ui.currentState === STATES.FAILED && !!failureReason;
  if (!shouldShow) {
    existingLine?.remove();
    return;
  }
  const reasonLine = existingLine ?? el('p', 'session-failure-reason');
  reasonLine.setAttribute('role', 'status');
  reasonLine.textContent = failureReason;
  if (!existingLine) ui.termWrap.before(reasonLine);
}
