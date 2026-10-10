import type { DiffAnnotation, ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { ChangeMap } from '#shared/contracts/change-map.ts';
import { DIFF_ANNOTATION_NOTE_MAX_CHARS, DIFF_ANNOTATIONS_MAX } from '#shared/contracts/control-messages.ts';
import type { SessionState } from '#shared/states.ts';
import { MERGEABLE_LIVE_STATES, STATES } from '#shared/states.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { adoptElement, el, releaseElement } from '../dom-helpers.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionIdOf, sessionUIs } from '../session-card/card-registry.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { shortcutHint } from '../shortcuts-core.ts';
import { createSvgIcon, createSvgShape } from '../state-glyph.ts';
import type { UiPrefs } from '../ui-prefs.ts';
import { getReviewSidebarView, getSidebarWidth, isReviewSidebarExpanded, setReviewSidebarExpanded, setReviewSidebarView, setSidebarWidth } from '../ui-prefs.ts';
import { buildChangeMapView } from './change-map-core.ts';
import { renderChangeMapView } from './change-map-view.ts';
import type { AnnotationTarget, DiffFile, SectionDiffText } from './diff-core.ts';
import {
  annotationKey,
  annotationTargetOf,
  parseUnifiedDiff,
  shouldDropDiffCache,
  staleDraftKeys,
  summarizeFiles,
} from './diff-core.ts';
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
  netEmptyChangesText,
  parkedStatusText,
  reviewHeadline,
  resyncOutcomeText,
  shouldShowBranchSyncLabel,
  shouldShowReviewHeaderCounts,
} from './review-copy-core.ts';
import type { MergeActionVerdict, ReviewBranchSync as BranchSync } from './review-copy-core.ts';
import { getSelectedId, onSelectionChange, setSelectedId } from './selection.ts';

type SessionDiffPayload = Pick<ServerMessageOf<'session-diff'>, 'committed' | 'uncommitted' | 'hasCommits'>;

const REVIEWABLE = new Set(['pending-review', 'parked']);
const MAX_FILE_LINES = 600;
const mergeShortcutHint = shortcutHint('merge', SHORTCUT_PLATFORM);
const resolveShortcutHint = shortcutHint('resolve-or-resync', SHORTCUT_PLATFORM);
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 700;

const statusById = new Map<string, string>();
const reasonById = new Map<string, string | null>();
const diffById = new Map<string, SessionDiffPayload | null>();
const mapById = new Map<string, ChangeMap | null>();

const syncById = new Map<string, BranchSync | null>();

const resyncingIds = new Set<string>();

const openFiles = new Set<string>();
const expanded = new Set<string>();
let selectedView = getReviewSidebarView();
let pendingOpenFilePath: string | null = null;

let panelEl: HTMLElement | null = null;
let controlsEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
const viewButtonByView = new Map<UiPrefs['reviewSidebarView'], HTMLButtonElement>();
let notesCountEl: HTMLElement | null = null;
let railLabelEl: HTMLElement | null = null;
let railStatusEl: HTMLElement | null = null;
let railAddedEl: HTMLElement | null = null;
let railRemovedEl: HTMLElement | null = null;
let isMoreMenuOpen = false;
let resolveJustSent = false;
let resolveJustSentFor: string | null = null;
let resolveSentTimer: ReturnType<typeof setTimeout> | null = null;

let resyncResult: { forId: string; text: string; isError: boolean } | null = null;
let resyncResultTimer: ReturnType<typeof setTimeout> | null = null;

interface AnnotatedLine {
  target: AnnotationTarget;
  section: DiffAnnotation['section'];
  rows: HTMLElement[];
}

const annotatedLineByNoteKey = new Map<string, AnnotatedLine>();

let notesEl: HTMLElement | null = null;
let sendNotesBtn: HTMLButtonElement | null = null;
let notesStatusEl: HTMLElement | null = null;
let notesOutcomeEl: HTMLElement | null = null;
let notesListEl: HTMLElement | null = null;
const draftNoteByKey = new Map<string, DiffAnnotation>();
let openEditorKey: string | null = null;
let notesSendInFlight = false;
let notesOutcome: string | null = null;

