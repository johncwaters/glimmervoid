import { repoNameForPath } from '#shared/change-map-view-core.ts';
import { createPressable } from '../ui/pressable.ts';
import { shortSha } from '#shared/git-text.ts';
import { el, isRealInputOwningKey } from '../dom-helpers.ts';
import type { ButtonStyle, SessionPage, SessionPagePlacement } from '../session-pages/session-pages.ts';
import { announceSessionPageChange } from '../session-pages/session-pages.ts';
import { getJSON, setJSON } from '../local-store.ts';
import { sendControlRequest } from '../control-ws.ts';
import { CHANGES_ICON_PATH } from '../svg-dom.ts';
import { renderFileHints, renderWorthALook } from './change-map-view.ts';
import type { ReviewComment } from '#shared/contracts/review-state.ts';
import type { DiffAnnotation, DiffFileContents, DiffLineClick, DiffSide, MountedFileDiff } from './diff-view.ts';
import { mountFileDiff, preloadDiffRenderer } from './diff-view.ts';
import type { DiffLayout, ReaderFile, ReviewScope } from './review-reader-core.ts';
import {
  effectiveDiffLayout, fileReadStateOf, findReaderFile, groupReaderFiles, isCommentOutdated, lineTextAt, readerStateOf, shouldHoldUpdate, stepReaderFile,
} from './review-reader-core.ts';
import type { SessionReview } from './review-store.ts';
import { onReviewChange, refreshReview, reviewOf, syncWatch, watchReviewSurface } from './review-store.ts';
import { getSelectedId, onSelectionChange } from './selection.ts';
import { clock } from '#shared/clock.ts';

const CHANGES_PAGE_ID = 'changes';

interface ReaderParts {
  root: HTMLElement;
  fileColumn: HTMLElement;
  diff: HTMLElement;
}

const STATUS_NAME_BY_LETTER: Record<ReaderFile['status'], string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed' };

const DIFF_LAYOUT_KEY = 'glimmervoid-review-diff-layout';

const DIFF_LAYOUTS: readonly { layout: DiffLayout; label: string }[] = [
  { layout: 'unified', label: 'Unified' },
  { layout: 'split', label: 'Split' },
];

const REVIEW_SCOPES: readonly { scope: ReviewScope; label: string }[] = [
  { scope: 'all', label: 'All changes' },
  { scope: 'since-last-review', label: 'Changes since your last review' },
];

const DRAFT_ANNOTATION_KEY = 'draft';

interface ShownDiff {
  key: string;
  mounted: Promise<MountedFileDiff | null>;
  viewedToggle: HTMLInputElement;
  updateNotice: HTMLElement;
}

interface DraftAnchor {
  path: string;
  side: DiffSide;
  line: number;
  lineText: string;
}

let parts: ReaderParts | null = null;
let placement: SessionPagePlacement | null = null;
let shownSessionId: string | null = null;
let selectedPath: string | null = null;
let requestedPath: string | null = null;
let isWorthALookShowingAll = false;
let shownDiff: ShownDiff | null = null;
let diffWidthPx = 0;
let chosenLayout: DiffLayout = getJSON<unknown>(DIFF_LAYOUT_KEY, 'unified') === 'split' ? 'split' : 'unified';
let scope: ReviewScope = 'all';
let displayedFile: ReaderFile | null = null;
let draftAnchor: DraftAnchor | null = null;
let draftComposer: { root: HTMLElement; text: HTMLTextAreaElement; label: HTMLElement; send: HTMLButtonElement; error: HTMLElement } | null = null;
const annotationElementByKey = new Map<string, HTMLElement>();

