import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { trackedReportNoticeText } from '#shared/post-turn-leftovers.ts';
import { describeFailure } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { createNotice, noticeStack } from '../ui/notice.ts';
import { UPDATES_ACTIONS_SETTING_ID, UPDATES_SECTION_ID } from '../radar/radar-core.ts';
import { createSettingsLink } from '../settings/settings-link.ts';
import { shouldShowTelemetryNotice } from '../telemetry-notice-core.ts';
import { getDismissedUpdate, isTelemetryNoticeDismissed, setDismissedUpdate, setTelemetryNoticeDismissed } from '../ui-prefs.ts';
import { updateBanner } from '../updates-view-core.ts';
import { confirmServerRestart } from '../server-power.ts';

const UPDATES_SECTION_HREF = createSettingsLink(UPDATES_SECTION_ID, UPDATES_ACTIONS_SETTING_ID, 'Update').href;

let dismissedUpdateBannerIdentity: string | null | undefined;
let dismissedSecurityNoticeText: string | null = null;
let onUpdateNoticeDismissed = () => {};

const updateNotice = createNotice({ id: 'update-notice', dismissLabel: 'Dismiss update notice', isDismissIcon: true, onDismiss: () => onUpdateNoticeDismissed() });

let isPostTurnLeftoversBannerDismissed = false;
const leftoversNotice = createNotice({
  id: 'post-turn-leftovers-notice',
  dismissLabel: 'Dismiss old report notice',
  isDismissIcon: true,
  onDismiss: () => { isPostTurnLeftoversBannerDismissed = true; },
});

const telemetryCat = el('span', 'notice-telemetry-cat');
telemetryCat.setAttribute('aria-hidden', 'true');
const telemetryNotice = createNotice({
  id: 'telemetry-notice',
  dismissLabel: 'Dismiss',
  isDismissIcon: false,
  leading: telemetryCat,
  onDismiss: () => setTelemetryNoticeDismissed(true),
});

noticeStack().append(updateNotice.element, leftoversNotice.element, telemetryNotice.element);

function noticeLink(label: string, href: string, isExternal: boolean) {
  const link = el('a', 'notice-link', label);
  link.href = href;
  if (!isExternal) return link;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function updateIdentity(msg: ServerMessageOf<'update-status'>) {
  const { latestSha, latest } = msg;
  if (typeof latest === 'string' && latest) return latest;
  if (typeof latestSha === 'string' && latestSha) return latestSha;
  return null;
}

function updateNoticeActions(msg: ServerMessageOf<'update-status'>, mode: string) {
  const actions: HTMLElement[] = [];
  if (typeof msg.releaseUrl === 'string' && msg.releaseUrl) actions.push(noticeLink('View changes', msg.releaseUrl, true));
  if (mode === 'link') actions.push(noticeLink('Update', UPDATES_SECTION_HREF, false));
  if (mode === 'restart') actions.push(button({ variant: 'primary', size: 'small', label: 'Restart', action: 'restart-to-update', onClick: confirmServerRestart }));
  return actions;
}

function showUpdateBanner(msg: ServerMessageOf<'update-status'>) {
  const { mode, tone, text } = updateBanner(msg);
  const isSecurityNotice = tone === 'security';
  if (!msg.updateAvailable && !isSecurityNotice) {
    updateNotice.hide();
    return;
  }
  const updateId = updateIdentity(msg);
  const identity = updateId && mode === 'restart' ? `${updateId}:ready` : updateId;
  if (isSecurityNotice && text === dismissedSecurityNoticeText) return;
  if (!isSecurityNotice && dismissedUpdateBannerIdentity !== undefined && identity === dismissedUpdateBannerIdentity) return;
  if (!isSecurityNotice && identity && getDismissedUpdate() === identity) return;
  updateNotice.show({
    text,
    tone: isSecurityNotice ? 'failed' : undefined,
    actions: updateNoticeActions(msg, mode),
    command: mode === 'command' ? String(msg.command ?? '') : '',
  });
  onUpdateNoticeDismissed = () => {
    if (isSecurityNotice) {
      dismissedSecurityNoticeText = text;
      return;
    }
    dismissedUpdateBannerIdentity = identity;
    setDismissedUpdate(identity);
  };
}

function showPostTurnLeftoversBanner({ repositories, command }: ServerMessageOf<'post-turn-leftovers'>) {
  if (repositories.length === 0) {
    leftoversNotice.hide();
    return;
  }
  if (isPostTurnLeftoversBannerDismissed) return;
  leftoversNotice.show({ text: trackedReportNoticeText(repositories.length), command });
}

function syncTelemetryBanner(settings: unknown) {
  if (!shouldShowTelemetryNotice(settings, isTelemetryNoticeDismissed())) {
    telemetryNotice.hide();
    return;
  }
  if (telemetryNotice.isShown()) return;
  const settingsLink = noticeLink("What's collected", createSettingsLink('privacy', 'telemetry-enabled', "What's collected").href, false);
  settingsLink.addEventListener('click', () => {
    setTelemetryNoticeDismissed(true);
    telemetryNotice.hide();
  });
  telemetryNotice.show({ text: 'Glimmervoid collects usage data to help us improve it. No prompts or project information are collected.', actions: [settingsLink] });
}

function showStarHintCard() {
  void import('../feature-hint.ts').then(
    (featureHint) => featureHint.showStarHint(),
    (error: unknown) => reportToServerLog('star-hint', `star card failed to load: ${describeFailure(error)}`),
  );
}

export { showPostTurnLeftoversBanner, showStarHintCard, showUpdateBanner, syncTelemetryBanner };
