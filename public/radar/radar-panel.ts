import './radar-panel.css';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { buildPanelSection, el, externalLink, isPanelHidden, projectsOf } from '../dom-helpers.ts';
import { createInvestigationDialog, createRadarReportDialog } from '../dialogs.ts';
import type { InvestigationDialog } from '../dialogs.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, paintActionStatus, requestFailureText } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { createPollAgoTicker, formatAgo, formatDuration } from '../poll-ago.ts';
import { pickAdjacent } from '../focus-view/attention-core.ts';
import { isPhoneLayout, onLayoutChange } from '../form-factor.ts';
import { createRenderHold } from './radar-hold-core.ts';
import { createSettingsLink } from '../settings/settings-link.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { archiveInvestigationLocally, radarSnapshot, setRadarLookingProbe, subscribeRadar } from './radar-store.ts';
import type { RadarChange } from './radar-store.ts';
import {
  buildRadarQueue,
  dailyStripCells,
  finishedViewOf,
  isOpenInvestigationFrame,
  isQueueItemInFlight,
  findIssueInSnapshot,
  investigationViewOf,
  issueSummaryText,
  queueItemKeys,
  queueRowKey,
  radarLoadPhase,
  radarPlaceholder,
  selectionAfterRefresh,
  transientArchiveIds,
  verdictLabel,
} from './radar-core.ts';
import type {
  InvestigationFinishedFrame,
  QueueInvestigation,
  QueueItem,
  QueuePrimaryAction,
  QueueStage,
  QueueTier,
  RadarIssue,
  RadarProject,
  RadarQueue,
  RadarSnapshot,
} from './radar-core.ts';

type QueueActionId = QueuePrimaryAction | 'dismiss-fix' | 'resolve' | 'suppress';

interface QueueAction {
  actionId: QueueActionId;
  label: string;
  title: string;
  run: (cluster: ActionCluster) => void;
}

type ActionCluster = ReturnType<typeof createActionCluster>;

let _root: HTMLDivElement | null = null;

const _hold = createRenderHold({ render });

let _openInvestigation: { projectId: string; issueId: string; dialog: InvestigationDialog } | null = null;

let _selectedKey: string | null = null;
let _orderedKeys: string[] = [];
const _itemsByKey = new Map<string, QueueItem>();
const _rowsByKey = new Map<string, { row: HTMLElement; progress: HTMLElement }>();
let _pane: { element: HTMLElement; progress: HTMLElement | null; buttonsByAction: Map<QueueActionId, HTMLButtonElement> } | null = null;

const _pollTicker = createPollAgoTicker(() => _root);

const RADAR_ACTION_REPLY_TIMEOUT_MS = 30000;

const STAGE_LABELS: Record<QueueStage, string> = {
  1: 'seen',
  2: 'investigating',
  3: 'verdict',
  4: 'fix staged',
};

const TIER_HINTS: Record<QueueTier['name'], string> = {
  NOW: 'a fix to approve or a call only you can make',
  NEXT: 'moving, failed, or not yet looked at',
  LATER: 'quiet or explained',
};

const SELECTION_STEP_BY_KEY: Record<string, 1 | -1> = {
  j: 1,
  ArrowDown: 1,
  k: -1,
  ArrowUp: -1,
};

function issueReportId(issue: { issueId?: unknown } | null | undefined) {
  return typeof issue?.issueId === 'string' ? issue.issueId : '';
}

function openInvestigationView(issue: RadarIssue, projectId: unknown, projectLabel: string) {
  const issueId = issueReportId(issue);
  if (!issueId) return;
  _openInvestigation?.dialog.close();
  const dialog = createInvestigationDialog({
    issueTitle: String(issue.title || issueId),
    projectLabel,
    onOpenReport: () => openIssueReport(issue),
  });
  _openInvestigation = { projectId: String(projectId ?? ''), issueId, dialog };
  dialog.update(investigationViewOf(issue));
}

function refreshOpenInvestigation() {
  if (!_openInvestigation) return;
  if (!_openInvestigation.dialog.isOpen()) {
    _openInvestigation = null;
    return;
  }
  const issue = findIssueInSnapshot(radarSnapshot().latest, _openInvestigation.projectId, _openInvestigation.issueId);
  if (!issue) return;
  _openInvestigation.dialog.update(investigationViewOf(issue));
}

