import { el } from '../dom-helpers.ts';
import type { ChangeMapView, FileHint, WorthALookLine } from './change-map-core.ts';

const WORTH_A_LOOK_VISIBLE_MAX = 5;

function worthALookRow(line: WorthALookLine, onOpenFile: (openPath: string) => void) {
  const row = el('button', 'review-look-line');
  row.type = 'button';
  row.dataset.kind = line.kind;
  row.title = `${line.detail} Click to open ${line.path} below.`;
  row.append(el('span', 'review-look-file', line.path), el('span', 'review-look-text', line.text));
  row.addEventListener('click', () => onOpenFile(line.openPath));
  return row;
}

export function renderWorthALook(view: ChangeMapView, { isShowingAll, onShowAll, onOpenFile }: {
  isShowingAll: boolean;
  onShowAll: () => void;
  onOpenFile: (openPath: string) => void;
}): HTMLElement | null {
  if (view.worthALook.length === 0 && view.errors.length === 0) return null;
  const section = el('section', 'review-look');
  section.append(el('h3', 'review-group-label', 'Worth a look'));
  if (view.errors.length > 0) {
    const failure = el('p', 'review-look-error', 'Could not check this change for anything worth a look.');
    failure.title = view.errors.join('\n');
    section.append(failure);
  }
  const visibleLines = isShowingAll ? view.worthALook : view.worthALook.slice(0, WORTH_A_LOOK_VISIBLE_MAX);
  if (visibleLines.length > 0) {
    const list = el('div', 'review-look-list');
    for (const line of visibleLines) list.append(worthALookRow(line, onOpenFile));
    section.append(list);
  }
  const hiddenLineCount = view.worthALook.length - visibleLines.length;
  if (hiddenLineCount === 0) return section;
  const more = el('div', 'review-look-more');
  const showAll = el('button', 'review-look-show-all', 'Show all');
  showAll.type = 'button';
  showAll.addEventListener('click', onShowAll);
  more.append(el('span', 'review-look-more-count', `+${hiddenLineCount} more`), showAll);
  section.append(more);
  return section;
}

export function renderFileHints(hints: readonly FileHint[] | undefined): HTMLElement[] {
  return (hints ?? []).map((hint) => {
    const tag = el('span', 'review-file-hint', hint.text);
    tag.title = hint.title;
    return tag;
  });
}
