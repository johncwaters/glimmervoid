import { repoNameForPath } from '#shared/change-map-view-core.ts';
import { createPressable } from '../ui/pressable.ts';
import { el, isRealInputOwningKey } from '../dom-helpers.ts';
import type { ButtonStyle, SessionPage, SessionPagePlacement } from '../session-pages/session-pages.ts';
import { announceSessionPageChange } from '../session-pages/session-pages.ts';
import { getJSON, setJSON } from '../local-store.ts';
import { sendControlRequest } from '../control-ws.ts';
import { CHANGES_ICON_PATH } from '../svg-dom.ts';
import { renderFileHints, renderWorthALook } from './change-map-view.ts';
import type { DiffFileContents, MountedFileDiff } from './diff-view.ts';
import { mountFileDiff, preloadDiffRenderer } from './diff-view.ts';
import type { DiffLayout, ReaderFile } from './review-reader-core.ts';
import { effectiveDiffLayout, findReaderFile, stepReaderFile } from './review-reader-core.ts';
import type { SessionReview } from './review-store.ts';
import { onReviewChange, refreshReview, reviewOf, syncWatch, watchReviewSurface } from './review-store.ts';
import { getSelectedId, onSelectionChange } from './selection.ts';

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

interface ShownDiff {
  key: string;
  mounted: Promise<MountedFileDiff | null>;
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
  const files = reviewOf(shownSessionId)?.files ?? [];
  const nextPath = stepReaderFile(files, selectedPath, step);
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
  renderDiff(parts.diff, findReaderFile(review.files, selectedPath));
  if (hadOpenFile !== (selectedPath !== null)) announceLevel();
}

function renderNoSession(readerPartsToPaint: ReaderParts) {
  readerPartsToPaint.root.dataset.level = 'list';
  readerPartsToPaint.fileColumn.replaceChildren(el('p', 'review-empty-title', 'No session selected'));
  renderDiff(readerPartsToPaint.diff, null);
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
  if (review.totals.files > 0) fileColumn.append(totalsLine(review.totals));
  appendFileGroup(fileColumn, 'New', review.files.filter((file) => !file.isGenerated), review);
  appendFileGroup(fileColumn, 'Generated', review.files.filter((file) => file.isGenerated), review);
  const worthALook = review.changeMapView
    ? renderWorthALook(review.changeMapView, { isShowingAll: isWorthALookShowingAll, onShowAll: showAllWorthALook, onOpenFile: openFileFromWorthALook })
    : null;
  if (worthALook) fileColumn.append(worthALook);
  fileColumn.scrollTop = scrollTop;
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

function mountDiffBody(body: HTMLElement, loadError: HTMLElement, sessionId: string, file: ReaderFile, layout: DiffLayout): Promise<MountedFileDiff | null> {
  return mountFileDiff(body, {
    patch: file.patch,
    layout,
    loadContents: () => loadDiffFileContents(sessionId, file),
    onLoadError: (message) => {
      loadError.textContent = `Could not show the hidden lines: ${message}`;
      loadError.hidden = false;
    },
  }).catch((error: unknown) => {
    body.replaceChildren(el('p', 'review-diff-error', `Could not show this diff: ${error instanceof Error ? error.message : String(error)}`));
    return null;
  });
}

function renderDiff(diff: HTMLElement, file: ReaderFile | null) {
  if (!file || !shownSessionId) {
    destroyShownDiff();
    diff.replaceChildren();
    delete diff.dataset.path;
    return;
  }
  const isWideEnoughForSplit = effectiveDiffLayout('split', diffWidthPx) === 'split';
  const shownLayout = effectiveDiffLayout(chosenLayout, diffWidthPx);
  const key = [shownSessionId, file.path, file.patch, file.contentHash, chosenLayout, isWideEnoughForSplit].join(String.fromCharCode(0));
  if (shownDiff?.key === key) return;
  const isSameFile = diff.dataset.path === file.path;
  const scrollTop = isSameFile ? diff.scrollTop : 0;
  destroyShownDiff();
  diff.replaceChildren();
  diff.dataset.path = file.path;
  const head = el('div', 'review-reader-diff-head');
  head.append(el('span', 'review-file-path', file.path), fileCounts(file));
  if (isWideEnoughForSplit && file.status !== 'A' && file.status !== 'D' && !file.binary) head.append(layoutSwitch(shownLayout));
  diff.append(head);
  if (file.binary) {
    diff.append(el('div', 'review-file-binary', 'Binary file not shown'));
    return;
  }
  const loadError = el('p', 'review-diff-error');
  loadError.hidden = true;
  const body = el('div', 'review-diff-body');
  diff.append(loadError, body);
  shownDiff = { key, mounted: mountDiffBody(body, loadError, shownSessionId, file, shownLayout) };
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