function openIssueReport(issue: { issueId?: unknown; title?: unknown }) {
  const issueId = issueReportId(issue);
  if (!issueId) return;
  sendControlRequest('get-radar-report', { issueId }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS })
    .then((msg) => {
      if (!msg.ok) {
        createRadarReportDialog({ issueId, issueTitle: String(issue.title ?? ''), error: String(msg.error || 'Could not read report') });
        return;
      }
      if (!msg.found) {
        createRadarReportDialog({ issueId, issueTitle: String(issue.title ?? ''), message: String(msg.message || 'Report not found') });
        return;
      }
      createRadarReportDialog({ issueId, issueTitle: String(issue.title ?? ''), format: String(msg.format ?? ''), content: String(msg.content || '') });
    })
    .catch((err: unknown) => {
      createRadarReportDialog({ issueId, issueTitle: String(issue.title ?? ''), error: requestFailureText(err, DEFAULT_REPLY_TIMEOUT_MS) });
    });
}

function createActionCluster() {
  const wrap = el('div', 'radar-actions');
  const status = el('span', 'radar-action-status');
  status.setAttribute('role', 'status');
  wrap.append(status);
  const buttons: HTMLButtonElement[] = [];
  let followUp: HTMLElement | null = null;

  const clearFollowUp = () => {
    followUp?.remove();
    followUp = null;
  };

  const showFollowUp = (element: HTMLElement) => {
    clearFollowUp();
    followUp = element;
    wrap.append(element);
  };

  const setBusy = (busy: boolean) => {
    for (const button of buttons) button.disabled = busy;
  };

  const addButton = (label: string, title: string, onClick: () => void) => {
    const button = el('button', 'radar-action', label);
    button.type = 'button';
    button.title = title;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    buttons.push(button);
    wrap.insertBefore(button, status);
    return button;
  };

  const request = (
    token: string,
    type: string,
    payload: Record<string, unknown>,
    pendingText: string,
    describe: (message: ServerMessage) => string,
    onOk: ((message: ServerMessage) => void) | null = null,
  ) => {
    _hold.begin(token);
    setBusy(true);
    clearFollowUp();
    paintActionStatus(status, 'busy', pendingText);
    const settle = (tone: 'ok' | 'error', text: string) => {
      setBusy(false);
      clearFollowUp();
      paintActionStatus(status, tone, text);
      _hold.settle(token);
    };
    const resolved = (msg: ServerMessage) => {
      if (!msg.ok) {
        settle('error', String(msg.error || 'Request failed'));
        return;
      }
      settle('ok', describe(msg));
      if (onOk) onOk(msg);
    };
    sendControlRequest(type, payload, { timeoutMs: RADAR_ACTION_REPLY_TIMEOUT_MS })
      .then(resolved)
      .catch((err: unknown) => settle('error', requestFailureText(err, RADAR_ACTION_REPLY_TIMEOUT_MS)));
  };

  const runSequence = (token: string, steps: readonly (() => Promise<string | null>)[], progressText: (doneCount: number) => string, doneText: string) => {
    _hold.begin(token);
    setBusy(true);
    clearFollowUp();
    const finish = (tone: 'ok' | 'error', text: string) => {
      setBusy(false);
      paintActionStatus(status, tone, text);
      _hold.settle(token);
      renderOrDefer();
    };
    const runFrom = (stepIndex: number) => {
      if (stepIndex >= steps.length) {
        finish('ok', doneText);
        return;
      }
      paintActionStatus(status, 'busy', progressText(stepIndex));
      steps[stepIndex]().then((errorText) => {
        if (errorText !== null) {
          finish('error', errorText);
          return;
        }
        runFrom(stepIndex + 1);
      });
    };
    runFrom(0);
  };

  return { addButton, request, runSequence, showFollowUp, wrap };
}

function openTraceView(sessionId: string) {
  radarSnapshot().traceOpener?.(sessionId);
}

function buildOpenTraceButton(sessionId: string) {
  const button = el('button', 'radar-action radar-open-trace', 'Open trace');
  button.type = 'button';
  button.title = 'Open the session trace';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    openTraceView(sessionId);
  });
  return button;
}