function buildReader(): ReaderParts {
  const root = el('section', 'review-reader');
  root.setAttribute('aria-label', 'Changes');
  root.tabIndex = -1;
  root.hidden = true;
  const body = el('div', 'review-reader-body');
  const fileColumn = el('div', 'review-reader-files');
  const diff = el('div', 'review-reader-diff');
  body.append(fileColumn, diff);
  root.append(body);
  root.addEventListener('keydown', onReaderKeydown);
  onReviewChange((sessionId) => {
    if (sessionId === shownSessionId) render();
  });
  onSelectionChange(() => {
    selectedPath = null;
    isWorthALookShowingAll = false;
    render();
    announceLevel();
  });
  watchReviewSurface(root);
  new ResizeObserver(() => onDiffResize(diff)).observe(diff);
  return { root, fileColumn, diff };
}

function onDiffResize(diff: HTMLElement) {
  const couldSplit = effectiveDiffLayout('split', diffWidthPx) === 'split';
  diffWidthPx = diff.clientWidth;
  if ((effectiveDiffLayout('split', diffWidthPx) === 'split') !== couldSplit) render();
}

function readerParts() {
  parts ??= buildReader();
  return parts;
}

function onReaderKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isRealInputOwningKey(event)) return;
  const step = event.key === 'j' ? 1 : event.key === 'k' ? -1 : 0;
  if (step === 0 || !shownSessionId) return;
  event.preventDefault();
  const review = reviewOf(shownSessionId);
  const nextPath = review ? stepReaderFile(listedFilesOf(review), selectedPath, step) : null;
  if (nextPath) selectFile(nextPath);
}

function announceLevel() {
  if (shownSessionId) announceSessionPageChange(CHANGES_PAGE_ID, shownSessionId);
}

function selectFile(path: string) {
  selectedPath = path;
  render();
  parts?.fileColumn.querySelector<HTMLElement>('.review-reader-file[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  announceLevel();
}

function settleSelectedPath(files: readonly ReaderFile[]) {
  const requestedFile = findReaderFile(files, requestedPath);
  if (requestedFile) {
    selectedPath = requestedFile.path;
    requestedPath = null;
  }
  if (findReaderFile(files, selectedPath)) return;
  selectedPath = placement === 'overlay' ? files[0]?.path ?? null : null;
}

function render() {
  if (!parts || placement === null) return;
  shownSessionId = getSelectedId();
  const review = shownSessionId ? reviewOf(shownSessionId) : null;
  if (!review) {
    renderNoSession(parts);
    return;
  }
  const hadOpenFile = selectedPath !== null;
  settleSelectedPath(review.files);
  parts.root.dataset.level = placement === 'screen' && selectedPath !== null ? 'diff' : 'list';
  renderFileColumn(parts.fileColumn, review);
  renderDiff(parts.diff, findReaderFile(review.files, selectedPath), review);
  if (hadOpenFile !== (selectedPath !== null)) announceLevel();
}

function renderNoSession(readerPartsToPaint: ReaderParts) {
  readerPartsToPaint.root.dataset.level = 'list';
  readerPartsToPaint.fileColumn.replaceChildren(el('p', 'review-empty-title', 'No session selected'));
  renderDiff(readerPartsToPaint.diff, null, null);
}

function viewedHashByPathOf(review: SessionReview) {
  return review.reviewState?.viewedHashByPath ?? {};
}

function listedFilesOf(review: SessionReview): ReaderFile[] {
  const { newFiles, viewedFiles, generatedFiles } = groupReaderFiles(review.files, viewedHashByPathOf(review), scope);
  return [...newFiles, ...viewedFiles, ...generatedFiles];
}

function chooseScope(nextScope: ReviewScope) {
  scope = nextScope;
  render();
}

function scopeMenu() {
  const menu = document.createElement('select');
  menu.className = 'review-scope';
  menu.setAttribute('aria-label', 'Which changes to list');
  for (const { scope: optionScope, label } of REVIEW_SCOPES) menu.append(new Option(label, optionScope, false, optionScope === scope));
  menu.addEventListener('change', () => chooseScope(menu.value === 'since-last-review' ? 'since-last-review' : 'all'));
  return menu;
}

function renderFileColumn(fileColumn: HTMLElement, review: SessionReview) {
  const scrollTop = fileColumn.scrollTop;
  fileColumn.replaceChildren();
  if (review.diffError) {
    const reloadButton = createPressable('review-reload', 'Reload changes');
    reloadButton.addEventListener('click', () => refreshReview(shownSessionId));
    fileColumn.append(el('p', 'review-diff-error', review.diffError), reloadButton);
    return;
  }
  if (review.isEmpty || review.files.length === 0) {
    fileColumn.append(el('p', 'review-empty-title', review.sentence));
    return;
  }
  if (review.statusLine) fileColumn.append(el('p', 'review-reader-status', review.statusLine));
  fileColumn.append(scopeMenu());
  if (review.totals.files > 0) fileColumn.append(totalsLine(review.totals));
  const { newFiles, viewedFiles, generatedFiles } = groupReaderFiles(review.files, viewedHashByPathOf(review), scope);
  const readerState = readerStateOf({ hasDiffError: false, isEmpty: review.isEmpty, fileCount: review.files.length, unviewedCount: newFiles.length + generatedFiles.length });
  if (readerState === 'caught-up') fileColumn.append(el('p', 'review-caught-up', 'Caught up: you have viewed every changed file.'));
  appendFileGroup(fileColumn, 'New', newFiles, review);
  appendFileGroup(fileColumn, 'Viewed', viewedFiles, review);
  appendFileGroup(fileColumn, 'Generated', generatedFiles, review);
  appendCommitGroup(fileColumn, review);
  const worthALook = review.changeMapView
    ? renderWorthALook(review.changeMapView, { isShowingAll: isWorthALookShowingAll, onShowAll: showAllWorthALook, onOpenFile: openFileFromWorthALook })
    : null;
  if (worthALook) fileColumn.append(worthALook);
  fileColumn.scrollTop = scrollTop;
}

function appendCommitGroup(fileColumn: HTMLElement, review: SessionReview) {
  if (review.commits.length === 0) return;
  fileColumn.append(el('p', 'review-reader-group', `Commits ${String.fromCharCode(183)} ${review.commits.length}`));
  const list = el('div', 'review-reader-commit-list');
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'Commits');
  for (const commit of review.commits) {
    const row = el('div', 'review-reader-commit');
    row.setAttribute('role', 'listitem');
    row.append(el('span', 'review-commit-sha', shortSha(commit.sha)), el('span', 'review-commit-subject', commit.subject), el('span', 'review-commit-signature', commit.isSigned ? 'Signed' : 'Unsigned'));
    list.append(row);
  }
  fileColumn.append(list);
}

