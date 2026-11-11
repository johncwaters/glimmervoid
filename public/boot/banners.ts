import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { trackedReportNoticeText } from '#shared/post-turn-leftovers.ts';
import { describeFailure } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';
import { queryTag, writeClipboardText } from '../dom-helpers.ts';
import { CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { UPDATES_ACTIONS_SETTING_ID, UPDATES_SECTION_ID } from '../radar/radar-core.ts';
import { createSettingsLink } from '../settings/settings-link.ts';
import { shouldShowTelemetryNotice } from '../telemetry-notice-core.ts';
import { getDismissedUpdate, isTelemetryNoticeDismissed, setDismissedUpdate, setTelemetryNoticeDismissed } from '../ui-prefs.ts';
import { updateBanner } from '../updates-view-core.ts';
import { confirmServerRestart } from '../server-power.ts';

const updateRestartButton = button({ variant: 'primary', size: 'small', label: 'Restart', action: 'restart-to-update', hidden: true });
const updateCopyButton = button({ variant: 'secondary', size: 'small', label: 'Copy', action: 'copy-update-command' });
const updateDismissButton = button({ variant: 'icon', size: 'small', label: 'Dismiss update notice', icon: createLineIcon(CLOSE_ICON_PATH), action: 'dismiss-update-banner' });
queryTag(document, '#update-banner-cmd', 'code').before(updateRestartButton);
queryTag(document, '#update-banner-copy-status', 'span').before(updateCopyButton);
queryTag(document, '#update-banner', 'div').append(updateDismissButton);

const leftoversCopyButton = button({ variant: 'secondary', size: 'small', label: 'Copy', action: 'copy-leftovers-command' });
const leftoversDismissButton = button({ variant: 'icon', size: 'small', label: 'Dismiss old report notice', icon: createLineIcon(CLOSE_ICON_PATH), action: 'dismiss-leftovers-banner' });
queryTag(document, '#post-turn-leftovers-copy-status', 'span').before(leftoversCopyButton);
queryTag(document, '#post-turn-leftovers-banner', 'div').append(leftoversDismissButton);

let dismissedUpdateBannerIdentity: string | null | undefined;
let dismissedSecurityNoticeText: string | null = null;

function bindBannerCopy(copyButton: HTMLButtonElement, copyStatus: HTMLSpanElement, text: string) {
  copyButton.onclick = () => {
    const write = writeClipboardText(text);
    if (!write) {
      copyStatus.textContent = 'Copy failed';
      return;
    }
    write
      .then(() => { copyStatus.textContent = 'Copied'; })
      .catch(() => { copyStatus.textContent = 'Copy failed'; });
  };
}

const UPDATES_SECTION_HREF = createSettingsLink(UPDATES_SECTION_ID, UPDATES_ACTIONS_SETTING_ID, 'Update').href;

function updateIdentity(msg: ServerMessageOf<'update-status'>) {
  const { latestSha, latest } = msg;
  if (typeof latest === 'string' && latest) return latest;
  if (typeof latestSha === 'string' && latestSha) return latestSha;
  return null;
}

function showUpdateBanner(msg: ServerMessageOf<'update-status'>) {
  const banner = queryTag(document, '#update-banner', 'div');
  const { mode, tone, text } = updateBanner(msg);
  const isSecurityNotice = tone === 'security';
  if (!msg.updateAvailable && !isSecurityNotice) {
    banner.hidden = true;
    return;
  }
  const updateId = updateIdentity(msg);
  const identity = updateId && mode === 'restart' ? `${updateId}:ready` : updateId;
  if (isSecurityNotice && text === dismissedSecurityNoticeText) return;
  if (!isSecurityNotice && dismissedUpdateBannerIdentity !== undefined && identity === dismissedUpdateBannerIdentity) return;
  if (!isSecurityNotice && identity && getDismissedUpdate() === identity) return;
  banner.classList.toggle('update-banner-security', isSecurityNotice);
  const command = String(msg.command ?? '');
  queryTag(document, '#update-banner-text', 'span').textContent = text;
  queryTag(document, '#update-banner-cmd', 'code').textContent = command;
  const updateLink = queryTag(document, '#update-banner-update', 'a');
  updateLink.href = UPDATES_SECTION_HREF;
  updateLink.hidden = mode !== 'link';
  updateRestartButton.hidden = mode !== 'restart';
  updateRestartButton.onclick = confirmServerRestart;
  const commandEl = queryTag(document, '#update-banner-cmd', 'code');
  commandEl.hidden = mode !== 'command';
  updateCopyButton.hidden = mode !== 'command';
  const copyStatus = queryTag(document, '#update-banner-copy-status', 'span');
  copyStatus.hidden = mode !== 'command';
  copyStatus.textContent = '';
  const link = queryTag(document, '#update-banner-link', 'a');
  link.hidden = !msg.releaseUrl;
  link.href = typeof msg.releaseUrl === 'string' ? msg.releaseUrl : '';
  banner.hidden = false;

  bindBannerCopy(updateCopyButton, copyStatus, command);
  updateDismissButton.onclick = () => {
    banner.hidden = true;
    if (isSecurityNotice) {
      dismissedSecurityNoticeText = text;
      return;
    }
    dismissedUpdateBannerIdentity = identity;
    setDismissedUpdate(identity);
  };
}

let isPostTurnLeftoversBannerDismissed = false;

function showPostTurnLeftoversBanner({ repositories, command }: ServerMessageOf<'post-turn-leftovers'>) {
  const banner = queryTag(document, '#post-turn-leftovers-banner', 'div');
  if (repositories.length === 0) {
    banner.hidden = true;
    return;
  }
  if (isPostTurnLeftoversBannerDismissed) return;
  const copyStatus = queryTag(document, '#post-turn-leftovers-copy-status', 'span');
  queryTag(document, '#post-turn-leftovers-text', 'span').textContent = trackedReportNoticeText(repositories.length);
  queryTag(document, '#post-turn-leftovers-cmd', 'code').textContent = command;
  copyStatus.textContent = '';
  banner.hidden = false;
  bindBannerCopy(leftoversCopyButton, copyStatus, command);
  leftoversDismissButton.onclick = () => {
    isPostTurnLeftoversBannerDismissed = true;
    banner.hidden = true;
  };
}

const telemetryBanner = queryTag(document, '#telemetry-banner', 'div');
const telemetryDismissButton = button({ variant: 'secondary', size: 'small', label: 'Dismiss', action: 'dismiss-telemetry-banner' });
telemetryBanner.append(telemetryDismissButton);

function dismissTelemetryBanner() {
  setTelemetryNoticeDismissed(true);
  telemetryBanner.hidden = true;
}

function syncTelemetryBanner(settings: unknown) {
  telemetryBanner.hidden = !shouldShowTelemetryNotice(settings, isTelemetryNoticeDismissed());
}

function mountTelemetryBanner() {
  const telemetrySettingsLink = queryTag(document, '#telemetry-banner-settings', 'a');
  telemetrySettingsLink.href = createSettingsLink('privacy', 'telemetry-enabled', "What's collected").href;
  telemetrySettingsLink.addEventListener('click', dismissTelemetryBanner);
  telemetryDismissButton.addEventListener('click', dismissTelemetryBanner);
}

function showStarHintCard() {
  void import('../feature-hint.ts').then(
    (featureHint) => featureHint.showStarHint(),
    (error: unknown) => reportToServerLog('star-hint', `star card failed to load: ${describeFailure(error)}`),
  );
}

export { mountTelemetryBanner, showPostTurnLeftoversBanner, showStarHintCard, showUpdateBanner, syncTelemetryBanner };