function archiveRequestStep(investigationId: string) {
  return () => sendControlRequest('radar-archive-investigation', { id: investigationId }, { timeoutMs: RADAR_ACTION_REPLY_TIMEOUT_MS })
    .then((msg) => {
      if (!msg.ok) return String(msg.error || 'Archive failed');
      archiveInvestigationLocally(investigationId);
      return null;
    })
    .catch((err: unknown) => requestFailureText(err, RADAR_ACTION_REPLY_TIMEOUT_MS));
}

function archiveSteps(investigations: readonly { id: string }[]) {
  return investigations.map((investigation) => archiveRequestStep(investigation.id));
}

function issueRequest(cluster: ActionCluster, item: QueueItem, requestType: string, requestPayload: Record<string, unknown>, pendingText: string, describe: (message: ServerMessage) => string, onOk: ((message: ServerMessage) => void) | null = null) {
  cluster.request(`${requestType}:${item.key}`, requestType, { projectId: item.projectId, issueId: item.issueId, ...requestPayload }, pendingText, describe, onOk);
}

function openSessionAction(item: QueueItem): QueueAction {
  return {
    actionId: 'open-session',
    label: 'Open session',
    title: 'Paste an investigation prompt into the mapped project session',
    run: (cluster) => issueRequest(
      cluster,
      item,
      'radar-open-session',
      {},
      'Opening session',
      (message) => (
        message.pending
          ? `Starting ${String(message.sessionName || 'session')}; the prompt lands when it is up`
          : `Prompt pasted into ${String(message.sessionName || 'the session')}; press Enter there`
      ),
      (message) => {
        if (typeof message.sessionId !== 'string' || !radarSnapshot().traceOpener) return;
        cluster.showFollowUp(buildOpenTraceButton(message.sessionId));
      },
    ),
  };
}

function fixActions(stagedFix: QueueInvestigation): QueueAction[] {
  return [
    {
      actionId: 'approve-fix',
      label: 'Approve PR',
      title: 'Open a session on the fix branch that reviews, tests, pushes and opens the pull request',
      run: (cluster) => cluster.request(`approve-fix:${stagedFix.id}`, 'radar-approve-fix', { id: stagedFix.id }, 'Opening a session', (message) => `Session ${String(message.sessionName ?? '')} opened`),
    },
    {
      actionId: 'dismiss-fix',
      label: 'Dismiss fix',
      title: 'Delete the local fix branch without opening a pull request',
      run: (cluster) => cluster.request(`dismiss-fix:${stagedFix.id}`, 'radar-dismiss-fix', { id: stagedFix.id }, 'Deleting the branch', () => 'Fix dismissed'),
    },
  ];
}

function liveIssueActions(item: QueueItem, issue: RadarIssue): QueueAction[] {
  const actions: QueueAction[] = [];
  if (issue.inFlight === true) {
    actions.push({
      actionId: 'view-investigation',
      label: 'View investigation',
      title: 'Watch the running investigation',
      run: () => openInvestigationView(issue, item.projectId, item.projectLabel),
    });
  }
  if (issue.inFlight !== true) actions.push(openSessionAction(item));
  actions.push({
    actionId: 'resolve',
    label: 'Resolve',
    title: 'Mark this issue resolved in PostHog',
    run: (cluster) => issueRequest(cluster, item, 'radar-issue-action', { action: 'resolve' }, 'Resolving in PostHog', () => 'Marked resolved'),
  });
  actions.push({
    actionId: 'suppress',
    label: 'Suppress',
    title: 'Suppress this issue in PostHog',
    run: (cluster) => openConfirmDialog({
      title: 'Suppress issue',
      message: 'This marks the issue suppressed in PostHog for everyone on the project.',
      confirmLabel: 'Suppress',
      danger: true,
      onConfirm: () => issueRequest(cluster, item, 'radar-issue-action', { action: 'suppress' }, 'Suppressing in PostHog', () => 'Marked suppressed'),
    }),
  });
  return actions;
}

function queueActionsOf(item: QueueItem): QueueAction[] {
  const actions: QueueAction[] = [];
  const stagedFix = item.investigations.find((investigation) => investigation.pendingFix !== null);
  if (stagedFix) actions.push(...fixActions(stagedFix));
  if (!isQueueItemInFlight(item) && item.verdict && item.issueId) {
    actions.push({
      actionId: 'open-report',
      label: 'Open report',
      title: 'Open the investigation report for this issue',
      run: () => openIssueReport({ issueId: item.issueId, title: item.issueTitle }),
    });
  }
  if (item.issue) actions.push(...liveIssueActions(item, item.issue));
  if (item.investigations.length > 0) {
    actions.push({
      actionId: 'archive',
      label: 'Archive',
      title: 'Remove this investigation from the queue',
      run: (cluster) => cluster.runSequence(`archive:${item.key}`, archiveSteps(item.investigations), () => 'Archiving', 'Archived'),
    });
  }
  return [...actions.filter((action) => action.actionId === item.primary), ...actions.filter((action) => action.actionId !== item.primary)];
}