function appendFileGroup(fileColumn: HTMLElement, groupName: string, files: readonly ReaderFile[], review: SessionReview) {
  if (files.length === 0) return;
  fileColumn.append(el('p', 'review-reader-group', `${groupName} ${String.fromCharCode(183)} ${files.length}`));
  const list = el('div', 'review-reader-file-list');
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', groupName);
  const repos = review.changeMapView && review.changeMapView.repos.length > 1 ? review.changeMapView.repos : [];
  let previousRepoName: string | null = null;
  for (const file of files) {
    const repoName = repos.length > 0 ? repoNameForPath(repos, file.path) : null;
    if (repoName && repoName !== previousRepoName) list.append(el('div', 'review-repo-label', repoName));
    previousRepoName = repoName;
    list.append(fileRow(file, review));
  }
  fileColumn.append(list);
}

function totalsLine(totals: SessionReview['totals']) {
  const line = el('p', 'review-reader-totals');
  line.append(
    el('span', 'review-stat-files', `${totals.files} file${totals.files === 1 ? '' : 's'}`),
    el('span', 'review-add', `+${totals.added}`),
    el('span', 'review-del', `-${totals.removed}`),
  );
  return line;
}

function fileRow(file: ReaderFile, review: SessionReview) {
  const row = createPressable('review-reader-file');
  row.dataset.path = file.path;
  row.dataset.status = file.status;
  if (file.isGenerated) row.dataset.generated = '';
  row.setAttribute('role', 'listitem');
  row.setAttribute('aria-current', String(file.path === selectedPath));
  const name = el('span', 'review-file-name');
  name.append(el('span', 'review-file-path', file.path));
  const hints = renderFileHints(review.changeMapView?.hintsByOpenPath.get(file.path));
  if (hints.length > 0) {
    const hintRow = el('span', 'review-file-hints');
    hintRow.append(...hints);
    name.append(hintRow);
  }
  const readState = fileReadStateOf(file, viewedHashByPathOf(review));
  row.dataset.readState = readState;
  if (readState === 'changed-again') name.append(el('span', 'review-changed-again', 'changed again'));
  const statusLetter = el('span', 'review-file-status', file.status);
  statusLetter.setAttribute('aria-label', STATUS_NAME_BY_LETTER[file.status]);
  row.append(statusLetter, name, fileCounts(file));
  row.addEventListener('click', () => selectFile(file.path));
  return row;
}

