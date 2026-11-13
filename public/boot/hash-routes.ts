import { packNameOfApprovalHash } from '#shared/pack-approval.ts';
import { isPhoneShellActive, showPhoneScreen } from '../phone/phone-shell-gate.ts';
import { isSettingsHash } from '../settings/settings-link.ts';
import { activateSettingsSection } from '../settings/settings-store.ts';
import { openPackDetail, PACKS_TAB_HASH } from '../packs/packs-catalog.ts';
import { activateView } from './view-tabs.ts';

function activatePacksHash(hash: string) {
  const packName = packNameOfApprovalHash(hash);
  if (packName === null && hash !== PACKS_TAB_HASH) return false;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  if (!showPhoneScreen('packs')) activateView('packs');
  if (packName !== null) openPackDetail(packName);
  return true;
}

function activateSettingsHash(hash: string) {
  if (!isSettingsHash(hash)) return false;
  activateSettingsSection(null, null, hash);
  if (showPhoneScreen('settings')) return true;
  activateView('settings', { persist: false });
  return true;
}

function activateLocationHash(event: HashChangeEvent) {
  if (event.newURL !== location.href) return;
  if (activatePacksHash(location.hash)) return;
  activateSettingsHash(location.hash);
}

function wireHashRouting() {
  document.addEventListener('click', (event) => {
    if (!isPhoneShellActive() || event.defaultPrevented) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (!activatePacksHash(anchor.hash) && !activateSettingsHash(anchor.hash)) return;
    event.preventDefault();
  });
  window.addEventListener('hashchange', activateLocationHash);
}

export { activatePacksHash, activateSettingsHash, wireHashRouting };