function buildStageBar(stage: QueueStage, className: string) {
  const bar = el('span', className);
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `stage ${stage} of 4, ${STAGE_LABELS[stage]}`);
  bar.title = STAGE_LABELS[stage];
  for (let segment = 1; segment <= 4; segment += 1) {
    const cell = el('span', 'radar-stage-segment');
    if (segment <= stage) cell.dataset.filled = '';
    bar.append(cell);
  }
  return bar;
}

function verdictChip(item: QueueItem) {
  if (isQueueItemInFlight(item)) {
    const chip = el('span', 'radar-verdict', 'investigating');
    chip.dataset.verdict = 'INVESTIGATING';
    return chip;
  }
  if (item.stage === 4) {
    const chip = el('span', 'radar-verdict', 'fix staged');
    chip.dataset.verdict = 'FIX_STAGED';
    return chip;
  }
  if (!item.verdict) return null;
  const chip = el('span', 'radar-verdict', verdictLabel(item.verdict));
  chip.dataset.verdict = item.verdict;
  return chip;
}

function changeChip(item: QueueItem) {
  if (!item.change) return null;
  const chip = el('span', 'radar-change', item.change);
  chip.dataset.change = item.change;
  return chip;
}

function itemMetaLine(item: QueueItem, className: string) {
  const meta = el('span', className);
  if (item.projectLabel) meta.append(el('span', 'radar-row-project', item.projectLabel));
  const change = changeChip(item);
  if (change) meta.append(change);
  const verdict = verdictChip(item);
  if (verdict) meta.append(verdict);
  if (item.issue) meta.append(el('span', 'radar-row-users', `${Number(item.issue.users) || 0} users`));
  return meta;
}

function progressTextOf(item: QueueItem) {
  if (!isQueueItemInFlight(item)) return '';
  return issueSummaryText(item.issue);
}

function buildQueueRow(item: QueueItem) {
  const row = el('div', 'radar-row');
  row.dataset.key = item.key;
  row.dataset.tier = item.tier;
  row.tabIndex = -1;
  const copy = el('span', 'radar-row-copy');
  copy.append(el('span', 'radar-row-headline', item.headline));
  const progress = el('span', 'radar-row-progress', progressTextOf(item));
  copy.append(progress, itemMetaLine(item, 'radar-row-meta'));
  row.append(buildStageBar(item.stage, 'radar-stage'), copy);
  row.addEventListener('click', () => selectKey(item.key, { focusRow: true }));
  _rowsByKey.set(item.key, { row, progress });
  return row;
}

function startOfTodayMs() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.getTime();
}