function createReviewIconButton(label: string, strokePath: string) {
  const button = el('button', 'review-icon-button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  const icon = createSvgIcon(16, 16);
  icon.append(createSvgShape('path', {
    d: strokePath,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }));
  button.append(icon);
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
  const applyCollapsed = (isCollapsed: boolean) => {
    mountedPanel.toggleAttribute('data-collapsed', isCollapsed);
    setReviewSidebarExpanded(!isCollapsed);
  };

  const viewTabs = el('div', 'review-header-tabs');
  viewTabs.setAttribute('role', 'group');
  viewTabs.setAttribute('aria-label', 'Review view');
  for (const [view, label] of [['map', 'Map'], ['diff', 'Diff'], ['notes', 'Notes']] as const) {
    const button = el('button', 'review-header-tab', label);
    button.type = 'button';
    button.addEventListener('click', () => setSelectedView(view));
    viewButtonByView.set(view, button);
    viewTabs.append(button);
  }
  notesCountEl = el('span', 'review-notes-count');
  viewTabs.append(notesCountEl);

  const minimizeBtn = createReviewIconButton('Close review', 'M6 3L11 8L6 13');
  minimizeBtn.classList.add('review-sidebar-close');
  minimizeBtn.addEventListener('click', () => applyCollapsed(true));
  head.append(title, viewTabs, minimizeBtn);

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

  notesEl = el('div', 'review-notes-footer');
  sendNotesBtn = el('button', 'review-btn review-btn-primary', 'Send notes');
  sendNotesBtn.type = 'button';
  sendNotesBtn.title = 'Paste the drafted review notes into this session as one message';
  sendNotesBtn.addEventListener('click', sendDraftAnnotations);
  notesStatusEl = el('div', 'review-notes-status');
  notesEl.append(notesStatusEl, sendNotesBtn);
  notesListEl = el('div', 'review-notes-list');
  notesOutcomeEl = el('div', 'review-notes-outcome');
  notesOutcomeEl.setAttribute('role', 'status');

  const handle = el('div', 'review-resize-handle');
  handle.setAttribute('aria-hidden', 'true');
  mountedPanel.append(rail, head, controlsEl, bodyEl, notesOutcomeEl, notesEl, handle);
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

  let dragStartX = 0, dragStartWidth = 0;

  const applyWidth = (px: number) => {
    const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, px));
    if (!Number.isFinite(w)) return null;
    mountedPanel.style.setProperty('--sidebar-width', `${w}px`);
    return w;
  };

  const onDrag = (e: PointerEvent) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    applyWidth(dragStartWidth + (dragStartX - e.clientX));
  };

  let dragging = false;
  const stopDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    document.documentElement.style.cursor = '';
    document.documentElement.style.userSelect = '';
    const w = mountedPanel.style.getPropertyValue('--sidebar-width');
    if (w) setSidebarWidth(parseInt(w, 10));
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragStartX = e.clientX;
    dragStartWidth = mountedPanel.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    dragging = true;
    document.documentElement.style.cursor = 'col-resize';
    document.documentElement.style.userSelect = 'none';
  });
  handle.addEventListener('pointermove', onDrag);
  handle.addEventListener('pointerup', stopDrag);
  handle.addEventListener('pointercancel', stopDrag);
  handle.addEventListener('lostpointercapture', stopDrag);

  const storedWidth = getSidebarWidth();
  if (storedWidth !== null) applyWidth(storedWidth);

  onSelectionChange((id) => {

    isMoreMenuOpen = false;
    openFiles.clear();
    expanded.clear();
    pendingOpenFilePath = null;
    clearDraftAnnotations();
    if (id) requestDiff(id);
    if (id && !isWorkspaceSession(id)) requestBranchSync(id);
    render();
  });

  render();
}

export function reparentReviewPanel(parentEl: HTMLElement | null) {
  if (!panelEl) return;
  if (parentEl) {
    adoptElement(panelEl, parentEl);
    return;
  }
  releaseElement(panelEl);
}

function applyStatus(id: string, next: string) {
  const prev = statusById.get(id);
  statusById.set(id, next);
  if (shouldDropDiffCache(prev, next)) {
    diffById.delete(id);
    mapById.delete(id);
    if (id === getSelectedId()) requestChangeMap(id);
  }
  if (id === getSelectedId()) render();
}

