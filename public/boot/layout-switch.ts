import { centerSessionQuietly, getFocusedSessionId } from '../focus-view/focus-view.ts';
import { isPhoneLayout, onLayoutChange } from '../form-factor.ts';
import { canReturnToReviewQueue, onPhoneReviewScreenChanged, returnToReviewQueue } from '../github/review-queue-store.ts';
import { phonePanelsFromDesktopViews } from '../phone/phone-panels-core.ts';
import { activatePhoneShell, deactivatePhoneShell, getPhoneSessionId, isPhoneShellActive, mountPhoneShell, syncPhoneHistory } from '../phone/phone-shell-gate.ts';
import { queryTag } from '../dom-helpers.ts';
import { isSettingsHash } from '../settings/settings-link.ts';
import { activateSettingsSection, canReturnToSettingsList, onPhoneSettingsScreenChanged, returnToSettingsList } from '../settings/settings-store.ts';
import { mountedViewModule } from '../view-registry.ts';
import { btnMute, btnStreamer } from './header-controls.ts';
import { powerMenu } from './power-menu.ts';
import { VIEW_TABS, acknowledgeViewAttention, clearSettingsHash, refreshViewOnShow, restoreDesktopViews } from './view-tabs.ts';

function mountPhoneLayout() {
  mountPhoneShell({
    panels: phonePanelsFromDesktopViews(VIEW_TABS),

    onScreenShown: (screenId: string) => {
      refreshViewOnShow(screenId);
      if (screenId !== 'settings') clearSettingsHash();
      if (screenId === 'settings' && !isSettingsHash(location.hash)) activateSettingsSection();
      acknowledgeViewAttention(screenId);
    },

    canGoBack: (screenId) => (screenId === 'settings' && canReturnToSettingsList()) || (screenId === 'prs' && canReturnToReviewQueue()),

    onBack: (screenId) => {
      if (screenId === 'settings') returnToSettingsList();
      if (screenId === 'prs') returnToReviewQueue();
    },

    headerControls: [
      queryTag(document, '.header-title', 'h1'),
      queryTag(document, '#status-indicator', 'div'),
      queryTag(document, '#celebration-tray', 'div'),
      queryTag(document, '#btn-add-session-header', 'button'),
      queryTag(document, '#btn-help', 'button'),
      btnMute,
      btnStreamer,
      powerMenu,
    ],
  });
  onPhoneSettingsScreenChanged(syncPhoneHistory);
  onPhoneReviewScreenChanged(syncPhoneHistory);
}

function applyFormFactorLayout(layout: string) {
  if (layout === 'phone') {
    const carriedSessionId = getFocusedSessionId();
    for (const viewTab of VIEW_TABS) mountedViewModule(viewTab.view)?.deactivate?.();
    const isSettingsLink = isSettingsHash(location.hash);
    void activatePhoneShell({
      sessionId: carriedSessionId ?? undefined,
      linkedScreenId: isSettingsLink ? 'settings' : undefined,
    }).then((isActivated) => {
      if (isActivated && isSettingsLink) activateSettingsSection(null, null, location.hash);
      if (!isActivated && isPhoneLayout() && !isPhoneShellActive()) restoreDesktopViews();
    });
    return;
  }
  const carriedSessionId = getPhoneSessionId();
  deactivatePhoneShell();
  restoreDesktopViews();

  if (carriedSessionId) centerSessionQuietly(carriedSessionId);
}

function mountLayoutSwitch() {
  mountPhoneLayout();
  if (isPhoneLayout()) applyFormFactorLayout('phone');
  onLayoutChange(applyFormFactorLayout);
}

export { mountLayoutSwitch };