function buildDailyStrip(item: QueueItem) {
  const wrap = el('div', 'radar-strip');
  wrap.append(el('span', 'radar-pane-label', 'Last 14 days'));
  if (!item.dailyVolume) {
    wrap.append(el('span', 'radar-strip-unavailable', 'daily volume unavailable'));
    return wrap;
  }
  const cells = dailyStripCells(item.dailyVolume, {
    todayStartMs: startOfTodayMs(),
    investigationAts: item.investigations.map((investigation) => investigation.at),
    isHot: item.change === 'spiking' || item.change === 'regressed',
  });
  const strip = el('span', 'radar-strip-cells');
  strip.setAttribute('role', 'img');
  strip.setAttribute('aria-label', `occurrences per day, oldest first: ${item.dailyVolume.join(', ')}`);
  for (const cell of cells) {
    const day = el('span', 'radar-strip-cell');
    day.dataset.level = String(cell.level);
    if (cell.hasInvestigation) day.dataset.investigated = '';
    const dayText = new Date(cell.dayStartMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    day.title = `${dayText}: ${cell.occurrences} ${cell.occurrences === 1 ? 'occurrence' : 'occurrences'}${cell.hasInvestigation ? ', investigated' : ''}`;
    strip.append(day);
  }
  wrap.append(strip);
  return wrap;
}

function issueUrlOf(item: QueueItem) {
  const issueUrl = item.issue?.url ?? item.investigations[0]?.url;
  return typeof issueUrl === 'string' ? issueUrl : null;
}

function fixDetailLines(item: QueueItem) {
  const lines: HTMLElement[] = [];
  for (const investigation of item.investigations) {
    if (investigation.pendingFix) {
      const fix = investigation.pendingFix;
      const expiry = fix.expiresAt > 0 ? `, deleted ${new Date(fix.expiresAt).toLocaleDateString()} unless approved` : '';
      lines.push(el('p', 'radar-pane-text', `Fix waiting on local branch ${fix.branch}${expiry}. Agent title: ${fix.agentPrTitle || '(none)'}`));
    }
    if (investigation.prUrl) {
      const pr = el('a', 'radar-investigation-pr', 'fix PR');
      pr.href = investigation.prUrl;
      pr.target = '_blank';
      pr.rel = 'noopener';
      pr.title = investigation.prUrl;
      lines.push(pr);
    }
  }
  return lines;
}

function buildPane(item: QueueItem) {
  const pane = el('div', 'radar-pane');
  pane.setAttribute('aria-label', 'Selected item');
  pane.append(el('h3', 'radar-pane-headline', item.headline));
  const issueUrl = issueUrlOf(item);
  const isHeadlineTheTitle = item.headline === item.issueTitle;
  if (!isHeadlineTheTitle) pane.append(externalLink('radar-issue-title', item.issueTitle, issueUrl, item.issueTitle));
  if (isHeadlineTheTitle && issueUrl) pane.append(externalLink('radar-issue-title', 'View in PostHog', issueUrl, item.issueTitle));
  const stageLine = el('div', 'radar-pane-stage');
  stageLine.append(buildStageBar(item.stage, 'radar-stage radar-stage-wide'), el('span', 'radar-pane-stage-label', STAGE_LABELS[item.stage]));
  pane.append(itemMetaLine(item, 'radar-pane-meta'), stageLine);
  const progressText = progressTextOf(item);
  const progress = isQueueItemInFlight(item) ? el('p', 'radar-pane-text', progressText) : null;
  if (progress) pane.append(progress);
  pane.append(buildDailyStrip(item));
  if (item.issue) {
    pane.append(el('p', 'radar-pane-text', `${Number(item.issue.occurrences) || 0} occurrences, ${Number(item.issue.users) || 0} users in the poll window`));
  }
  pane.append(...fixDetailLines(item));
  const cluster = createActionCluster();
  const buttonsByAction = new Map<QueueActionId, HTMLButtonElement>();
  for (const action of queueActionsOf(item)) {
    const button = cluster.addButton(action.label, action.title, () => action.run(cluster));
    if (action.actionId === item.primary) button.dataset.primary = '';
    buttonsByAction.set(action.actionId, button);
  }
  pane.append(cluster.wrap);
  return { element: pane, progress, buttonsByAction };
}

function placePane() {
  if (!_root || !_pane) return;
  const selectedRow = _selectedKey ? _rowsByKey.get(_selectedKey)?.row : null;
  if (isPhoneLayout() && selectedRow) {
    selectedRow.after(_pane.element);
    return;
  }
  _root.querySelector('.radar-pane-slot')?.append(_pane.element);
}

function showPaneFor(key: string | null) {
  _pane?.element.remove();
  _pane = null;
  const item = key ? _itemsByKey.get(key) : null;
  if (!item) return;
  _pane = buildPane(item);
  placePane();
}

function selectKey(key: string, { focusRow }: { focusRow: boolean }) {
  const previous = _selectedKey ? _rowsByKey.get(_selectedKey) : null;
  const next = _rowsByKey.get(key);
  if (!next) return;
  if (_selectedKey !== key) {
    previous?.row.removeAttribute('aria-current');
    if (previous) previous.row.tabIndex = -1;
    next.row.setAttribute('aria-current', 'true');
    next.row.tabIndex = 0;
    _selectedKey = key;
    showPaneFor(key);
  }
  if (focusRow) next.row.focus();
}

function clickPaneAction(actionId: QueueActionId) {
  const button = _pane?.buttonsByAction.get(actionId);
  if (!button || button.disabled) return;
  button.click();
}

function onQueueKeydown(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('radar-row')) return;
  const step = SELECTION_STEP_BY_KEY[event.key];
  if (step !== undefined) {
    event.preventDefault();
    const nextKey = pickAdjacent(_orderedKeys, _selectedKey, step);
    if (nextKey) selectKey(nextKey, { focusRow: true });
    return;
  }
  const item = _selectedKey ? _itemsByKey.get(_selectedKey) : null;
  if (!item) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    clickPaneAction(item.primary);
    return;
  }
  if (event.key === 'e' || event.key === 'E') {
    event.preventDefault();
    clickPaneAction('archive');
  }
}