function fileCounts(file: ReaderFile) {
  const counts = el('span', 'review-file-counts');
  if (file.binary) {
    counts.append(el('span', 'review-bin', 'bin'));
    return counts;
  }
  counts.append(el('span', 'review-add', `+${file.added}`), el('span', 'review-del', `-${file.removed}`));
  return counts;
}

function destroyShownDiff() {
  const previous = shownDiff;
  shownDiff = null;
  void previous?.mounted.then((mounted) => mounted?.destroy());
}

function chooseLayout(layout: DiffLayout) {
  chosenLayout = layout;
  setJSON(DIFF_LAYOUT_KEY, layout);
  render();
}

function layoutSwitch(shownLayout: DiffLayout) {
  const layoutGroup = el('div', 'review-layout-switch');
  layoutGroup.setAttribute('role', 'group');
  layoutGroup.setAttribute('aria-label', 'Diff layout');
  for (const { layout, label } of DIFF_LAYOUTS) {
    const layoutButton = createPressable('review-layout-option', label);
    layoutButton.setAttribute('aria-pressed', String(layout === shownLayout));
    layoutButton.addEventListener('click', () => chooseLayout(layout));
    layoutGroup.append(layoutButton);
  }
  return layoutGroup;
}

async function loadDiffFileContents(sessionId: string, file: ReaderFile): Promise<DiffFileContents> {
  if (!file.contentHash) throw new Error('Changes has no saved copy of this file to compare');
  const reply = await sendControlRequest('request-diff-file', { id: sessionId, path: file.path, oldBlobId: file.oldBlobId, newBlobId: file.contentHash }, { timeoutMs: 15000 });
  if (reply.type !== 'diff-file') throw new Error('Could not read the file');
  if (!reply.ok) throw new Error(reply.error ?? 'Could not read the file');
  return { oldContents: reply.oldContents, newContents: reply.newContents };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function sendReviewRequest(type: string, payload: Record<string, unknown>): Promise<string | null> {
  try {
    const reply = await sendControlRequest(type, payload, { timeoutMs: 15000 });
    if (reply.type !== 'review-result') return 'The server sent an unexpected reply';
    return reply.ok ? null : reply.error ?? 'The server refused the change';
  } catch (error) {
    return errorText(error);
  }
}

function showDiffNotice(notice: HTMLElement, message: string | null) {
  notice.textContent = message ?? '';
  notice.hidden = message === null;
}

function viewedToggleFor(sessionId: string, file: ReaderFile, notice: HTMLElement) {
  const label = el('label', 'review-viewed');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.addEventListener('change', () => {
    const isViewed = box.checked;
    void sendReviewRequest('review-mark-viewed', { id: sessionId, path: file.path, contentHash: file.contentHash, isViewed }).then((error) => {
      showDiffNotice(notice, error && `Could not mark the file: ${error}`);
      if (error) box.checked = !isViewed;
    });
  });
  label.append(box, 'Viewed');
  return { label, box };
}

function sentTimeOf(comment: ReviewComment) {
  return clock.format(comment.sentAt, 'short-time');
}

function commentThread(sessionId: string, comment: ReviewComment, isOutdated: boolean) {
  const thread = el('div', 'review-thread');
  thread.dataset.status = comment.status;
  const meta = el('p', 'review-thread-meta');
  meta.append(el('span', 'review-thread-sent', `You, sent ${sentTimeOf(comment)} on line ${comment.line}`));
  if (isOutdated) meta.append(el('span', 'review-thread-tag', 'outdated'));
  if (comment.status === 'resolved') meta.append(el('span', 'review-thread-tag', comment.resolvedBy === 'agent' ? 'resolved by the agent' : 'resolved'));
  thread.append(meta, el('p', 'review-thread-text', comment.text));
  for (const reply of comment.replies) {
    const replyRow = el('div', 'review-thread-reply');
    replyRow.append(el('span', 'review-thread-author', 'Agent'), el('p', 'review-thread-text', reply.text));
    thread.append(replyRow);
  }
  if (comment.status === 'resolved') return thread;
  const actions = el('div', 'review-thread-actions');
  const resolveButton = createPressable('review-thread-resolve', 'Resolve');
  const resolveError = el('span', 'review-diff-error');
  resolveButton.addEventListener('click', () => {
    resolveButton.disabled = true;
    void sendReviewRequest('review-resolve-comment', { id: sessionId, commentId: comment.id }).then((error) => {
      resolveButton.disabled = false;
      resolveError.textContent = error ?? '';
    });
  });
  actions.append(resolveButton, resolveError);
  thread.append(actions);
  return thread;
}

function cancelDraft() {
  draftAnchor = null;
  if (draftComposer) draftComposer.error.textContent = '';
  render();
}

function sendDraft(composer: NonNullable<typeof draftComposer>) {
  const anchor = draftAnchor;
  const sessionId = shownSessionId;
  const text = composer.text.value.trim();
  if (!anchor || !sessionId || text === '') return;
  composer.send.disabled = true;
  composer.error.textContent = '';
  void sendReviewRequest('review-send-comment', { id: sessionId, path: anchor.path, side: anchor.side, line: anchor.line, lineText: anchor.lineText, text }).then((error) => {
    composer.send.disabled = false;
    if (error) {
      composer.error.textContent = error;
      return;
    }
    composer.text.value = '';
    if (draftAnchor === anchor) cancelDraft();
  });
}

function composerParts() {
  if (draftComposer) return draftComposer;
  const root = el('div', 'review-composer');
  const label = el('p', 'review-composer-label');
  const text = document.createElement('textarea');
  text.className = 'review-composer-text';
  text.rows = 3;
  text.setAttribute('aria-label', 'Comment for the agent');
  const actions = el('div', 'review-thread-actions');
  const cancel = createPressable('review-composer-cancel', 'Cancel');
  const send = createPressable('review-composer-send', 'Send');
  const error = el('span', 'review-diff-error');
  actions.append(cancel, send, error);
  root.append(label, text, actions);
  const composer = { root, text, label, send, error };
  cancel.addEventListener('click', cancelDraft);
  send.addEventListener('click', () => sendDraft(composer));
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); cancelDraft(); return; }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendDraft(composer); }
  });
  draftComposer = composer;
  return composer;
}