export function setReviewMergeStatus(id: string, mergeStatus: string, reason: string | null = null) {
  const prev = statusById.get(id) || 'none';
  const next = mergeStatus || 'none';
  reasonById.set(id, reason);
  applyStatus(id, next);

  if (REVIEWABLE.has(next) && !REVIEWABLE.has(prev)) {
    const sel = getSelectedId();
    const selReviewable = sel ? REVIEWABLE.has(statusById.get(sel) || 'none') : false;
    if (!sel || !sessionUIs.has(sel) || !selReviewable) setSelectedId(id);
  }
}

export function seedReviewMergeStatus(id: string, mergeStatus: string, reason: string | null = null) {
  reasonById.set(id, reason);
  applyStatus(id, mergeStatus || 'none');
}

export function setReviewDiff(id: string, next: SessionDiffPayload | null) {
  const previous = diffById.get(id) ?? null;
  diffById.set(id, next);
  if (id !== getSelectedId()) return;
  dropDraftsForChangedSections(previous, next);
  if (pendingOpenFilePath) expandFileInDiff(pendingOpenFilePath, next);
  render();
  scrollToPendingFile();
}

export function setSessionChangeMap(id: unknown, map: unknown) {
  const key = sessionIdOf(id);
  if (!key) return;
  const parsed = ChangeMap.safeParse(map);
  if (!parsed.success || parsed.data.sessionId !== key) return;
  mapById.set(key, parsed.data);
  if (key === getSelectedId()) render();
}

function sectionDiffText(payload: SessionDiffPayload | null): SectionDiffText {
  return { committed: payload?.committed?.diff || '', uncommitted: payload?.uncommitted?.diff || '' };
}

function dropDraftsForChangedSections(previous: SessionDiffPayload | null, next: SessionDiffPayload | null) {
  if (draftNoteByKey.size === 0) return;
  if (!previous) return;
  const stale = staleDraftKeys(sectionDiffText(previous), sectionDiffText(next), draftNoteByKey.keys());
  if (stale.length === 0) return;
  for (const key of stale) draftNoteByKey.delete(key);
  if (openEditorKey !== null && stale.includes(openEditorKey)) openEditorKey = null;
  notesOutcome = `${stale.length} note${stale.length === 1 ? '' : 's'} dropped because the diff changed.`;
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
  if (!diffById.has(key)) requestDiff(key);
  if (!mapById.has(key)) requestChangeMap(key);
  render();
}

export function forgetReviewSession(id: unknown) {
  const key = sessionIdOf(id);
  statusById.delete(key);
  reasonById.delete(key);
  diffById.delete(key);
  mapById.delete(key);
  syncById.delete(key);
  resyncingIds.delete(key);
  if (resyncResult && resyncResult.forId === key) { clearTimeout(resyncResultTimer ?? undefined); resyncResult = null; }
  if (key === getSelectedId()) { setSelectedId(null); return; }
  render();
}

export function mergeSelectedSession() {
  const id = getSelectedId();
  if (!id || isWorkspaceSession(id)) return false;
  const ui = sessionUIs.get(id);
  if (!ui) return false;
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
  if (primaryAction !== 'merge' || !mergeAction.isEnabled) return false;
  sendMergeContinue(id, ui.currentState);
  return true;
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
  if (primaryAction !== 'resolve') return false;
  sendControlMsg({ type: 'resolve-session-merge', id });
  return true;
}

export function resyncSelectedSession() {
  const id = getSelectedId();
  if (!id || !sessionUIs.has(id) || isWorkspaceSession(id)) return false;
  if (isBranchSyncBusy(id)) return false;
  requestBranchSyncAction(id);
  return true;
}