function buildArchiveTransientControl(queue: RadarQueue) {
  const investigationIds = transientArchiveIds(queue);
  if (investigationIds.length === 0) return null;
  const cluster = createActionCluster();
  cluster.addButton('Archive transient', 'Archive every transient investigation in LATER', () => {
    const total = investigationIds.length;
    cluster.runSequence('archive-transient', archiveSteps(investigationIds.map((id) => ({ id }))), (doneCount) => `Archiving ${doneCount + 1} of ${total}`, `Archived ${total}`);
  });
  return cluster.wrap;
}

function buildTier(tier: QueueTier, queue: RadarQueue) {
  const block = el('div', 'radar-tier');
  block.dataset.tier = tier.name;
  const head = el('div', 'radar-tier-head');
  head.append(el('h3', 'radar-tier-name', tier.name), el('span', 'radar-tier-count', String(tier.items.length)), el('span', 'radar-tier-hint', TIER_HINTS[tier.name]));
  const archiveControl = tier.name === 'LATER' ? buildArchiveTransientControl(queue) : null;
  if (archiveControl) head.append(archiveControl);
  block.append(head);
  const list = el('div', 'radar-tier-rows');
  for (const item of tier.items) list.append(buildQueueRow(item));
  block.append(list);
  return block;
}

function alertLineText(alert: RadarQueue['projectAlerts'][number]) {
  if (alert.error) return `${alert.projectLabel}: poll failed: ${alert.error}`;
  return `${alert.projectLabel}: stale ${formatDuration(alert.staleMs)}`;
}

function buildFooter(queue: RadarQueue, intervalMinutes: number) {
  const footer = el('div', 'radar-footer');
  for (const alert of queue.projectAlerts) {
    const line = el('p', 'radar-footer-alert', alertLineText(alert));
    line.dataset.tone = alert.error ? 'crit' : 'warn';
    footer.append(line);
  }
  const statusLine = el('p', 'radar-footer-line');
  if (queue.quietProjectLabels.length > 0) statusLine.append(el('span', 'radar-footer-quiet', `Quiet: ${queue.quietProjectLabels.join(', ')}`));
  const tick = el('span', 'radar-global-tick');
  _pollTicker.track(tick, radarSnapshot().latest?.ts, (polledAtMs) => {
    const polled = `polled ${formatAgo(polledAtMs)}`;
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return polled;
    return `${polled}, every ${intervalMinutes}m`;
  });
  statusLine.append(tick);
  footer.append(statusLine);
  return footer;
}

function buildSkeleton() {
  const list = el('div', 'radar-tier-rows');
  list.setAttribute('aria-busy', 'true');
  list.setAttribute('aria-label', 'Loading issues');
  for (let rowIndex = 0; rowIndex < 5; rowIndex += 1) {
    const row = el('div', 'radar-row');
    row.dataset.skeleton = '';
    row.append(el('span', 'radar-stage'), el('span', 'radar-row-copy'));
    list.append(row);
  }
  return list;
}

function radarSettingsLeadIn(status: RadarSnapshot | null) {
  if (status?.configured !== false) return '';
  const hasReason = typeof status.reason === 'string' && status.reason.trim() !== '';
  return hasReason ? 'Fix it in' : 'Switch it on in';
}

function buildPlaceholder() {
  const placeholder = el('p', 'radar-unconfigured', radarPlaceholder(radarSnapshot().latest));
  const link = createSettingsLink('lanes-posthog', 'posthog-enabled', 'PostHog settings');
  const settingsLeadIn = radarSettingsLeadIn(radarSnapshot().latest);
  placeholder.append(document.createTextNode(settingsLeadIn ? ` ${settingsLeadIn} ` : ' '), link);
  return placeholder;
}

