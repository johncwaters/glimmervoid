import { STATES } from '#shared/states.ts';
import { sendControlMsg } from '../control-ws.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { getVisiblePhoneSessionId } from '../phone/phone-shell-gate.ts';
import { isCompletionWatchedByOperator } from '../session-actions-core.ts';
import type { SessionUi } from './card-registry.ts';

const WATCHED_COMPLETION_HOLD_MS = 3000;
const pendingWatchedDismissBySessionUi = new WeakMap<SessionUi, ReturnType<typeof setTimeout>>();

function cancelWatchedCompletionDismiss(ui: SessionUi) {
  clearTimeout(pendingWatchedDismissBySessionUi.get(ui));
  pendingWatchedDismissBySessionUi.delete(ui);
}

function holdThenDismissWatchedCompletion(ui: SessionUi, sessionId: string) {
  const timer = setTimeout(() => {
    pendingWatchedDismissBySessionUi.delete(ui);
    sendControlMsg({ type: 'dismiss', id: sessionId, expectedState: STATES.COMPLETE });
  }, WATCHED_COMPLETION_HOLD_MS);
  pendingWatchedDismissBySessionUi.set(ui, timer);
}

function isCompletionWatchedAt(ui: SessionUi, previousState: string, nextState: string) {
  const activeElement = document.activeElement;
  const isPhone = isPhoneLayout();
  return isCompletionWatchedByOperator({
    previousState,
    nextState,
    isPhoneLayout: isPhone,
    isDocumentVisible: document.visibilityState === 'visible',
    isDocumentFocused: document.hasFocus(),
    isActiveViewer: isPhone ? getVisiblePhoneSessionId() === ui.card.dataset.id : ui._isActiveViewer?.() === true,
    hasFocusInsideTerminal: activeElement instanceof Node && ui.termWrap.contains(activeElement),
  });
}

export { cancelWatchedCompletionDismiss, holdThenDismissWatchedCompletion, isCompletionWatchedAt };
