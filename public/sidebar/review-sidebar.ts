import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { ChangeMap } from '#shared/contracts/change-map.ts';
import type { SessionState } from '#shared/states.ts';
import { MERGEABLE_LIVE_STATES, STATES } from '#shared/states.ts';
import { wireColumnResizer } from '../column-resizer.ts';
import { sendControlMsg } from '../control-ws.ts';
import { adoptElement, el, releaseElement } from '../dom-helpers.ts';
import { isPhoneLayout } from '../form-factor.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionIdOf, sessionUIs } from '../session-card/card-registry.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { shortcutHint } from '../shortcuts-core.ts';
import { createLineIcon, MORE_ICON_PATH } from '../svg-dom.ts';
import { getSidebarWidth, isReviewSidebarExpanded, setReviewSidebarExpanded, setSidebarWidth } from '../ui-prefs.ts';
import type { ChangeMapView } from './change-map-core.ts';
import { buildChangeMapView, repoNameForPath } from './change-map-core.ts';
import { renderFileHints, renderWorthALook } from './change-map-view.ts';
import type { DiffFile } from './diff-core.ts';
import { parseUnifiedDiff, shouldDropDiffCache, summarizeFiles } from './diff-core.ts';
import {
  baseLabel,
  branchSyncActionTitle,
  branchSyncClickAction,
  branchSyncLabel,
  committedMergeTargetText,
  decideMergeAction,
  decidePrimaryReviewAction,
  hasReviewChanges,
  mergeActionTitle,
  mergeDisabledReason,
  noChangesDescription,
  parkedStatusText,
  reviewHeadline,
  resyncOutcomeText,
  shouldShowBranchSyncLabel,
} from './review-copy-core.ts';
import type { MergeActionVerdict, ReviewBranchSync as BranchSync } from './review-copy-core.ts';
import { getSelectedId, onSelectionChange, setSelectedId } from './selection.ts';

type SessionDiffPayload = Pick<ServerMessageOf<'session-diff'>, 'committed' | 'uncommitted' | 'hasCommits'>;
type DiffSection = 'committed' | 'uncommitted';

interface ParsedDiff {
  committed: DiffFile[];
  uncommitted: DiffFile[];
}

const REVIEWABLE = new Set(['pending-review', 'parked']);
const MAX_FILE_LINES = 600;
const mergeShortcutHint = shortcutHint('merge', SHORTCUT_PLATFORM);
const resolveShortcutHint = shortcutHint('resolve-or-resync', SHORTCUT_PLATFORM);
const SIDEBAR_BOUNDS = { minPx: 260, maxPx: 700 };
const SIDEBAR_KEY_STEP_PX = 16;
const TRANSIENT_STATUS_MS = 5000;

const statusById = new Map<string, string>();
const reasonById = new Map<string, string | null>();
const diffById = new Map<string, SessionDiffPayload | null>();
const diffErrorById = new Map<string, string>();
const mapById = new Map<string, ChangeMap | null>();

const syncById = new Map<string, BranchSync | null>();

const resyncingIds = new Set<string>();

const parsedDiffByPayload = new WeakMap<SessionDiffPayload, ParsedDiff>();
const changeMapViewByMap = new WeakMap<ChangeMap, ChangeMapView>();

const openFiles = new Set<string>();
const expanded = new Set<string>();
let isWorthALookShowingAll = false;
let pendingOpenFilePath: string | null = null;

let panelEl: HTMLElement | null = null;
let controlsEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let railLabelEl: HTMLElement | null = null;
let railStatusEl: HTMLElement | null = null;
let railAddedEl: HTMLElement | null = null;
let railRemovedEl: HTMLElement | null = null;
let sessionNameEl: HTMLElement | null = null;
let isMoreMenuOpen = false;
let resolveOutcome: { forId: string; text: string; isError: boolean } | null = null;
let resolveOutcomeTimer: ReturnType<typeof setTimeout> | null = null;
let shortcutRefusal: { forId: string | null; text: string } | null = null;
let shortcutRefusalTimer: ReturnType<typeof setTimeout> | null = null;
const mergeRequestedFromStatusById = new Map<string, string>();

let resyncResult: { forId: string; text: string; isError: boolean } | null = null;
let resyncResultTimer: ReturnType<typeof setTimeout> | null = null;