function buildQueueSection(queue: RadarQueue, intervalMinutes: number) {
  const section = buildPanelSection('radar', 'Errors');
  const tiers = queue.tiers.filter((tier) => tier.items.length > 0);
  if (tiers.length === 0) {
    section.append(el('p', 'radar-empty', 'Nothing needs you.'), buildFooter(queue, intervalMinutes));
    return section;
  }
  const layout = el('div', 'radar-queue-layout');
  const list = el('div', 'radar-queue');
  list.setAttribute('aria-label', 'Radar queue; J and K move, Enter runs the first action, E archives');
  list.addEventListener('keydown', onQueueKeydown);
  for (const tier of tiers) list.append(buildTier(tier, queue));
  layout.append(list, el('div', 'radar-pane-slot'));
  section.append(layout, buildFooter(queue, intervalMinutes));
  return section;
}

function clearQueueState() {
  _rowsByKey.clear();
  _itemsByKey.clear();
  _orderedKeys = [];
  _pane = null;
}

function render() {
  if (!_root) return;
  const hadRowFocus = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('radar-row') && _root.contains(document.activeElement);
  _root.textContent = '';
  clearQueueState();
  _pollTicker.reset();
  const { latest, archivedLocally } = radarSnapshot();
  const projects = projectsOf<RadarProject>(latest);
  const loadPhase = radarLoadPhase(latest, projects.length);
  if (loadPhase === 'pending') {
    const section = buildPanelSection('radar', 'Errors');
    section.append(buildSkeleton());
    _root.append(section);
    return;
  }
  if (loadPhase === 'placeholder' || projects.length === 0) {
    const section = buildPanelSection('radar', 'Errors');
    section.append(buildPlaceholder());
    _root.append(section);
    return;
  }
  const intervalMinutes = Number(latest?.intervalMinutes);
  const queue = buildRadarQueue(latest, { archivedLocally, nowMs: Date.now(), intervalMs: intervalMinutes > 0 ? intervalMinutes * 60000 : 0 });
  for (const tier of queue.tiers) for (const item of tier.items) _itemsByKey.set(item.key, item);
  _orderedKeys = queueItemKeys(queue);
  _root.append(buildQueueSection(queue, intervalMinutes));
  const nextKey = selectionAfterRefresh(_orderedKeys, _selectedKey);
  _selectedKey = null;
  if (nextKey) selectKey(nextKey, { focusRow: hadRowFocus });
}

function renderOrDefer() {
  _hold.request();
}

function patchInFlightProgress(projectId: unknown, issueId: unknown, issue: RadarIssue | null) {
  const key = queueRowKey(projectId, issueId);
  const handle = _rowsByKey.get(key);
  if (!handle?.row.isConnected) return false;
  const text = issueSummaryText(issue);
  handle.progress.textContent = text;
  if (_selectedKey === key && _pane?.progress) _pane.progress.textContent = text;
  return true;
}

function finishOpenInvestigationFromFrame(frame: InvestigationFinishedFrame) {
  if (!_openInvestigation?.dialog.isOpen()) return;
  if (!isOpenInvestigationFrame(_openInvestigation, frame)) return;
  _openInvestigation.dialog.update(finishedViewOf(frame));
}

function applyRadarChange(change: RadarChange) {
  if (change.kind === 'status') {
    renderOrDefer();
    refreshOpenInvestigation();
    return;
  }
  if (change.kind === 'investigation-activity') {
    refreshOpenInvestigation();
    const issue = findIssueInSnapshot(radarSnapshot().latest, change.projectId, change.issueId);
    if (change.wasInFlight && patchInFlightProgress(change.projectId, change.issueId, issue)) return;
    renderOrDefer();
    return;
  }
  if (!change.isPatched) {
    finishOpenInvestigationFromFrame(change.frame);
    return;
  }
  refreshOpenInvestigation();
  renderOrDefer();
}

function mountRadarView(parent: HTMLElement) {
  if (_root) return;
  const root = el('div', 'radar-content');
  parent.appendChild(root);
  _root = root;
  setRadarLookingProbe(() => !isPanelHidden(_root));
  subscribeRadar(applyRadarChange);
  onLayoutChange(placePane);
  _pollTicker.ensure();
  render();
}

export const view: ViewModule<HTMLElement> = { mount: mountRadarView };
