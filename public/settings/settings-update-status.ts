import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { formatAgo } from '../poll-ago.ts';
import { requestUpdateApply, requestUpdateCheck, restartServer, settingsUpdateState } from './settings-store.ts';
import { installedUpdateText, lastUpdateCheckText, latestUpdateDetails, projectUpdateProgress, shouldAutoCheckUpdates, shouldShowLatestUpdate, updateControls, updateSummary } from '../updates-view-core.ts';
import type { UpdateActionId } from '../updates-view-core.ts';
import { setAutoUpdateCheckAwaitingStatus, settingsPayload } from './settings-panel-state.ts';

function buildUpdateActionStatus(reason: string | null) {
  const status = el('span', 'settings-update-action-status', reason ?? '');
  status.setAttribute('role', 'status');
  return status;
}

function updateCheckStatusText(): string | null {
  const { isCheckInFlight, checkSendFailure } = settingsUpdateState();
  if (isCheckInFlight) return 'Checking for updates.';
  return checkSendFailure;
}

function checkUpdatesIfStale() {
  const { status: updateStatus, lastAutoCheckAt } = settingsUpdateState();
  if (!updateStatus) {
    setAutoUpdateCheckAwaitingStatus(true);
    return;
  }
  setAutoUpdateCheckAwaitingStatus(false);
  const isStale = shouldAutoCheckUpdates({
    status: updateStatus,
    checkForUpdates: settingsPayload.checkForUpdates,
    now: Date.now(),
    lastAutoCheckAt,
  });
  if (isStale) requestUpdateCheck();
}

function buildUpdateAction(action: UpdateActionId) {
  if (action === 'update') return button({ variant: 'primary', label: 'Update', action: 'apply-update', onClick: requestUpdateApply });
  if (action === 'restart') return button({ variant: 'primary', label: 'Restart', action: 'restart-server', onClick: restartServer });
  return button({ variant: 'secondary', label: 'Check for updates', action: 'check-for-updates', disabled: settingsUpdateState().isCheckInFlight, onClick: requestUpdateCheck });
}

function buildUpdateActions() {
  const { status, journal, request } = settingsUpdateState();
  const decided = updateControls({ status, journal, request });
  const actions = el('div', 'settings-update-actions');
  if (decided.actions.length > 0) {
    const buttons = el('div', 'settings-update-buttons');
    buttons.append(...decided.actions.map(buildUpdateAction));
    actions.appendChild(buttons);
  }
  const checkStatusText = updateCheckStatusText();
  if (checkStatusText) actions.appendChild(buildUpdateActionStatus(checkStatusText));
  if (decided.note) actions.appendChild(buildUpdateActionStatus(decided.note));
  if (decided.command) actions.appendChild(el('code', 'settings-update-command', decided.command));
  return actions;
}

function buildUpdateFact(label: string, ...content: (string | HTMLElement)[]) {
  const row = el('div', 'settings-update-fact');
  row.append(el('span', 'settings-update-fact-label', label), ...content);
  return row;
}

function buildUpdateProgress() {
  const projection = projectUpdateProgress(settingsUpdateState().journal);
  if (!projection) return null;
  const panel = el('div', 'settings-update-progress');
  panel.dataset.state = projection.state;
  panel.setAttribute('role', 'status');
  const isFailed = projection.state === 'failed';
  if (projection.terminalLine) panel.appendChild(el('div', isFailed ? 'dialog-error' : 'settings-update-terminal', projection.terminalLine));
  const record = isFailed ? buildUpdateFailureDetails(panel, projection.failureDetail) : panel;
  const list = el('ol', 'settings-update-steps');
  for (const step of projection.steps) {
    const item = el('li', 'settings-update-step');
    item.dataset.status = step.status;
    item.append(
      el('span', 'settings-update-step-state', step.status),
      el('span', 'settings-update-step-label', step.label),
    );
    list.appendChild(item);
  }
  record.appendChild(list);
  if (projection.outputTail.length === 0) return panel;
  const output = el('pre', 'settings-update-output', projection.outputTail.join('\n'));
  if (projection.outputStepId) output.dataset.step = projection.outputStepId;
  if (!projection.outputStepLabel) {
    record.appendChild(output);
    return panel;
  }
  const caption = `Output from ${projection.outputStepLabel}`;
  output.setAttribute('aria-label', caption);
  record.append(el('div', 'settings-update-output-label', caption), output);
  return panel;
}

function buildUpdateFailureDetails(panel: HTMLElement, failureDetail: string | null) {
  const details = el('details', 'settings-update-details');
  details.appendChild(el('summary', 'settings-update-details-summary', 'Show details'));
  if (failureDetail) details.appendChild(el('div', 'settings-update-failure-detail', failureDetail));
  panel.appendChild(details);
  return details;
}

function buildLatestUpdateFact() {
  const latest = latestUpdateDetails(settingsUpdateState().status);
  const latestParts: (string | HTMLElement)[] = [latest.label];
  if (latest.releaseUrl) {
    const release = el('a', 'settings-link', 'View release');
    release.href = latest.releaseUrl;
    release.target = '_blank';
    release.rel = 'noopener noreferrer';
    latestParts.push(release);
  }
  return buildUpdateFact('Latest', ...latestParts);
}

function buildUpdateStatusBlock() {
  const block = el('div', 'settings-view-status-block settings-update-status');
  const { status: updateStatus, journal: updateJournal } = settingsUpdateState();
  const summary = updateSummary(updateStatus, updateJournal);
  const headline = el('div', 'settings-update-summary', summary.headline);
  headline.dataset.tone = summary.tone;
  block.appendChild(headline);
  block.appendChild(buildUpdateFact('Running', installedUpdateText(updateStatus)));
  if (shouldShowLatestUpdate(updateStatus)) block.appendChild(buildLatestUpdateFact());
  const lastCheckedAt = typeof updateStatus?.lastCheckAt === 'number' ? updateStatus.lastCheckAt : null;
  const lastChecked = buildUpdateFact('Last checked', lastUpdateCheckText({
    status: updateStatus,
    checkForUpdates: settingsPayload.checkForUpdates,
    relativeTime: formatAgo(lastCheckedAt),
  }));
  if (lastCheckedAt) lastChecked.title = new Date(lastCheckedAt).toLocaleString();
  block.appendChild(lastChecked);
  block.appendChild(buildUpdateActions());
  const progress = buildUpdateProgress();
  if (progress) block.appendChild(progress);
  return block;
}

export { buildUpdateStatusBlock, checkUpdatesIfStale };
