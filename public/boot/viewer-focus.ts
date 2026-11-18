import { getBorrowedCardId } from '../card-host.ts';
import { getPhoneSessionId } from '../phone/phone-shell-gate.ts';
import { findSessionUi } from '../session-card/card-registry.ts';
import { markSessionSeen } from '../session-card/lifecycle.ts';
import { syncGridOnEngagementEdge } from '../session-card/terminal.ts';
import { reloadEveryWebglAddon } from '../session-card/webgl-pool.ts';

function markShownPhoneSessionSeen() {
  const shownPhoneSessionId = getPhoneSessionId();
  if (!shownPhoneSessionId) return;
  if (findSessionUi(shownPhoneSessionId)?._isActiveViewer?.() !== true) return;
  markSessionSeen(shownPhoneSessionId);
}

function noteViewerFocusEdge() {
  syncGridOnEngagementEdge(findSessionUi(getBorrowedCardId()));
  markShownPhoneSessionSeen();
}

function wireViewerFocus() {
  window.addEventListener('focus', noteViewerFocusEdge);
  window.addEventListener('blur', noteViewerFocusEdge);
  document.addEventListener('visibilitychange', noteViewerFocusEdge);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    reloadEveryWebglAddon();
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    reloadEveryWebglAddon();
  });
}

export { markShownPhoneSessionSeen, wireViewerFocus };