function sessionHasChanges(id: string) {
  const payload = diffById.get(id) ?? null;
  const changedFiles = [
    ...parseUnifiedDiff(payload?.committed?.diff || ''),
    ...parseUnifiedDiff(payload?.uncommitted?.diff || ''),
  ];
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
    sendControlMsg({ type: 'merge-continue-session', id });
    return;
  }
  openConfirmDialog({
    title: 'Merge while working',
    message: 'This session still looks like it is working. Merging rebases its worktree under it. Merge anyway?',
    confirmLabel: 'Merge anyway',
    onConfirm: () => sendControlMsg({ type: 'merge-continue-session', id, force: true }),
  });
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
  if (resyncing) return { text: 'Resyncing...', loading: true, error: false };
  if (resyncResult && resyncResult.forId === id) return { text: resyncResult.text, loading: false, error: resyncResult.isError };
  return null;
}

function sessionName(ui: SessionUi | null | undefined, id: string) {
  return ui?.card?.dataset.session || id;
}

function clearDraftAnnotations() {
  draftNoteByKey.clear();
  openEditorKey = null;
  notesOutcome = null;
  notesSendInFlight = false;
}

function draftAnnotationFor(noteKey: string) {
  return draftNoteByKey.get(noteKey) ?? null;
}

function notesStatusText() {
  return `${draftNoteByKey.size} note${draftNoteByKey.size === 1 ? '' : 's'} drafted`;
}

function draftListEntry(noteKey: string, draft: DiffAnnotation) {
  const entry = el('div', 'review-notes-entry');
  const sideMarker = draft.side === 'old' ? ' (removed line)' : '';
  entry.append(el('span', 'review-notes-entry-where', `${draft.section} ${draft.path}:${draft.line}${sideMarker}`));
  entry.append(el('span', 'review-notes-entry-note', draft.note));
  const remove = el('button', 'review-note-remove', 'Remove');
  remove.type = 'button';
  remove.title = 'Drop this note';
  remove.addEventListener('click', () => removeDraftNote(noteKey));
  entry.append(remove);
  return entry;
}

function renderDraftList() {
  if (!notesListEl) return;
  notesListEl.replaceChildren();
  notesListEl.hidden = draftNoteByKey.size === 0;
  for (const [noteKey, draft] of draftNoteByKey) notesListEl.append(draftListEntry(noteKey, draft));
}

function updateNotesBar() {
  if (!notesEl || !sendNotesBtn || !notesStatusEl) return;
  const id = getSelectedId();
  const hasSelectedSession = !!id && sessionUIs.has(id);
  notesEl.hidden = !hasSelectedSession || selectedView === 'map' || draftNoteByKey.size === 0;
  sendNotesBtn.disabled = notesSendInFlight || draftNoteByKey.size === 0;
  notesStatusEl.textContent = notesStatusText();
  if (notesCountEl) {
    notesCountEl.hidden = draftNoteByKey.size === 0;
    notesCountEl.textContent = String(draftNoteByKey.size);
    notesCountEl.setAttribute('aria-label', notesStatusText());
  }
  if (notesOutcomeEl) {
    notesOutcomeEl.textContent = notesSendInFlight ? 'Sending notes...' : notesOutcome;
    notesOutcomeEl.hidden = !hasSelectedSession || selectedView === 'map' || !notesOutcomeEl.textContent;
  }
  renderDraftList();
  if (selectedView === 'notes' && hasSelectedSession) renderNotesView();
}

function renderNotesView() {
  if (!bodyEl || !notesListEl) return;
  bodyEl.replaceChildren();
  if (draftNoteByKey.size === 0) {
    renderEmpty('No notes yet', 'Open the Diff tab and press note on a line to draft one.');
    return;
  }
  bodyEl.append(notesListEl);
}

function sendDraftAnnotations() {
  const id = getSelectedId();
  if (!id || notesSendInFlight || draftNoteByKey.size === 0) return;
  notesSendInFlight = true;
  notesOutcome = null;
  updateNotesBar();
  void sendControlRequest('send-diff-annotations', { id, annotations: [...draftNoteByKey.values()] })
    .then(applyDiffAnnotationsResult, failDraftAnnotations);
}

function failDraftAnnotations(reason: unknown) {
  notesSendInFlight = false;
  const text = reason instanceof Error ? reason.message : '';
  notesOutcome = text ? `Could not send the notes: ${text}.` : 'Could not send the notes.';
  updateNotesBar();
}

