import { reportHeaderError } from '../action-status.ts';
import { openPlanInFocus } from '../focus-view/focus-view.ts';
import { isPhoneShellActive, showPhonePlan, showPhoneScreen } from '../phone/phone-shell-gate.ts';
import { resolvePlanTarget } from '../plan/plan-link.ts';
import { hasSession } from '../session-card/lifecycle.ts';
import { isSettingsHash } from '../settings/settings-link.ts';
import { activateSettingsSection } from '../settings/settings-store.ts';
import { activateView } from './view-tabs.ts';

function activateSettingsHash(hash: string) {
  if (!isSettingsHash(hash)) return false;
  activateSettingsSection(null, null, hash);
  if (showPhoneScreen('settings')) return true;
  activateView('settings', { persist: false });
  return true;
}

const NO_STORED_PLAN_TEXT = 'No plan is stored for this session yet. It appears here once the agent writes one.';
const PLAN_ERROR_SOURCE = 'Plan';

function activatePlanHash(hash: string) {
  const sessionId = resolvePlanTarget(hash);
  if (!sessionId) return false;
  if (!hasSession(sessionId)) return true;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  if (isPhoneShellActive()) {
    if (!showPhonePlan(sessionId)) reportHeaderError({ source: PLAN_ERROR_SOURCE, sessionId, message: NO_STORED_PLAN_TEXT });
    return true;
  }
  activateView('focus', { persist: false });
  if (!openPlanInFocus(sessionId)) reportHeaderError({ source: PLAN_ERROR_SOURCE, sessionId, message: NO_STORED_PLAN_TEXT });
  return true;
}

function activateHash(hash: string) {
  if (activatePlanHash(hash)) return true;
  return activateSettingsHash(hash);
}

function activateLocationHash(event: HashChangeEvent) {
  if (event.newURL !== location.href) return;
  activateHash(location.hash);
}

function wireHashRouting() {
  document.addEventListener('click', (event) => {
    if (!isPhoneShellActive() || event.defaultPrevented) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (!activateHash(anchor.hash)) return;
    event.preventDefault();
  });
  window.addEventListener('hashchange', activateLocationHash);
}

export { activatePlanHash, activateSettingsHash, wireHashRouting };