function openDraft(file: ReaderFile, click: DiffLineClick) {
  const isSameAnchor = draftAnchor?.path === file.path && draftAnchor.side === click.side && draftAnchor.line === click.line;
  draftAnchor = { path: file.path, side: click.side, line: click.line, lineText: lineTextAt(file.patch, click.side, click.line) ?? click.renderedText };
  const composer = composerParts();
  composer.label.textContent = `Comment on line ${click.line} for the agent`;
  if (!isSameAnchor) composer.error.textContent = '';
  render();
  requestAnimationFrame(() => composer.text.focus());
}

function annotationsFor(sessionId: string, review: SessionReview, file: ReaderFile): DiffAnnotation[] {
  const latestFile = findReaderFile(review.files, file.path);
  const annotations: DiffAnnotation[] = [];
  const liveKeys = new Set<string>();
  for (const comment of review.reviewState?.comments ?? []) {
    if (comment.path !== file.path) continue;
    const isOutdated = isCommentOutdated(comment, latestFile);
    const key = [comment.id, comment.status, comment.replies.length, isOutdated].join(':');
    liveKeys.add(key);
    if (!annotationElementByKey.has(key)) annotationElementByKey.set(key, commentThread(sessionId, comment, isOutdated));
    annotations.push({ side: comment.side, line: isOutdated ? 0 : comment.line, key });
  }
  for (const key of annotationElementByKey.keys()) if (!liveKeys.has(key)) annotationElementByKey.delete(key);
  if (draftAnchor?.path === file.path) annotations.push({ side: draftAnchor.side, line: draftAnchor.line, key: DRAFT_ANNOTATION_KEY });
  return annotations;
}

