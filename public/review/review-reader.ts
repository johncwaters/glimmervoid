import { repoNameForPath } from '#shared/change-map-view-core.ts';
import { createPressable } from '../ui/pressable.ts';
import { button } from '../ui/button.ts';
import { el, isRealInputOwningKey } from '../dom-helpers.ts';
import type { ButtonStyle, SessionPage, SessionPagePlacement } from '../session-pages/session-pages.ts';
import { announceSessionPageChange, closeSessionPage } from '../session-pages/session-pages.ts';
import { CHANGES_ICON_PATH } from '../svg-dom.ts';
import { renderFileHints, renderWorthALook } from './change-map-view.ts';
import type { ReaderFile } from './review-reader-core.ts';
import { findReaderFile, stepReaderFile } from './review-reader-core.ts';
import type { SessionReview } from './review-store.ts';
import { discardSession, mergeSession, onReviewChange, reviewOf, syncWatch, watchReviewSurface } from './review-store.ts';
import { getSelectedId, onSelectionChange } from './selection.ts';

const CHANGES_PAGE_ID = 'changes';

interface ReaderParts {
  root: HTMLElement;
  status: HTMLElement;
  notice: HTMLElement;
  mergeButton: HTMLButtonElement;
  discardButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  fileColumn: HTMLElement;
  diff: HTMLElement;
}

const GUTTER_BY_LINE_TYPE: Record<string, string> = { add: '+', del: '-', meta: '\\' };

let parts: ReaderParts | null = null;
let placement: SessionPagePlacement | null = null;
let shownSessionId: string | null = null;
let selectedPath: string | null = null;
let requestedPath: string | null = null;
let isWorthALookShowingAll = false;

function buildReader(): ReaderParts {
  const root = el('section', 'review-reader');
  root.setAttribute('aria-label', 'Changes');
  root.tabIndex = -1;
  root.hidden = true;
  const bar = el('div', 'review-reader-bar');
  const status = el('p', 'review-reader-status');
  status.setAttribute('role', 'status');
  const notice = el('p', 'review-reader-notice');
  notice.setAttribute('role', 'status');
  const actions = el('div', 'review-reader-actions');
  const mergeButton = button({ variant: 'primary', label: 'Merge', action: 'merge-session', onClick: () => {
    if (shownSessionId) mergeSession(shownSessionId);
  } });
  const discardButton = button({ variant: 'danger', label: 'Discard', action: 'discard-session', onClick: () => {
    if (shownSessionId) discardSession(shownSessionId);
  } });
  const closeButton = button({ variant: 'secondary', label: 'Close', action: 'close-reader', onClick: closeSessionPage });
  actions.append(mergeButton, discardButton, closeButton);
  bar.append(status, notice, actions);
  const body = el('div', 'review-reader-body');
  const fileColumn = el('div', 'review-reader-files');
  const diff = el('div', 'review-reader-diff');
  body.append(fileColumn, diff);
  root.append(bar, body);
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
  return { root, status, notice, mergeButton, discardButton, closeButton, fileColumn, diff };
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
  parts.closeButton.hidden = placement !== 'overlay';
  if (!review) {
    renderNoSession(parts);
    return;
  }
  const hadOpenFile = selectedPath !== null;
  settleSelectedPath(review.files);
  parts.status.textContent = review.sentence;
  const noticeText = review.notice ?? (review.isMergeShown && !review.isMergeEnabled ? review.mergeRefusal : null);
  parts.notice.textContent = noticeText ?? '';
  parts.notice.hidden = noticeText === null;
  parts.mergeButton.hidden = !review.isMergeShown;
  parts.mergeButton.disabled = !review.isMergeEnabled;
  parts.discardButton.hidden = !review.isDiscardShown;
  parts.root.dataset.level = placement === 'screen' && selectedPath !== null ? 'diff' : 'list';
  renderFileColumn(parts.fileColumn, review);
  renderDiff(parts.diff, findReaderFile(review.files, selectedPath));
  if (hadOpenFile !== (selectedPath !== null)) announceLevel();
}

function renderNoSession(readerPartsToPaint: ReaderParts) {
  readerPartsToPaint.status.textContent = 'No session selected';
  readerPartsToPaint.notice.hidden = true;
  readerPartsToPaint.mergeButton.hidden = true;
  readerPartsToPaint.discardButton.hidden = true;
  readerPartsToPaint.root.dataset.level = 'list';
  readerPartsToPaint.fileColumn.replaceChildren();
  readerPartsToPaint.diff.replaceChildren();
}

function renderFileColumn(fileColumn: HTMLElement, review: SessionReview) {
  const scrollTop = fileColumn.scrollTop;
  fileColumn.replaceChildren();
  if (review.diffError) {
    fileColumn.append(el('p', 'review-diff-error', review.diffError));
    return;
  }
  if (review.isEmpty) {
    fileColumn.append(el('p', 'review-empty-title', review.sentence));
    return;
  }
  if (review.totals.files > 0) fileColumn.append(totalsLine(review.totals));
  const list = el('div', 'review-reader-file-list');
  list.setAttribute('role', 'list');
  const repos = review.changeMapView && review.changeMapView.repos.length > 1 ? review.changeMapView.repos : [];
  let previousRepoName: string | null = null;
  for (const file of review.files) {
    const repoName = repos.length > 0 ? repoNameForPath(repos, file.path) : null;
    if (repoName && repoName !== previousRepoName) list.append(el('div', 'review-repo-label', repoName));
    previousRepoName = repoName;
    list.append(fileRow(file, review));
  }
  fileColumn.append(list);
  const worthALook = review.changeMapView
    ? renderWorthALook(review.changeMapView, { isShowingAll: isWorthALookShowingAll, onShowAll: showAllWorthALook, onOpenFile: openFileFromWorthALook })
    : null;
  if (worthALook) fileColumn.append(worthALook);
  fileColumn.scrollTop = scrollTop;
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
  row.append(name, fileCounts(file));
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

function renderDiff(diff: HTMLElement, file: ReaderFile | null) {
  const isSameFile = diff.dataset.path === file?.path;
  const scrollTop = isSameFile ? diff.scrollTop : 0;
  diff.replaceChildren();
  if (!file) {
    delete diff.dataset.path;
    return;
  }
  diff.dataset.path = file.path;
  const head = el('div', 'review-reader-diff-head');
  head.append(el('span', 'review-file-path', file.path), fileCounts(file));
  diff.append(head);
  if (file.binary) {
    diff.append(el('div', 'review-file-binary', 'Binary file not shown'));
    return;
  }
  const body = el('div', 'review-file-body');
  for (const hunk of file.hunks) {
    body.append(el('div', 'review-hunk-head', hunk.header));
    for (const line of hunk.lines) {
      const row = el('div', `review-line review-line-${line.type}`);
      row.append(el('span', 'review-line-gutter', GUTTER_BY_LINE_TYPE[line.type] ?? ' '), el('span', 'review-line-text', line.text));
      body.append(row);
    }
  }
  diff.append(body);
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

function watchPageButton(pageButton: HTMLElement, style: ButtonStyle) {
  if (style !== 'header') return;
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