function annotationsResultError(message: ServerMessage) {
  if (message.type === 'send-diff-annotations-result' && typeof message.error === 'string' && message.error) return message.error;
  if (message.type === 'error' && typeof message.message === 'string' && message.message) return message.message;
  return 'Could not send the notes.';
}

function applyDiffAnnotationsResult(message: ServerMessage) {
  notesSendInFlight = false;
  if (message.type !== 'send-diff-annotations-result' || message.ok !== true) {
    notesOutcome = annotationsResultError(message);
    updateNotesBar();
    return;
  }
  if (message.pending === true) {
    notesOutcome = 'Notes queued until the session wakes. They stay drafted here, and pressing Send notes again re-sends them.';
    updateNotesBar();
    return;
  }
  notesOutcome = 'Notes sent.';
  draftNoteByKey.clear();
  openEditorKey = null;
  render();
}

function noteDisplay(noteKey: string, note: string) {
  const wrap = el('div', 'review-note');
  wrap.dataset.noteFor = noteKey;
  wrap.append(el('span', 'review-note-text', note));
  const remove = el('button', 'review-note-remove', 'Remove');
  remove.type = 'button';
  remove.title = 'Drop this note';
  remove.addEventListener('click', () => removeDraftNote(noteKey));
  wrap.append(remove);
  return wrap;
}

function noteEditor(noteKey: string, initial: string) {
  const wrap = el('div', 'review-note-editor');
  wrap.dataset.editorFor = noteKey;
  const input = el('input', 'review-note-input');
  input.type = 'text';
  input.value = initial;
  input.maxLength = DIFF_ANNOTATION_NOTE_MAX_CHARS;
  input.placeholder = 'Note for this line';
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); saveDraftNote(noteKey, input.value); return; }
    if (event.key === 'Escape') { event.preventDefault(); closeNoteEditor(); }
  });
  const save = el('button', 'review-note-save', 'Save');
  save.type = 'button';
  save.addEventListener('click', () => saveDraftNote(noteKey, input.value));
  const cancel = el('button', 'review-note-cancel', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', closeNoteEditor);
  wrap.append(input, save, cancel);
  return wrap;
}

function noteAttachments(noteKey: string) {
  const built: HTMLElement[] = [];
  const draft = draftAnnotationFor(noteKey);
  if (openEditorKey === noteKey) built.push(noteEditor(noteKey, draft ? draft.note : ''));
  if (draft) built.push(noteDisplay(noteKey, draft.note));
  return built;
}

function attachNotesTo(row: HTMLElement, noteKey: string) {
  const attachments = noteAttachments(noteKey);
  row.after(...attachments);
  return attachments;
}

function detachNoteAttachments(row: HTMLElement) {
  let next = row.nextElementSibling;
  while (next instanceof HTMLElement && (next.dataset.noteFor !== undefined || next.dataset.editorFor !== undefined)) {
    const following = next.nextElementSibling;
    next.remove();
    next = following;
  }
}

function refreshAnnotatedRows(noteKey: string) {
  const annotated = annotatedLineByNoteKey.get(noteKey);
  if (!annotated) return;
  let inputToFocus: HTMLInputElement | null = null;
  for (const row of annotated.rows) {
    detachNoteAttachments(row);
    const attachments = attachNotesTo(row, noteKey);
    for (const attachment of attachments) {
      const input = attachment.querySelector('input');
      if (!inputToFocus && input instanceof HTMLInputElement) inputToFocus = input;
    }
  }
  if (!inputToFocus) return;
  inputToFocus.focus();
  inputToFocus.select();
}

function openNoteEditor(noteKey: string) {
  const previous = openEditorKey;
  openEditorKey = noteKey;
  if (previous && previous !== noteKey) refreshAnnotatedRows(previous);
  refreshAnnotatedRows(noteKey);
}

function closeNoteEditor() {
  const key = openEditorKey;
  if (!key) return;
  openEditorKey = null;
  refreshAnnotatedRows(key);
}