function createReviewIconButton(label: string, strokePath: string) {
  const button = el('button', 'review-icon-button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(createLineIcon(strokePath));
  return button;
}

function closeMoreMenu() {
  isMoreMenuOpen = false;
  controlsEl?.querySelector('.review-more-menu')?.remove();
  controlsEl?.querySelector('.review-more-button')?.setAttribute('aria-expanded', 'false');
}

export function mountReviewSidebar({ panel }: { panel: HTMLElement | null }) {
  panelEl = panel;
  if (!panelEl) return;
  const mountedPanel = panelEl;

  const head = el('div', 'review-sidebar-head');
  const title = el('span', 'review-sidebar-title', 'Review');
  sessionNameEl = el('span', 'review-sidebar-session');
  title.append(sessionNameEl);
  const applyCollapsed = (isCollapsed: boolean) => {
    mountedPanel.toggleAttribute('data-collapsed', isCollapsed);
    setReviewSidebarExpanded(!isCollapsed);
  };

  const minimizeBtn = createReviewIconButton('Close review', 'M6 3L11 8L6 13');
  minimizeBtn.classList.add('review-sidebar-close');
  minimizeBtn.addEventListener('click', () => applyCollapsed(true));
  head.append(title, minimizeBtn);

  const rail = el('div', 'review-sidebar-rail');
  const expandBtn = createReviewIconButton('Open review', 'M10 3L5 8L10 13');
  expandBtn.classList.add('review-sidebar-open');
  expandBtn.addEventListener('click', () => applyCollapsed(false));
  railStatusEl = el('div', 'review-rail-status');
  railAddedEl = el('span', 'review-rail-added');
  railRemovedEl = el('span', 'review-rail-removed');
  railStatusEl.append(railAddedEl, railRemovedEl);
  railLabelEl = el('span', 'review-rail-label', 'Review');
  rail.append(expandBtn, railLabelEl, railStatusEl);

  controlsEl = el('div', 'review-controls');
  bodyEl = el('div', 'review-sidebar-body');

  const handle = el('div', 'review-resize-handle');
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize review sidebar');
  handle.tabIndex = 0;
  mountedPanel.append(rail, head, controlsEl, bodyEl, handle);
  mountedPanel.toggleAttribute('data-collapsed', !isReviewSidebarExpanded());

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isMoreMenuOpen) return;
    event.preventDefault();
    closeMoreMenu();
    controlsEl?.querySelector<HTMLButtonElement>('.review-more-button')?.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!isMoreMenuOpen || !(event.target instanceof Element)) return;
    if (controlsEl?.contains(event.target) && event.target.closest('.review-more-button, .review-more-menu')) return;
    closeMoreMenu();
  });

  wireColumnResizer({
    resizer: handle,
    column: mountedPanel,
    widthHost: mountedPanel,
    widthProperty: '--sidebar-width',
    bounds: SIDEBAR_BOUNDS,
    keyStepPx: SIDEBAR_KEY_STEP_PX,
    getStoredWidth: getSidebarWidth,
    setStoredWidth: setSidebarWidth,
    growsLeftward: true,
  });

  onSelectionChange((id) => {
    isMoreMenuOpen = false;
    shortcutRefusal = null;
    openFiles.clear();
    expanded.clear();
    isWorthALookShowingAll = false;
    pendingOpenFilePath = null;
    if (id) requestDiff(id);
    if (id && !isWorkspaceSession(id)) requestBranchSync(id);
    render();
  });

  render();
}

function applyStatus(id: string, next: string) {
  const prev = statusById.get(id);
  statusById.set(id, next);
  if (shouldDropDiffCache(prev, next)) {
    diffById.delete(id);
    diffErrorById.delete(id);
    mapById.delete(id);
    if (id === getSelectedId()) requestChangeMap(id);
  }
  if (id === getSelectedId()) render();
}

export function reparentReviewPanel(parentEl: HTMLElement | null) {
  if (!panelEl) return;
  if (parentEl) {
    adoptElement(panelEl, parentEl);
    render();
    return;
  }
  releaseElement(panelEl);
  render();
}

export function setReviewMergeStatus(id: string, mergeStatus: string, reason: string | null = null) {
  const next = mergeStatus || 'none';
  reasonById.set(id, reason);
  const requestedFrom = mergeRequestedFromStatusById.get(id);
  if (requestedFrom !== undefined && requestedFrom !== next) mergeRequestedFromStatusById.delete(id);
  applyStatus(id, next);
}

export function releaseReviewMergeRequest(id: unknown) {
  const key = sessionIdOf(id);
  if (!key || !mergeRequestedFromStatusById.delete(key)) return;
  if (key === getSelectedId()) render();
}

export function seedReviewMergeStatus(id: string, mergeStatus: string, reason: string | null = null) {
  reasonById.set(id, reason);
  mergeRequestedFromStatusById.delete(id);
  applyStatus(id, mergeStatus || 'none');
}

export function setReviewDiff(id: string, next: SessionDiffPayload | null) {
  diffById.set(id, next);
  diffErrorById.delete(id);
  if (id !== getSelectedId()) return;
  if (pendingOpenFilePath) expandFileInDiff(pendingOpenFilePath, next);
  render();
  scrollToPendingFile();
}

