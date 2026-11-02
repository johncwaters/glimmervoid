import { STATES } from '#shared/states.ts';
import { sendControlMsg } from '../control-ws.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { isCompletionWatchedByOperator } from '../session-actions-core.ts';
import type { SessionUi } from './card-registry.ts';

const WATCHED_COMPLETION_HOLD_MS = 1500;
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
  return isCompletionWatchedByOperator({
    previousState,
    nextState,
    isPhoneLayout: isPhoneLayout(),
    isDocumentVisible: document.visibilityState === 'visible',
    isDocumentFocused: document.hasFocus(),
    isActiveViewer: ui._isActiveViewer?.() === true,
    hasFocusInsideTerminal: activeElement instanceof Node && ui.termWrap.contains(activeElement),
  });
}

export { cancelWatchedCompletionDismiss, holdThenDismissWatchedCompletion, isCompletionWatchedAt };
