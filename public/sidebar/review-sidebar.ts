import type { DiffAnnotation, ServerMessage } from '#shared/contracts/control-messages.ts';
import { DIFF_ANNOTATION_NOTE_MAX_CHARS, DIFF_ANNOTATIONS_MAX } from '#shared/contracts/control-messages.ts';
import type { SessionState } from '#shared/states.ts';
import { MERGEABLE_LIVE_STATES, STATES } from '#shared/states.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { adoptElement, el, releaseElement } from '../dom-helpers.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionIdOf, sessionUIs } from '../session-card/card-registry.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { getSidebarWidth, isReviewSidebarCollapsed, setReviewSidebarCollapsed, setSidebarWidth } from '../ui-prefs.ts';
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
  decideMergeAction,
  mergeActionTitle,
  mergeDisabledReason,
  mergeTargetText,
  parkedStatusText,
} from './review-copy-core.ts';
import type { MergeActionVerdict } from './review-copy-core.ts';
import { getSelectedId, onSelectionChange, setSelectedId } from './selection.ts';

interface SessionDiffPayload {
  committed?: { diff?: string } | null;
  uncommitted?: { diff?: string } | null;
  hasCommits?: boolean;
}

interface BranchSync {
  branch?: string;
  upstream?: string;
  state?: string;
  ahead?: number;
  behind?: number;
  fetched?: boolean | null;
  action?: string;
  error?: string | null;
}

const REVIEWABLE = new Set(['pending-review', 'parked']);
const MAX_FILE_LINES = 600;
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 700;

const statusById = new Map<string, string>();
const reasonById = new Map<string, string | null>();
const diffById = new Map<string, SessionDiffPayload | null>();

const syncById = new Map<string, BranchSync | null>();

const resyncingIds = new Set<string>();

const openFiles = new Set<string>();
const expanded = new Set<string>();

let panelEl: HTMLElement | null = null;
let branchSyncEl: HTMLElement | null = null;
let controlsEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let sessionNameEl: HTMLElement | null = null;
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
let notesListEl: HTMLElement | null = null;
const draftNoteByKey = new Map<string, DiffAnnotation>();
let openEditorKey: string | null = null;
let notesSendInFlight = false;
let notesOutcome: string | null = null;