export function setReviewDiffError(id: unknown, message: string) {
  const key = sessionIdOf(id);
  if (!key) return;
  diffErrorById.set(key, message);
  if (key === getSelectedId()) render();
}

export function setSessionChangeMap(id: unknown, map: unknown) {
  const key = sessionIdOf(id);
  if (!key) return;
  const parsed = ChangeMap.safeParse(map);
  if (!parsed.success || parsed.data.sessionId !== key) return;
  mapById.set(key, parsed.data);
  if (key === getSelectedId()) render();
}

export function setReviewBranchSync(id: string, payload: BranchSync | null) {
  const key = sessionIdOf(id);
  const sync = payload;
  syncById.set(key, sync);
  if (sync && sync.action !== undefined) applyResyncResult(key, sync);
  if (key === getSelectedId()) render();
}

function applyResyncResult(id: string, payload: BranchSync) {
  resyncingIds.delete(id);
  clearTimeout(resyncResultTimer ?? undefined);
  resyncResultTimer = null;
  const text = resyncOutcomeText(payload);
  resyncResult = text ? { forId: id, text, isError: !!payload.error } : null;
  if (resyncResult && !resyncResult.isError) {
    resyncResultTimer = setTimeout(() => {
      if (resyncResult && resyncResult.forId === id) resyncResult = null;
      render();
    }, 5000);
  }
}

export function notifyWorktreeChanged(id: unknown) {
  const key = sessionIdOf(id);
  if (key && key === getSelectedId()) requestDiff(key);
}

export function refreshReviewSidebar(id: unknown) {
  const key = sessionIdOf(id);
  if (key !== getSelectedId()) return;
  const isDiffStale = !diffById.has(key) || diffErrorById.has(key);
  const isChangeMapStale = !mapById.has(key) || hasChangeMapError(mapById.get(key));
  if (isDiffStale) requestDiff(key);
  if (isChangeMapStale && !isDiffStale) requestChangeMap(key);
  render();
}

function hasChangeMapError(map: ChangeMap | null | undefined): boolean {
  if (!map) return false;
  return Boolean(map.error) || map.repos.some((repo) => repo.error !== null);
}

export function forgetReviewSession(id: unknown) {
  const key = sessionIdOf(id);
  statusById.delete(key);
  reasonById.delete(key);
  diffById.delete(key);
  diffErrorById.delete(key);
  mapById.delete(key);
  syncById.delete(key);
  resyncingIds.delete(key);
  if (resyncResult && resyncResult.forId === key) { clearTimeout(resyncResultTimer ?? undefined); resyncResult = null; }
  if (key === getSelectedId()) { setSelectedId(null); return; }
  render();
}

export function mergeSelectedSession() {
  const id = getSelectedId();
  const ui = id ? sessionUIs.get(id) : null;
  if (!id || !ui) return refuseShortcut(null, 'No session is open to merge.');
  if (isWorkspaceSession(id)) return refuseShortcut(id, 'A workspace session has no worktree to merge.');
  if (mergeRequestedFromStatusById.has(id)) return refuseShortcut(id, `Merge is already on its way for "${sessionName(ui, id)}".`);
  const curStatus = statusById.get(id) || 'none';
  const payload = diffById.get(id);
  const hasCommits = !!(payload?.hasCommits);
  const mergeAction = decideMergeAction(
    curStatus,
    reasonById.get(id) || null,
    isMergeableLive(ui.currentState, hasCommits),
  );
  const primaryAction = decidePrimaryReviewAction({
    status: curStatus,
    mergeReason: reasonById.get(id) || null,
    live: isLive(ui.currentState),
    isMergeRendered: mergeAction.isRendered,
    hasChanges: sessionHasChanges(id),
  });
  if (primaryAction !== 'merge' || !mergeAction.isEnabled) {
    const disabledReason = mergeDisabledReason({ status: curStatus, hasCommits, live: isLive(ui.currentState), state: ui.currentState });
    return refuseShortcut(id, disabledReason ?? `Nothing to merge in "${sessionName(ui, id)}" right now.`);
  }
  sendMergeContinue(id, ui.currentState);
  return true;
}

function refuseShortcut(id: string | null, text: string) {
  shortcutRefusal = { forId: id, text };
  clearTimeout(shortcutRefusalTimer ?? undefined);
  shortcutRefusalTimer = setTimeout(() => {
    shortcutRefusal = null;
    render();
  }, TRANSIENT_STATUS_MS);
  render();
  return false;
}

export function resolveSelectedSession() {
  const id = getSelectedId();
  if (!id || isWorkspaceSession(id)) return false;
  const ui = sessionUIs.get(id);
  if (!ui) return false;
  const status = statusById.get(id) || 'none';
  const mergeReason = reasonById.get(id) || null;
  const primaryAction = decidePrimaryReviewAction({
    status,
    mergeReason,
    live: isLive(ui.currentState),
    isMergeRendered: decideMergeAction(status, mergeReason, false).isRendered,
    hasChanges: sessionHasChanges(id),
  });
  if (primaryAction !== 'resolve' || isResolveAwaiting(id)) return false;
  sendResolvePrompt(id);
  return true;
}