function saveDraftNote(noteKey: string, raw: string) {
  const annotated = annotatedLineByNoteKey.get(noteKey);
  if (!annotated) return;
  const note = raw.trim();
  if (!note) return;
  if (draftNoteByKey.size >= DIFF_ANNOTATIONS_MAX && !draftNoteByKey.has(noteKey)) {
    notesOutcome = `Only ${DIFF_ANNOTATIONS_MAX} notes can be sent at once.`;
    updateNotesBar();
    return;
  }
  draftNoteByKey.set(noteKey, { ...annotated.target, section: annotated.section, note });
  notesOutcome = null;
  openEditorKey = null;
  refreshAnnotatedRows(noteKey);
  updateNotesBar();
}

function removeDraftNote(noteKey: string) {
  draftNoteByKey.delete(noteKey);
  notesOutcome = null;
  refreshAnnotatedRows(noteKey);
  updateNotesBar();
}

function setSelectedView(view: UiPrefs['reviewSidebarView']) {
  selectedView = view;
  if (view !== 'diff') pendingOpenFilePath = null;
  setReviewSidebarView(view);
  render();
}

function expandFileInDiff(path: string, payload: SessionDiffPayload | null | undefined) {
  if (!payload) return;
  const committed = parseUnifiedDiff(payload.committed?.diff);
  const uncommitted = parseUnifiedDiff(payload.uncommitted?.diff);
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

function openFileFromMap(path: string) {
  pendingOpenFilePath = path;
  expandFileInDiff(path, diffById.get(getSelectedId() ?? ''));
  setSelectedView('diff');
  scrollToPendingFile();
}

function render() {
  if (!controlsEl || !bodyEl) return;
  controlsEl.replaceChildren();
  bodyEl.replaceChildren();
  for (const [view, button] of viewButtonByView) button.setAttribute('aria-pressed', String(selectedView === view));
  annotatedLineByNoteKey.clear();
  updateNotesBar();
  if (railLabelEl) railLabelEl.hidden = true;
  if (railStatusEl) railStatusEl.hidden = true;

  const id = getSelectedId();
  const ui = id ? sessionUIs.get(id) : null;
  if (!id || !ui) {
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

  const committedFiles = payload ? parseUnifiedDiff(payload.committed?.diff || '') : [];
  const uncommittedFiles = payload ? parseUnifiedDiff(payload.uncommitted?.diff || '') : [];
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
    status, mergeReason, fetched, hasChanges: totals.files > 0 || hasCommits, hasCommits,
    canMerge: !isWorkspace && mergeAction.isEnabled, isWorkspace, live, effectiveBase,
  });
  const statusLine = el('div', 'review-status-headline');
  statusLine.append(el('span', 'review-status-text', headline.text));
  if (!isWorkspace && !shouldShowBranchSyncLabel(sync)) {
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
  controlsEl.append(statusLine);

  const metadata = el('div', 'review-status-meta');
  if (shouldShowReviewHeaderCounts({ fetched, changedFileCount: totals.files, view: selectedView })) metadata.append(
    el('span', 'review-status-files', `${totals.files} file${totals.files === 1 ? '' : 's'}`),
    el('span', 'review-status-added', `+${totals.added}`),
    el('span', 'review-status-removed', `-${totals.removed}`),
    el('span', 'review-status-spacer'),
  );
  if (!isWorkspace && shouldShowBranchSyncLabel(sync)) {
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
    if (!metadata.isConnected) controlsEl.insertBefore(metadata, statusLine.nextSibling);
    controlsEl.querySelector('.review-branch-sync-text, .review-branch-sync-refresh')?.setAttribute('aria-describedby', resyncReasonLine.id);
  }

  if (resolveJustSent && resolveJustSentFor === id) {
    controlsEl.append(el('div', 'review-resolve-sent', 'Resolve prompt sent'));
  }

  if (selectedView === 'notes') return;

  if (selectedView === 'map') {
    const changeMap = mapById.get(id);
    if (!changeMap) {
      bodyEl.append(el('div', 'review-nochanges review-loading', 'Loading map...'));
      return;
    }
    const changeMapView = buildChangeMapView(changeMap);
    const mapNetEmptyText = netEmptyChangesText({
      fetched, changedFileCount: totals.files, hasCommits,
      hasOtherBodyContent: changeMapView.repos.length > 0 || !!changeMapView.error,
    });
    if (mapNetEmptyText) bodyEl.append(el('div', 'review-nochanges', mapNetEmptyText));
    bodyEl.append(renderChangeMapView(changeMapView, openFileFromMap));
    return;
  }

  const diffNetEmptyText = netEmptyChangesText({ fetched, changedFileCount: totals.files, hasCommits, hasOtherBodyContent: false });
  if (diffNetEmptyText) bodyEl.append(el('div', 'review-nochanges', diffNetEmptyText));
  if (committedFiles.length > 0) bodyEl.append(renderSection('committed', 'Committed', committedMergeTargetText(headline, effectiveBase), committedFiles));
  if (uncommittedFiles.length > 0) bodyEl.append(renderSection('uncommitted', 'Uncommitted', null, uncommittedFiles));
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
  const row = createReviewIconButton('Refresh branch sync', 'M13 6A5 5 0 1 0 13 10M13 2v4H9');
  row.className = 'review-branch-sync-text';
  row.removeAttribute('aria-label');
  row.append(el('span', 'review-branch-sync-label', label));
  row.disabled = resyncingIds.has(id);
  if (sync.state) row.dataset.syncState = sync.state;
  if (sync.fetched === false) row.dataset.stale = 'true';
  row.title = branchSyncActionTitle(sync, resolveShortcutHint, shortcutResyncs);
  row.addEventListener('click', () => requestBranchSyncAction(id));
  return row;
}

function renderSection(kind: DiffAnnotation['section'], label: string, meaning: string | null, files: DiffFile[]) {
  const wrap = el('div', 'review-section');
  wrap.dataset.kind = kind;

  const sum = summarizeFiles(files);
  const head = el('div', 'review-section-head');

  const titleGroup = el('div', 'review-section-id');
  titleGroup.append(el('span', 'review-section-label', label));
  if (meaning) titleGroup.append(el('span', 'review-section-meaning', meaning));
  head.append(titleGroup);

  const stat = el('div', 'review-section-stat');
  stat.append(el('span', 'review-stat-files', `${sum.files} file${sum.files === 1 ? '' : 's'}`));
  stat.append(
    el('span', 'review-add', `+${sum.added}`),
    el('span', 'review-del', `-${sum.removed}`)
  );
  head.append(stat);
  wrap.append(head);

  const list = el('div', 'review-diff');
  for (const f of files) list.append(renderFile(f, kind));
  wrap.append(list);
  return wrap;
}

function renderFile(f: DiffFile, kind: DiffAnnotation['section']) {
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
  head.append(twisty, el('span', 'review-file-path', f.path));
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
      const target = annotationTargetOf(f, line);
      body.append(row);
      rendered++;
      if (!target) continue;
      const noteKey = annotationKey(kind, target.path, target.line, target.side);
      const annotated = annotatedLineByNoteKey.get(noteKey) ?? { target, section: kind, rows: [] };
      annotated.rows.push(row);
      annotatedLineByNoteKey.set(noteKey, annotated);
      row.dataset.noteKey = noteKey;
      const annotate = el('button', 'review-annotate', 'note');
      annotate.type = 'button';
      annotate.title = `Note on ${target.path}:${target.line}`;
      annotate.addEventListener('click', () => openNoteEditor(noteKey));
      row.append(annotate);
      attachNotesTo(row, noteKey);
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
      disabled: !mergeAction.isEnabled,
      onClick: () => sendMergeContinue(id, state),
    }));
  }

  if (resolveShown) {
    actions.append(actionButton({
      label: 'Resolve',
      shortcut: resolveShortcutHint,
      title: `Paste a resolve prompt into this session so the agent can finish the merge (${resolveShortcutHint})`,
      onClick: () => {
        sendControlMsg({ type: 'resolve-session-merge', id });
        resolveJustSent = true;
        resolveJustSentFor = id;
        clearTimeout(resolveSentTimer ?? undefined);
        resolveSentTimer = setTimeout(() => { resolveJustSent = false; resolveJustSentFor = null; render(); }, 3000);
        render();
      },
    }));
  }

  const actionControls = el('div', 'review-action-controls');
  actionControls.append(actions);
  if (!reviewable || live) return actions.childElementCount > 0 ? actionControls : null;

  const moreButton = createReviewIconButton('More review actions', 'M3 8h0.01M8 8h0.01M13 8h0.01');
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