export function mountReviewSidebar({ panel }: { panel: HTMLElement | null }) {
  panelEl = panel;
  if (!panelEl) return;
  const mountedPanel = panelEl;

  const head = el('div', 'review-sidebar-head');
  const title = el('span', 'review-sidebar-title', 'Review');
  sessionNameEl = el('span', 'review-sidebar-session');
  const applyCollapsed = (isCollapsed: boolean) => {
    mountedPanel.toggleAttribute('data-collapsed', isCollapsed);
    setReviewSidebarCollapsed(isCollapsed);
  };

  const minimizeBtn = el('button', 'review-btn review-sidebar-minimize', 'Minimize');
  minimizeBtn.type = 'button';
  minimizeBtn.title = 'Minimize the review sidebar to give the terminal more room';
  minimizeBtn.addEventListener('click', () => applyCollapsed(true));
  head.append(title, sessionNameEl, minimizeBtn);

  const expandBtn = el('button', 'review-sidebar-expand', 'Show review');
  expandBtn.type = 'button';
  expandBtn.title = 'Restore the review sidebar';
  expandBtn.addEventListener('click', () => applyCollapsed(false));

  branchSyncEl = el('div', 'review-branch-sync');

  controlsEl = el('div', 'review-controls');
  bodyEl = el('div', 'review-sidebar-body');

  notesEl = el('div', 'review-notes');
  const notesBar = el('div', 'review-notes-bar');
  sendNotesBtn = el('button', 'review-btn review-btn-primary', 'Send notes');
  sendNotesBtn.type = 'button';
  sendNotesBtn.title = 'Paste the drafted review notes into this session as one message';
  sendNotesBtn.addEventListener('click', sendDraftAnnotations);
  notesStatusEl = el('div', 'review-notes-status');
  notesBar.append(sendNotesBtn, notesStatusEl);
  notesListEl = el('div', 'review-notes-list');
  notesEl.append(notesBar, notesListEl);

  const handle = el('div', 'review-resize-handle');
  handle.setAttribute('aria-hidden', 'true');
  mountedPanel.append(expandBtn, head, branchSyncEl, controlsEl, notesEl, bodyEl, handle);
  mountedPanel.toggleAttribute('data-collapsed', isReviewSidebarCollapsed());

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

    openFiles.clear();
    expanded.clear();
    clearDraftAnnotations();
    if (id) { requestDiff(id); requestBranchSync(id); }
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
  if (shouldDropDiffCache(prev, next)) diffById.delete(id);
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

export function setReviewDiff(id: string, payload: unknown) {
  const next = (payload || null) as SessionDiffPayload | null;
  const previous = diffById.get(id) ?? null;
  diffById.set(id, next);
  if (id !== getSelectedId()) return;
  dropDraftsForChangedSections(previous, next);
  render();
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

export function setReviewBranchSync(id: unknown, payload: unknown) {
  const key = sessionIdOf(id);
  const sync = (payload || null) as BranchSync | null;
  syncById.set(key, sync);
  if (sync && sync.action !== undefined) applyResyncResult(key, sync);
  if (key === getSelectedId()) render();
}

function applyResyncResult(id: string, payload: BranchSync) {
  resyncingIds.delete(id);
  clearTimeout(resyncResultTimer ?? undefined);
  const text = resyncOutcomeText(payload);
  resyncResult = text ? { forId: id, text, isError: !!payload.error } : null;
  if (resyncResult && !resyncResult.isError) {
    resyncResultTimer = setTimeout(() => {
      if (resyncResult && resyncResult.forId === id) resyncResult = null;
      render();
    }, 5000);
  }
}

function resyncOutcomeText(sync: BranchSync) {
  if (sync.error) return `Resync failed: ${sync.error}`;
  if (sync.action === 'fast-forwarded') return `Fast-forwarded ${sync.branch} to ${sync.upstream}.`;
  if (sync.action === 'pushed') return `Pushed ${sync.branch} to ${sync.upstream}.`;
  if (sync.state === 'diverged') return `${sync.branch} has diverged from ${sync.upstream}. Resolve manually.`;
  if (sync.state === 'in-sync') return `${sync.branch} is already in sync with ${sync.upstream}.`;
  if (sync.state === 'no-upstream') return `${sync.branch || 'The base branch'} has no upstream to resync against.`;
  return 'Could not determine sync status.';
}

export function notifyWorktreeChanged(id: unknown) {
  const key = sessionIdOf(id);
  if (key && key === getSelectedId()) requestDiff(key);
}

export function refreshReviewSidebar(id: unknown) {
  const key = sessionIdOf(id);
  if (key !== getSelectedId()) return;
  if (!diffById.has(key)) requestDiff(key);
  render();
}

export function forgetReviewSession(id: unknown) {
  const key = sessionIdOf(id);
  statusById.delete(key);
  reasonById.delete(key);
  diffById.delete(key);
  syncById.delete(key);
  resyncingIds.delete(key);
  if (resyncResult && resyncResult.forId === key) { clearTimeout(resyncResultTimer ?? undefined); resyncResult = null; }
  if (key === getSelectedId()) { setSelectedId(null); return; }
  render();
}

export function mergeSelectedSession() {
  const id = getSelectedId();
  if (!id) return false;
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
  if (!mergeAction.isEnabled) return false;
  sendMergeContinue(id, ui.currentState);
  return true;
}

export function resolveSelectedSession() {
  const id = getSelectedId();
  if (!id) return false;
  const ui = sessionUIs.get(id);
  if (!ui) return false;
  if ((statusById.get(id) || 'none') !== 'parked') return false;
  if (reasonById.get(id) === 'base-diverged') return false;
  if (!isLive(ui.currentState)) return false;
  sendControlMsg({ type: 'resolve-session-merge', id });
  return true;
}

export function resyncSelectedSession() {
  const id = getSelectedId();
  if (!id || !sessionUIs.has(id)) return false;
  if (resyncingIds.has(id)) return false;
  if (resyncDisabledReason(syncById.get(id), false)) return false;
  requestResyncBranch(id);
  return true;
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

function branchSyncLabel(sync: BranchSync | null | undefined) {
  if (!sync) return null;
  const { branch, upstream, state, ahead, behind } = sync;
  if (state === 'no-upstream') return `${branch}: no upstream`;
  if (state === 'unknown') return `${branch}: sync state unknown vs ${upstream}`;
  if (state === 'in-sync') return `${branch}: in sync with ${upstream}`;
  if (state === 'ahead') return `${branch}: ${ahead} ahead of ${upstream}`;
  if (state === 'behind') return `${branch}: ${behind} behind ${upstream}`;
  if (state === 'diverged') return `${branch}: ${ahead} ahead, ${behind} behind ${upstream}`;
  return null;
}

function resyncDisabledReason(sync: BranchSync | null | undefined, resyncing: boolean) {
  if (resyncing) return null;
  if (!sync) return 'Checking branch sync...';
  if (sync.state === 'no-upstream') return 'No upstream configured.';
  if (sync.state === 'unknown') return 'Could not determine sync status.';
  return null;
}

function resyncStatusLine(id: string, sync: BranchSync | null | undefined, resyncing: boolean) {
  if (resyncing) return { text: 'Resyncing...', loading: true, error: false };
  if (resyncResult && resyncResult.forId === id) return { text: resyncResult.text, loading: false, error: resyncResult.isError };
  const reason = resyncDisabledReason(sync, false);
  return reason ? { text: reason, loading: !sync, error: false } : null;
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
  if (notesSendInFlight) return 'Sending notes...';
  if (notesOutcome) return notesOutcome;
  if (draftNoteByKey.size === 0) return 'Annotate a diff line to draft a note.';
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
  notesEl.hidden = !id || !sessionUIs.has(id);
  sendNotesBtn.disabled = notesSendInFlight || draftNoteByKey.size === 0;
  notesStatusEl.textContent = notesStatusText();
  renderDraftList();
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

function render() {
  if (!controlsEl || !bodyEl) return;
  controlsEl.replaceChildren();
  bodyEl.replaceChildren();
  annotatedLineByNoteKey.clear();
  updateNotesBar();
  if (branchSyncEl) branchSyncEl.replaceChildren();

  const id = getSelectedId();
  const ui = id ? sessionUIs.get(id) : null;
  if (!id || !ui) {
    if (sessionNameEl) sessionNameEl.textContent = '';
    renderEmpty('No session selected', 'Click a session name to review its changes here.');
    return;
  }

  if (branchSyncEl) {
    const row = renderBranchSync(id);
    if (row) branchSyncEl.append(row);
  }

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

  if (sessionNameEl) sessionNameEl.textContent = sessionName(ui, id);

  const statusNoteText = status === 'parked' ? parkedStatusText(mergeReason)
    : status === 'merging' ? 'Merging...'
    : status === 'merged' ? 'Merged'
    : null;
  if (statusNoteText) {
    const note = el('div', 'review-status-note');
    note.dataset.merge = status;
    note.textContent = statusNoteText;
    controlsEl.append(note);
  }

  const effectiveBase = baseLabel(ui.effectiveBase);
  const actions = renderActions(id, {
    status, reviewable, mergeAction, live, state, sync, resyncing, effectiveBase, mergeReason,
  });
  controlsEl.append(actions);

  const resyncStatus = resyncStatusLine(id, sync, resyncing);
  if (resyncStatus) {
    const r = el('div', resyncStatus.loading ? 'review-control-reason review-loading' : 'review-control-reason', resyncStatus.text);
    if (resyncStatus.error) r.classList.add('review-control-reason-error');
    r.id = 'review-resync-reason';
    controlsEl.append(r);
    const resyncBtn = actions.querySelector('#review-resync-btn');
    if (resyncBtn) resyncBtn.setAttribute('aria-describedby', 'review-resync-reason');
  }

  let reasonShown = false;
  if (mergeAction.isRendered && !mergeAction.isEnabled) {
    const reason = mergeDisabledReason({ status, mergeReason, fetched, hasCommits, live, state });
    if (reason) {

      const r = el('div', !fetched ? 'review-control-reason review-loading' : 'review-control-reason', reason);
      r.id = 'review-merge-reason';
      controlsEl.append(r);
      reasonShown = true;
      const mergeBtn = actions.querySelector('#review-merge-btn');
      if (mergeBtn) mergeBtn.setAttribute('aria-describedby', 'review-merge-reason');
    }
  }

  if (resolveJustSent && resolveJustSentFor === id) {
    controlsEl.append(el('div', 'review-resolve-sent', 'Resolve prompt sent'));
  }

  if (committedFiles.length > 0) {
    bodyEl.append(renderSection('committed', 'Committed', mergeTargetText(effectiveBase), committedFiles));
  }
  if (committedFiles.length === 0 && !reasonShown) {

    const placeholder = !fetched && reviewable
      ? el('div', 'review-nochanges review-loading', 'Loading diff...')
      : el('div', 'review-nochanges', uncommittedFiles.length > 0 ? 'No committed changes.' : 'No changes in this worktree.');
    bodyEl.append(placeholder);
  }

  if (uncommittedFiles.length > 0) {
    bodyEl.append(renderSection('uncommitted', 'Uncommitted', '', uncommittedFiles));
  }
}

function renderEmpty(title: string, desc: string) {
  if (!bodyEl) return;
  const wrap = el('div', 'review-empty');
  wrap.append(el('div', 'review-empty-title', title), el('div', 'review-empty-desc', desc));
  bodyEl.append(wrap);
}

function renderBranchSync(id: string) {
  const sync = syncById.get(id);
  if (sync === undefined) return null;
  if (sync === null) return el('span', 'review-branch-sync-text review-loading', 'Checking branch sync...');
  const label = branchSyncLabel(sync);
  if (!label) return null;
  const row = el('button', 'review-branch-sync-text', label);
  row.type = 'button';
  row.dataset.syncState = sync.state;

  const isStale = sync.fetched === false && sync.state !== 'no-upstream';
  if (isStale) row.dataset.stale = 'true';
  row.title = isStale
    ? 'The last fetch against the remote failed; these counts may be stale. Click to retry.'
    : 'Click to refresh';
  row.addEventListener('click', () => requestBranchSync(id));
  return row;
}

function renderSection(kind: DiffAnnotation['section'], label: string, meaning: string, files: DiffFile[]) {
  const wrap = el('div', 'review-section');
  wrap.dataset.kind = kind;

  const sum = summarizeFiles(files);
  const head = el('div', 'review-section-head');

  const lhs = el('div', 'review-section-id');
  lhs.append(el('span', 'review-section-label', label));
  if (meaning) lhs.append(el('span', 'review-section-meaning', meaning));
  head.append(lhs);

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
  status, reviewable, mergeAction, live, state, sync, resyncing, effectiveBase, mergeReason,
}: {
  status: string;
  reviewable: boolean;
  mergeAction: MergeActionVerdict;
  live: boolean;
  state: string;
  sync: BranchSync | null | undefined;
  resyncing: boolean;
  effectiveBase: string;
  mergeReason: string | null;
}) {
  const actions = el('div', 'review-actions');

  if (mergeAction.isRendered) {
    actions.append(actionButton({
      id: 'review-merge-btn',
      label: 'Merge',
      shortcut: 'alt+m',
      title: mergeActionTitle(effectiveBase),
      disabled: !mergeAction.isEnabled,
      onClick: () => sendMergeContinue(id, state),
    }));
  }

  const resolveShown = status === 'parked' && live && mergeReason !== 'base-diverged';
  if (resolveShown) {
    actions.append(actionButton({
      label: 'Resolve',
      shortcut: 'alt+r',
      title: 'Paste a resolve prompt into this session so the agent can finish the merge (alt+r)',
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

  actions.append(actionButton({
    id: 'review-resync-btn',
    label: 'Resync',
    shortcut: resolveShown ? undefined : 'alt+r',
    title: resolveShown
      ? 'Fetch and fast-forward/push the local base branch against its remote upstream'
      : 'Fetch and fast-forward/push the local base branch against its remote upstream (alt+r)',
    disabled: resyncing || !!resyncDisabledReason(sync, resyncing),
    onClick: () => requestResyncBranch(id),
  }));

  if (reviewable && !live) {
    actions.append(actionButton({
      label: 'Discard',
      danger: true,
      disabled: status === 'merging',
      onClick: () => {
        const ui = sessionUIs.get(id);
        const nm = sessionName(ui, id);
        openConfirmDialog({
          title: 'Discard worktree',
          message: `Throw away the worktree changes for "${nm}"? This cannot be undone.`,
          confirmLabel: 'Discard',
          onConfirm: () => sendControlMsg({ type: 'discard-session-worktree', id }),
        });
      },
    }));
  }
  return actions;
}