function isResolveAwaiting(id: string) {
  return resolveOutcome?.forId === id && !resolveOutcome.isError;
}

function sendResolvePrompt(id: string) {
  const wasSent = sendControlMsg({ type: 'resolve-session-merge', id });
  resolveOutcome = wasSent
    ? { forId: id, text: 'Resolve prompt sent', isError: false }
    : { forId: id, text: 'Not connected. The resolve prompt was not sent.', isError: true };
  clearTimeout(resolveOutcomeTimer ?? undefined);
  resolveOutcomeTimer = setTimeout(() => {
    resolveOutcome = null;
    render();
  }, wasSent ? 3000 : TRANSIENT_STATUS_MS);
  render();
}

export function resyncSelectedSession() {
  const id = getSelectedId();
  if (!id || !sessionUIs.has(id) || isWorkspaceSession(id)) return false;
  if (isBranchSyncBusy(id)) return false;
  requestBranchSyncAction(id);
  return true;
}

function parsedDiffOf(payload: SessionDiffPayload | null | undefined): ParsedDiff {
  if (!payload) return { committed: [], uncommitted: [] };
  const cached = parsedDiffByPayload.get(payload);
  if (cached) return cached;
  const parsed = { committed: parseUnifiedDiff(payload.committed?.diff || ''), uncommitted: parseUnifiedDiff(payload.uncommitted?.diff || '') };
  parsedDiffByPayload.set(payload, parsed);
  return parsed;
}

function changeMapViewOf(map: ChangeMap): ChangeMapView {
  const cached = changeMapViewByMap.get(map);
  if (cached) return cached;
  const view = buildChangeMapView(map);
  changeMapViewByMap.set(map, view);
  return view;
}

function sessionHasChanges(id: string) {
  const parsed = parsedDiffOf(diffById.get(id));
  const changedFiles = [...parsed.committed, ...parsed.uncommitted];
  const payload = diffById.get(id) ?? null;
  return hasReviewChanges({
    fetched: diffById.has(id),
    changedFileCount: summarizeFiles(changedFiles).files,
    hasCommits: !!payload?.hasCommits,
  });
}

function isMergeableLive(state: string, hasCommits: boolean) {
  return (MERGEABLE_LIVE_STATES.includes(state as SessionState) || state === STATES.RUNNING) && hasCommits;
}

function sendMergeContinue(id: string, state: string) {
  if (state !== STATES.RUNNING) {
    requestMerge(id, false);
    return;
  }
  openConfirmDialog({
    title: 'Merge while working',
    message: 'This session still looks like it is working. Merging rebases its worktree under it. Merge anyway?',
    confirmLabel: 'Merge anyway',
    onConfirm: () => requestMerge(id, true),
  });
}

function requestMerge(id: string, force: boolean) {
  if (mergeRequestedFromStatusById.has(id)) return;
  const wasSent = sendControlMsg(force ? { type: 'merge-continue-session', id, force: true } : { type: 'merge-continue-session', id });
  if (!wasSent) {
    refuseShortcut(id, 'Not connected. The merge was not sent.');
    return;
  }
  mergeRequestedFromStatusById.set(id, statusById.get(id) || 'none');
  if (id === getSelectedId()) render();
}

function isLive(state: string) {
  return state !== STATES.DORMANT && state !== STATES.DONE && state !== STATES.FAILED;
}

function requestDiff(id: string) {
  sendControlMsg({ type: 'request-session-diff', id });
  requestChangeMap(id);
}

function requestChangeMap(id: string) {
  if (!mapById.has(id)) mapById.set(id, null);
  sendControlMsg({ type: 'request-change-map', id });
}

function isWorkspaceSession(id: string): boolean {
  return sessionUIs.get(id)?.card.dataset.workspace !== undefined;
}

function requestBranchSync(id: string) {
  syncById.set(id, null);
  sendControlMsg({ type: 'request-branch-sync', id });
  if (id === getSelectedId()) render();
}

function requestResyncBranch(id: string) {
  resyncingIds.add(id);
  clearTimeout(resyncResultTimer ?? undefined);
  if (resyncResult && resyncResult.forId === id) resyncResult = null;
  sendControlMsg({ type: 'resync-branch', id });
  if (id === getSelectedId()) render();
}

function isBranchSyncBusy(id: string) {
  return resyncingIds.has(id) || syncById.get(id) === null;
}

