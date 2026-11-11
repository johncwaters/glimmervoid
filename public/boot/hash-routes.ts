import { isPhoneShellActive, showPhoneScreen } from '../phone/phone-shell-gate.ts';
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

function activateLocationHash(event: HashChangeEvent) {
  if (event.newURL !== location.href) return;
  activateSettingsHash(location.hash);
}

function wireHashRouting() {
  document.addEventListener('click', (event) => {
    if (!isPhoneShellActive() || event.defaultPrevented) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (!activateSettingsHash(anchor.hash)) return;
    event.preventDefault();
  });
  window.addEventListener('hashchange', activateLocationHash);
}

export { activateSettingsHash, wireHashRouting };