function annotationElementOf(key: string) {
  if (key === DRAFT_ANNOTATION_KEY) return composerParts().root;
  return annotationElementByKey.get(key) ?? el('div');
}

function mountDiffBody(body: HTMLElement, notice: HTMLElement, sessionId: string, file: ReaderFile, layout: DiffLayout, annotations: DiffAnnotation[]): Promise<MountedFileDiff | null> {
  return mountFileDiff(body, {
    patch: file.patch,
    layout,
    annotations,
    loadContents: () => loadDiffFileContents(sessionId, file),
    onLoadError: (message) => showDiffNotice(notice, `Could not show the hidden lines: ${message}`),
    renderAnnotation: annotationElementOf,
    onLineClick: (click) => openDraft(file, click),
  }).catch((error: unknown) => {
    body.replaceChildren(el('p', 'review-diff-error', `Could not show this diff: ${errorText(error)}`));
    return null;
  });
}

function showUpdate() {
  displayedFile = null;
  render();
}

function updateNoticeRow() {
  const row = el('div', 'review-update');
  const showButton = createPressable('review-show-update', 'Show update');
  showButton.addEventListener('click', showUpdate);
  row.append(el('span', 'review-update-text', 'The agent changed this file since you opened it.'), showButton);
  row.hidden = true;
  return row;
}

function fileToShow(latestFile: ReaderFile) {
  const heldFile = displayedFile;
  const isHolding = heldFile !== null && shownDiff !== null && heldFile.path === latestFile.path && shouldHoldUpdate(heldFile.patch, latestFile.patch);
  if (isHolding) return { file: heldFile, isHolding };
  displayedFile = latestFile;
  return { file: latestFile, isHolding };
}

function renderDiff(diff: HTMLElement, latestFile: ReaderFile | null, review: SessionReview | null) {
  if (!latestFile || !shownSessionId || !review) {
    destroyShownDiff();
    displayedFile = null;
    diff.replaceChildren();
    delete diff.dataset.path;
    return;
  }
  const sessionId = shownSessionId;
  const { file, isHolding } = fileToShow(latestFile);
  const isWideEnoughForSplit = effectiveDiffLayout('split', diffWidthPx) === 'split';
  const shownLayout = effectiveDiffLayout(chosenLayout, diffWidthPx);
  const key = [sessionId, file.path, file.patch, file.contentHash, chosenLayout, isWideEnoughForSplit].join(String.fromCharCode(0));
  const annotations = annotationsFor(sessionId, review, file);
  if (shownDiff?.key !== key) mountShownDiff(diff, { sessionId, file, key, shownLayout, isWideEnoughForSplit, annotations });
  if (!shownDiff) return;
  shownDiff.updateNotice.hidden = !isHolding;
  shownDiff.viewedToggle.checked = fileReadStateOf(file, viewedHashByPathOf(review)) === 'viewed';
  void shownDiff.mounted.then((mounted) => mounted?.setAnnotations(annotations));
}