function requestBranchSyncAction(id: string) {
  if (isBranchSyncBusy(id)) return;
  if (branchSyncClickAction(syncById.get(id)) === 'resync') {
    requestResyncBranch(id);
    return;
  }
  requestBranchSync(id);
}

function resyncStatusLine(id: string, resyncing: boolean) {
  if (resyncing) return { text: 'Resyncing', loading: true, error: false };
  if (resyncResult && resyncResult.forId === id) return { text: resyncResult.text, loading: false, error: resyncResult.isError };
  return null;
}

function sessionName(ui: SessionUi | null | undefined, id: string) {
  return ui?.card?.dataset.session || id;
}

function expandFileInDiff(path: string, payload: SessionDiffPayload | null | undefined) {
  if (!payload) return;
  const { committed, uncommitted } = parsedDiffOf(payload);
  for (const file of committed) {
    if (file.path === path || file.oldPath === path) openFiles.add(`committed:${file.path}`);
  }
  for (const file of uncommitted) {
    if (file.path === path || file.oldPath === path) openFiles.add(`uncommitted:${file.path}`);
  }
}

function scrollToPendingFile() {
  if (!bodyEl || !pendingOpenFilePath) return;
  const sections = bodyEl.querySelectorAll<HTMLElement>('.review-file');
  for (const section of sections) {
    if (section.dataset.path !== pendingOpenFilePath && section.dataset.oldPath !== pendingOpenFilePath) continue;
    section.scrollIntoView({ block: 'nearest' });
    pendingOpenFilePath = null;
    return;
  }
}

function openFileFromWorthALook(path: string) {
  pendingOpenFilePath = path;
  expandFileInDiff(path, diffById.get(getSelectedId() ?? ''));
  render();
  scrollToPendingFile();
}

function showAllWorthALook() {
  isWorthALookShowingAll = true;
  render();
}

function render() {
  const bodyScrollTop = bodyEl?.scrollTop ?? 0;
  renderSidebar();
  if (bodyEl) bodyEl.scrollTop = bodyScrollTop;
}

