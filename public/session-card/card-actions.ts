import { createActionStatus, sendOrReport } from '../action-status.ts';
import type { ActionStatus } from '../action-status.ts';
import type { SessionUi } from './card-registry.ts';

const actionStatusBySessionUi = new WeakMap<SessionUi, ActionStatus>();

export function sessionActionStatus(ui: SessionUi): ActionStatus {
  const existing = actionStatusBySessionUi.get(ui);
  if (existing?.element.parentElement === ui.card) return existing;
  const status = existing ?? createActionStatus('session-action-status m-0 px-3 py-1');
  ui.termWrap.before(status.element);
  actionStatusBySessionUi.set(ui, status);
  return status;
}

export function sendSessionAction(ui: SessionUi, message: Record<string, unknown>): boolean {
  const status = sessionActionStatus(ui);
  if (!sendOrReport(message, status)) return false;
  status.clear();
  return true;
}