function mountShownDiff(diff: HTMLElement, shown: { sessionId: string; file: ReaderFile; key: string; shownLayout: DiffLayout; isWideEnoughForSplit: boolean; annotations: DiffAnnotation[] }) {
  const { sessionId, file, key, shownLayout, isWideEnoughForSplit, annotations } = shown;
  const isSameFile = diff.dataset.path === file.path;
  const scrollTop = isSameFile ? diff.scrollTop : 0;
  destroyShownDiff();
  if (draftAnchor && draftAnchor.path !== file.path) draftAnchor = null;
  diff.replaceChildren();
  diff.dataset.path = file.path;
  const notice = el('p', 'review-diff-error');
  notice.hidden = true;
  const head = el('div', 'review-reader-diff-head');
  head.append(el('span', 'review-file-path', file.path), fileCounts(file));
  if (isWideEnoughForSplit && file.status !== 'A' && file.status !== 'D' && !file.binary) head.append(layoutSwitch(shownLayout));
  const viewed = viewedToggleFor(sessionId, file, notice);
  head.append(viewed.label);
  const updateNotice = updateNoticeRow();
  diff.append(head, updateNotice, notice);
  if (file.binary) {
    diff.append(el('div', 'review-file-binary', 'Binary file not shown'));
    shownDiff = { key, mounted: Promise.resolve(null), viewedToggle: viewed.box, updateNotice };
    return;
  }
  const body = el('div', 'review-diff-body');
  diff.append(body);
  shownDiff = { key, mounted: mountDiffBody(body, notice, sessionId, file, shownLayout, annotations), viewedToggle: viewed.box, updateNotice };
  diff.scrollTop = scrollTop;
}

function showAllWorthALook() {
  isWorthALookShowingAll = true;
  render();
}

function openFileFromWorthALook(openPath: string) {
  const files = shownSessionId ? reviewOf(shownSessionId)?.files ?? [] : [];
  const file = findReaderFile(files, openPath);
  if (file) selectFile(file.path);
}

function place(host: HTMLElement, nextPlacement: SessionPagePlacement) {
  const { root } = readerParts();
  if (root.parentElement !== host) host.append(root);
  placement = nextPlacement;
  root.dataset.placement = nextPlacement;
  root.hidden = false;
}

function unplace() {
  if (!parts) return;
  destroyShownDiff();
  displayedFile = null;
  draftAnchor = null;
  delete parts.diff.dataset.path;
  parts.root.hidden = true;
  parts.root.remove();
  placement = null;
}

function closeReviewFile() {
  if (selectedPath === null) return;
  selectedPath = null;
  render();
  announceLevel();
}

function preloadQuietly() {
  void preloadDiffRenderer().catch(() => {});
}

function watchPageButton(pageButton: HTMLElement, style: ButtonStyle) {
  if (style !== 'header') return;
  pageButton.addEventListener('pointerenter', preloadQuietly);
  pageButton.addEventListener('focus', preloadQuietly);
  watchReviewSurface(pageButton);
  new MutationObserver(syncWatch).observe(pageButton, { attributes: true, attributeFilter: ['data-slot-held'] });
}

onReviewChange((sessionId) => announceSessionPageChange(CHANGES_PAGE_ID, sessionId));

export const changesPage: SessionPage = {
  id: CHANGES_PAGE_ID,
  label: 'Changes',
  iconPath: CHANGES_ICON_PATH,
  isAvailableFor: (sessionId) => reviewOf(sessionId) !== null,
  hasUnreadFor: () => false,
  mount(host, _sessionId, { placement: nextPlacement, target }) {
    place(host, nextPlacement);
    requestedPath = target;
    render();
    if (nextPlacement === 'overlay') readerParts().root.focus({ preventScroll: true });
  },
  unmount: unplace,
  canStepBack: () => placement === 'screen' && selectedPath !== null,
  stepBack: closeReviewFile,
  attachButton: watchPageButton,
};