function renderSidebar() {
  if (!controlsEl || !bodyEl) return;
  controlsEl.replaceChildren();
  bodyEl.replaceChildren();
  if (railLabelEl) railLabelEl.hidden = true;
  if (railStatusEl) railStatusEl.hidden = true;

  const id = getSelectedId();
  const ui = id ? sessionUIs.get(id) : null;
  renderSessionName(id, ui);
  if (!id || !ui) {
    if (shortcutRefusal) controlsEl.append(statusNote(shortcutRefusal.text, true));
    renderEmpty('No session selected', 'Click a session name to review its changes here.');
    return;
  }

  const isWorkspace = isWorkspaceSession(id);
  const status = statusById.get(id) || 'none';
  const mergeReason = reasonById.get(id) || null;
  const state = ui.currentState;
  const reviewable = REVIEWABLE.has(status);

  const fetched = diffById.has(id);
  const payload = fetched ? diffById.get(id) : null;
  const diffError = diffErrorById.get(id) ?? null;

  const { committed: committedFiles, uncommitted: uncommittedFiles } = parsedDiffOf(payload);
  const hasCommits = !!(payload?.hasCommits);

  const live = isLive(state);
  const mergeableLive = isMergeableLive(state, hasCommits);
  const mergeAction = decideMergeAction(status, mergeReason, mergeableLive);

  const sync = syncById.get(id);
  const resyncing = resyncingIds.has(id);

  const effectiveBase = baseLabel(ui.effectiveBase);
  const totals = summarizeFiles([...committedFiles, ...uncommittedFiles]);
  const hasChanges = hasReviewChanges({ fetched, changedFileCount: totals.files, hasCommits });
  const primaryAction = decidePrimaryReviewAction({ status, mergeReason, live, hasChanges, isMergeRendered: mergeAction.isRendered });
  const headline = reviewHeadline({
    status, mergeReason, fetched, hasDiffError: diffError !== null, hasChanges: totals.files > 0 || hasCommits, hasCommits,
    canMerge: !isWorkspace && mergeAction.isEnabled, isWorkspace, live, effectiveBase, changedFileCount: totals.files,
  });
  const isEmpty = headline.isEmpty === true;
  const isSyncLabelShown = isEmpty || isPhoneLayout() || shouldShowBranchSyncLabel(sync);
  const statusLine = el('div', 'review-status-headline');
  statusLine.append(el('span', 'review-status-text', headline.text));
  if (!isWorkspace && !isSyncLabelShown) {
    const syncText = branchSyncLabel(sync);
    if (syncText) {
      statusLine.title = syncText;
      const refreshButton = createReviewIconButton('Refresh branch sync', 'M13 6A5 5 0 1 0 13 10M13 2v4H9');
      refreshButton.classList.add('review-branch-sync-refresh');
      refreshButton.title = branchSyncActionTitle(sync, resolveShortcutHint, primaryAction !== 'resolve');
      refreshButton.disabled = isBranchSyncBusy(id);
      refreshButton.setAttribute('aria-description', syncText);
      refreshButton.addEventListener('click', () => requestBranchSyncAction(id));
      statusLine.append(el('span', 'sr-only', syncText), refreshButton);
    }
  }
  if (!isEmpty) controlsEl.append(statusLine);

  const metadata = el('div', 'review-status-meta');
  if (fetched && totals.files > 0) metadata.append(
    el('span', 'review-status-added', `+${totals.added}`),
    el('span', 'review-status-removed', `-${totals.removed}`),
    el('span', 'review-status-spacer'),
  );
  if (!isWorkspace && isSyncLabelShown) {
    const branchSync = renderBranchSync(id, primaryAction !== 'resolve');
    if (branchSync) metadata.append(branchSync);
  }
  if (metadata.childElementCount > 0) controlsEl.append(metadata);
  if (status === 'parked') controlsEl.append(el('div', 'review-status-explanation', parkedStatusText(mergeReason)));

  if (railLabelEl) railLabelEl.hidden = false;
  if (railStatusEl) {
    railStatusEl.hidden = false;
    railStatusEl.setAttribute('aria-label', `${headline.text}, +${totals.added}, -${totals.removed}`);
    railStatusEl.title = headline.text;
  }
  if (railAddedEl) railAddedEl.textContent = `+${totals.added}`;
  if (railRemovedEl) railRemovedEl.textContent = `-${totals.removed}`;

  const actions = isWorkspace ? null : renderActions(id, {
    status, reviewable, mergeAction, live, state, effectiveBase, primaryAction,
  });
  if (actions) controlsEl.append(actions);

  const resyncStatus = isWorkspace ? null : resyncStatusLine(id, resyncing);
  const mergeReasonText = !isWorkspace && primaryAction === 'merge' && !mergeAction.isEnabled
    ? mergeDisabledReason({ status, hasCommits, live, state })
    : null;
  if (mergeReasonText) {
    const mergeReasonLine = el('div', 'review-control-reason', mergeReasonText);
    mergeReasonLine.id = 'review-merge-reason';
    controlsEl.append(mergeReasonLine);
    controlsEl.querySelector('#review-merge-btn')?.setAttribute('aria-describedby', mergeReasonLine.id);
  }
  if (resyncStatus?.text) {
    const resyncReasonLine = el('div', resyncStatus.loading ? 'review-control-reason review-loading' : 'review-control-reason', resyncStatus.text);
    resyncReasonLine.id = 'review-resync-reason';
    if (resyncStatus.error) resyncReasonLine.classList.add('review-control-reason-error');
    resyncReasonLine.setAttribute('role', 'status');
    metadata.append(resyncReasonLine);
    if (!metadata.isConnected) controlsEl.insertBefore(metadata, statusLine.isConnected ? statusLine.nextSibling : controlsEl.firstChild);
    controlsEl.querySelector('.review-branch-sync-button, .review-branch-sync-refresh')?.setAttribute('aria-describedby', resyncReasonLine.id);
  }

  if (resolveOutcome?.forId === id) controlsEl.append(statusNote(resolveOutcome.text, resolveOutcome.isError));
  if (shortcutRefusal && (shortcutRefusal.forId === id || shortcutRefusal.forId === null)) controlsEl.append(statusNote(shortcutRefusal.text, true));

  if (diffError) {
    bodyEl.append(el('p', 'review-diff-error', diffError));
    return;
  }
  if (isEmpty) {
    renderEmpty(headline.text, noChangesDescription(isWorkspace, effectiveBase));
    return;
  }
  const changeMap = mapById.get(id);
  const changeMapView = changeMap ? changeMapViewOf(changeMap) : null;
  const worthALook = changeMapView
    ? renderWorthALook(changeMapView, { isShowingAll: isWorthALookShowingAll, onShowAll: showAllWorthALook, onOpenFile: openFileFromWorthALook })
    : null;
  if (worthALook) bodyEl.append(worthALook);
  const hasBothSections = committedFiles.length > 0 && uncommittedFiles.length > 0;
  if (committedFiles.length > 0) bodyEl.append(renderSection({
    kind: 'committed', label: hasBothSections ? 'Committed' : null, meaning: committedMergeTargetText(headline, effectiveBase), files: committedFiles, changeMapView,
  }));
  if (uncommittedFiles.length > 0) bodyEl.append(renderSection({
    kind: 'uncommitted', label: hasBothSections ? 'Not committed yet' : null, meaning: null, files: uncommittedFiles, changeMapView,
  }));
}

function statusNote(text: string, isError: boolean) {
  const note = el('div', isError ? 'review-control-reason review-control-reason-error' : 'review-resolve-sent', text);
  note.setAttribute('role', 'status');
  return note;
}

function renderSessionName(id: string | null, ui: SessionUi | null | undefined) {
  if (!sessionNameEl) return;
  const name = id && ui ? sessionName(ui, id) : '';
  sessionNameEl.textContent = name;
  sessionNameEl.hidden = !name;
  sessionNameEl.title = name;
}

function renderEmpty(title: string, desc: string) {
  if (!bodyEl) return;
  const wrap = el('div', 'review-empty');
  wrap.append(el('div', 'review-empty-title', title), el('div', 'review-empty-desc', desc));
  bodyEl.append(wrap);
}

function renderBranchSync(id: string, shortcutResyncs: boolean) {
  const sync = syncById.get(id);
  if (sync === undefined) return null;
  if (sync === null) return el('span', 'review-branch-sync-text review-loading', 'Checking branch sync...');
  const label = branchSyncLabel(sync) || 'Base branch: sync state unknown';
  const row = el('span', 'review-branch-sync-text');
  if (sync.state) row.dataset.syncState = sync.state;
  if (sync.fetched === false) row.dataset.stale = 'true';
  const refreshButton = createReviewIconButton('Refresh branch sync', 'M13 6A5 5 0 1 0 13 10M13 2v4H9');
  refreshButton.classList.add('review-branch-sync-button');
  refreshButton.title = branchSyncActionTitle(sync, resolveShortcutHint, shortcutResyncs);
  refreshButton.disabled = resyncingIds.has(id);
  refreshButton.addEventListener('click', () => requestBranchSyncAction(id));
  row.append(refreshButton, el('span', 'review-branch-sync-label', label));
  return row;
}

function renderSection({ kind, label, meaning, files, changeMapView }: {
  kind: DiffSection;
  label: string | null;
  meaning: string | null;
  files: DiffFile[];
  changeMapView: ChangeMapView | null;
}) {
  const wrap = el('div', 'review-section');
  wrap.dataset.kind = kind;
  if (label) wrap.append(renderSectionHead(label, meaning, files));

  const list = el('div', 'review-diff');
  const repos = changeMapView && changeMapView.repos.length > 1 ? changeMapView.repos : [];
  let previousRepoName: string | null = null;
  for (const f of files) {
    const repoName = repos.length > 0 ? repoNameForPath(repos, f.path) : null;
    if (repoName && repoName !== previousRepoName) list.append(el('div', 'review-repo-label', repoName));
    previousRepoName = repoName;
    list.append(renderFile(f, kind, changeMapView));
  }
  wrap.append(list);
  return wrap;
}

function renderSectionHead(label: string, meaning: string | null, files: DiffFile[]) {
  const sum = summarizeFiles(files);
  const head = el('div', 'review-section-head');
  const titleGroup = el('div', 'review-section-id');
  titleGroup.append(el('span', 'review-section-label', label));
  if (meaning) titleGroup.append(el('span', 'review-section-meaning', meaning));
  const stat = el('div', 'review-section-stat');
  stat.append(
    el('span', 'review-stat-files', `${sum.files} file${sum.files === 1 ? '' : 's'}`),
    el('span', 'review-add', `+${sum.added}`),
    el('span', 'review-del', `-${sum.removed}`),
  );
  head.append(titleGroup, stat);
  return head;
}

function renderFile(f: DiffFile, kind: DiffSection, changeMapView: ChangeMapView | null) {
  const key = `${kind}:${f.path}`;
  const open = openFiles.has(key);
  const sec = el('div', 'review-file');
  sec.dataset.path = f.path;
  if (f.oldPath) sec.dataset.oldPath = f.oldPath;
  sec.dataset.status = f.status;
  sec.dataset.open = open ? 'true' : 'false';

  const head = el('button', 'review-file-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
  const twisty = el('span', 'review-file-twisty', open ? '▾' : '▸');
  twisty.setAttribute('aria-hidden', 'true');
  const name = el('span', 'review-file-name');
  name.append(el('span', 'review-file-path', f.path));
  const hints = renderFileHints(changeMapView?.hintsByOpenPath.get(f.path));
  if (hints.length > 0) {
    const hintRow = el('span', 'review-file-hints');
    hintRow.append(...hints);
    name.append(hintRow);
  }
  head.append(twisty, name);
  const c = el('span', 'review-file-counts');
  if (f.binary) c.append(el('span', 'review-bin', 'bin'));
  if (!f.binary) c.append(
    el('span', 'review-add', `+${f.added}`),
    el('span', 'review-del', `-${f.removed}`)
  );
  head.append(c);
  head.addEventListener('click', () => {
    const wasOpen = openFiles.has(key);
    if (wasOpen) openFiles.delete(key);
    if (!wasOpen) openFiles.add(key);
    render();
  });
  sec.append(head);

  if (!open) return sec;

  const body = el('div', 'review-file-body');
  if (f.binary) {
    body.append(el('div', 'review-file-binary', 'Binary file not shown'));
    sec.append(body);
    return sec;
  }

  let rendered = 0;
  let truncated = false;
  for (const h of f.hunks) {
    if (rendered >= MAX_FILE_LINES && !expanded.has(key)) { truncated = true; break; }
    body.append(el('div', 'review-hunk-head', h.header));
    for (const line of h.lines) {
      if (rendered >= MAX_FILE_LINES && !expanded.has(key)) { truncated = true; break; }
      const row = el('div', `review-line review-line-${line.type}`);
      const gutter = line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'meta' ? '\\' : ' ';
      row.append(el('span', 'review-line-gutter', gutter));
      row.append(el('span', 'review-line-text', line.text));
      body.append(row);
      rendered++;
    }
    if (truncated) break;
  }
  if (truncated) {
    const more = el('button', 'review-expand', 'Show the rest of this file');
    more.type = 'button';
    more.addEventListener('click', () => { expanded.add(key); render(); });
    body.append(more);
  }
  sec.append(body);
  return sec;
}

function actionButton({ id, label, shortcut, title, disabled = false, danger = false, onClick }: {
  label: string;
  onClick: (event: MouseEvent) => void;
  id?: string;
  shortcut?: string;
  title?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  const btn = el('button', danger ? 'review-btn review-btn-danger' : 'review-btn review-btn-primary');
  btn.type = 'button';
  if (id) btn.id = id;
  if (title) btn.title = title;
  btn.disabled = disabled;
  btn.innerHTML = shortcut
    ? `${label} <kbd class="review-shortcut" aria-hidden="true">${shortcut}</kbd>`
    : label;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderActions(id: string, {
  status, reviewable, mergeAction, live, state, effectiveBase, primaryAction,
}: {
  status: string;
  reviewable: boolean;
  mergeAction: MergeActionVerdict;
  live: boolean;
  state: string;
  effectiveBase: string;
  primaryAction: 'merge' | 'resolve' | 'none';
}) {
  const actions = el('div', 'review-actions');

  const resolveShown = primaryAction === 'resolve';
  if (primaryAction === 'merge') {
    actions.append(actionButton({
      id: 'review-merge-btn',
      label: 'Merge',
      shortcut: mergeShortcutHint,
      title: mergeActionTitle(effectiveBase, mergeShortcutHint),
      disabled: !mergeAction.isEnabled || mergeRequestedFromStatusById.has(id),
      onClick: () => sendMergeContinue(id, state),
    }));
  }

  if (resolveShown) {
    actions.append(actionButton({
      label: 'Resolve',
      shortcut: resolveShortcutHint,
      title: `Paste a resolve prompt into this session so the agent can finish the merge (${resolveShortcutHint})`,
      disabled: isResolveAwaiting(id),
      onClick: () => sendResolvePrompt(id),
    }));
  }

  const actionControls = el('div', 'review-action-controls');
  actionControls.append(actions);
  if (!reviewable || live) return actions.childElementCount > 0 ? actionControls : null;

  const moreButton = createReviewIconButton('More review actions', MORE_ICON_PATH);
  moreButton.classList.add('review-more-button');
  moreButton.setAttribute('aria-haspopup', 'menu');
  moreButton.setAttribute('aria-expanded', String(isMoreMenuOpen));
  moreButton.setAttribute('aria-controls', 'review-more-menu');
  moreButton.addEventListener('click', () => {
    isMoreMenuOpen = !isMoreMenuOpen;
    render();
    const focusTarget = controlsEl?.querySelector<HTMLButtonElement>(isMoreMenuOpen ? '.review-more-menu button:not(:disabled)' : '.review-more-button');
    (focusTarget ?? controlsEl?.querySelector<HTMLButtonElement>('.review-more-button'))?.focus();
  });
  actions.append(moreButton);
  if (!isMoreMenuOpen) return actionControls;

  const menu = el('div', 'review-more-menu');
  menu.id = 'review-more-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'More review actions');
  if (reviewable && !live) {
    const discardButton = actionButton({
      label: 'Discard worktree',
      danger: true,
      disabled: status === 'merging',
      onClick: () => {
        isMoreMenuOpen = false;
        render();
        const ui = sessionUIs.get(id);
        const nm = sessionName(ui, id);
        openConfirmDialog({
          title: 'Discard worktree',
          message: `Throw away the worktree changes for "${nm}"? This cannot be undone.`,
          confirmLabel: 'Discard',
          danger: true,
          onConfirm: () => sendControlMsg({ type: 'discard-session-worktree', id }),
        });
      },
    });
    discardButton.setAttribute('role', 'menuitem');
    menu.append(discardButton);
  }
  actionControls.append(menu);
  return actionControls;
}
