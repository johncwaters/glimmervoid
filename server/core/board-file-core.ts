import { BOARD_FILE_FORMAT, BOARD_FILE_VERSION, WHITEBOARD_LIMITS, boardMediaOriginalFilename, boardMediaSavedName, boxIdsOfWire, sparseElement } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoardFile, BoxMedia, Element, Op } from '../../shared/contracts/whiteboard.ts';
import { isArrayIndexKey } from '../../shared/whiteboard-element-table.ts';

type ExportedBoard = Omit<BoardFile, 'assets' | 'board'> & { board: Pick<Board, 'id' | 'title' | 'caption' | 'legend'> & { elements: Record<string, unknown> } };
type BoardContent = Pick<Board, 'title' | 'caption' | 'legend'> & { elements: readonly Element[] };

function exportedMediaOf(media: BoxMedia): BoxMedia {
  return { ...media, link: null, source: null };
}

function exportedElementOf(element: Element): Element {
  if (element.kind !== 'box' || !element.media) return element;
  return { ...element, media: exportedMediaOf(element.media), feeds: [] };
}

function exportedBoardOf(board: Board): ExportedBoard {
  const elements = Object.fromEntries([...board.elements.values()].map((element) => [element.id, sparseElement(exportedElementOf(element))]));
  return { format: BOARD_FILE_FORMAT, version: BOARD_FILE_VERSION, board: { id: board.id, title: board.title, caption: board.caption, legend: board.legend, elements } };
}

function exportedAssetsOf(board: Board): Map<string, { media: BoxMedia; name: string }> {
  const exportedByFilename = new Map<string, { media: BoxMedia; name: string }>();
  for (const box of board.elements.valuesOfKind('box')) {
    if (!box.media || exportedByFilename.has(boardMediaOriginalFilename(box.media))) continue;
    exportedByFilename.set(boardMediaOriginalFilename(box.media), { media: box.media, name: boardMediaSavedName(box.media, box.title) });
  }
  return exportedByFilename;
}

function importedMediaOf(exported: BoxMedia, adopted: BoxMedia, name: string): BoxMedia {
  return { ...adopted, alt: exported.alt, source: { from: 'upload', name } };
}

const ADD_RANK_BY_KIND: Record<Element['kind'], number> = { box: 0, stroke: 0, frame: 1, wire: 1 };

function elementsInAddOrder(elements: Iterable<Element>): Element[] {
  return [...elements].sort((first, second) => ADD_RANK_BY_KIND[first.kind] - ADD_RANK_BY_KIND[second.kind]);
}

function importedElementsOf(file: BoardFile, adoptedByExportedFilename: ReadonlyMap<string, { media: BoxMedia; name: string }>): Element[] | { error: string } {
  const elements: Element[] = [];
  for (const element of file.board.elements.values()) {
    if (element.kind !== 'box' || !element.media) {
      elements.push(element);
      continue;
    }
    const adopted = adoptedByExportedFilename.get(boardMediaOriginalFilename(element.media));
    if (!adopted) return { error: `box ${element.id} shows media ${element.media.asset}, which the board file does not carry` };
    elements.push({ ...element, media: importedMediaOf(element.media, adopted.media, adopted.name), feeds: [] });
  }
  return elements;
}

function addOpsOf(elements: Iterable<Element>): Op[] {
  return elementsInAddOrder(elements).map((element) => ({ op: 'add', element }));
}

function isSameElement(first: Element, second: Element): boolean {
  return JSON.stringify(sparseElement(first)) === JSON.stringify(sparseElement(second));
}

function referencedIdsOf(element: Element): string[] {
  if (element.kind === 'wire') return boxIdsOfWire(element);
  if (element.kind === 'frame') return element.contains;
  return [];
}

const UNSETTABLE_FIELDS: ReadonlySet<string> = new Set(['id', 'kind']);

function setOpOf(element: Element): Op {
  const fields = Object.fromEntries(Object.entries(element).filter(([field]) => !UNSETTABLE_FIELDS.has(field)));
  return { op: 'set', id: element.id, fields };
}

function withLocalMediaKept(current: Board, element: Element): Element {
  if (element.kind !== 'box' || !element.media) return element;
  const existing = current.elements.get(element.id);
  if (existing?.kind !== 'box' || existing.media?.asset !== element.media.asset) return element;
  return { ...element, media: { ...element.media, source: existing.media.source, link: existing.media.link } };
}

function boardDiffOps(current: Board, target: BoardContent): Op[] {
  const targetElements = target.elements.map((element) => withLocalMediaKept(current, element));
  const targetById = new Map(targetElements.map((element) => [element.id, element]));
  const isKindChanged = (element: Element) => { const existingKind = current.elements.get(element.id)?.kind; return existingKind !== undefined && existingKind !== element.kind; };
  const replacedIds = new Set(targetElements.filter(isKindChanged).map((element) => element.id));
  const removedBoxIds = new Set([...current.elements.valuesOfKind('box')].filter((box) => !targetById.has(box.id) || replacedIds.has(box.id)).map((box) => box.id));
  const isRebuilt = (element: Element) => replacedIds.has(element.id) || ((element.kind === 'wire' || element.kind === 'frame') && referencedIdsOf(element).some((id) => removedBoxIds.has(id)));
  const removedIds: string[] = [];
  const changedOps: Op[] = [];
  for (const element of elementsInAddOrder(targetElements)) {
    const existing = current.elements.get(element.id);
    if (existing === undefined) {
      changedOps.push({ op: 'add', element });
      continue;
    }
    if (isSameElement(existing, element) && !isRebuilt(element)) continue;
    const isSettableInPlace = (existing.kind === 'box' || existing.kind === 'stroke') && !replacedIds.has(element.id);
    if (isSettableInPlace) {
      changedOps.push(setOpOf(element));
      continue;
    }
    removedIds.push(element.id);
    changedOps.push({ op: 'add', element });
  }
  for (const existing of current.elements.values()) {
    if (!targetById.has(existing.id)) removedIds.push(existing.id);
  }
  const isBoxRemoval = (id: string) => current.elements.get(id)?.kind === 'box';
  const removeOps: Op[] = [...removedIds.filter((id) => !isBoxRemoval(id)), ...removedIds.filter(isBoxRemoval)].map((id) => ({ op: 'remove', id }));
  const isHeaderChanged = current.title !== target.title || current.caption !== target.caption || JSON.stringify(current.legend) !== JSON.stringify(target.legend);
  const headerOps: Op[] = isHeaderChanged ? [{ op: 'board', title: target.title, caption: target.caption, legend: target.legend }] : [];
  return [...headerOps, ...removeOps, ...changedOps, ...orderOpsOf(current, targetElements, new Set(removedIds), changedOps)];
}

function orderOpsOf(current: Board, targetElements: readonly Element[], removedIds: ReadonlySet<string>, changedOps: readonly Op[]): Op[] {
  const addedElements = changedOps.flatMap((op) => (op.op === 'add' ? [op.element] : []));
  const kinds = new Set(targetElements.map((element) => element.kind));
  let restackedSpan = 0;
  const orderOps = [...kinds].flatMap((kind): Op[] => {
    const isRestackable = (element: Pick<Element, 'kind' | 'id'>) => element.kind === kind && !isArrayIndexKey(element.id);
    const keptIds = [...current.elements.values()].filter((element) => isRestackable(element) && !removedIds.has(element.id)).map((element) => element.id);
    const stackedIdsAfterDiff = [...keptIds, ...addedElements.filter(isRestackable).map((element) => element.id)];
    const targetIds = targetElements.filter(isRestackable).map((element) => element.id);
    const { start, end } = longestRunAlreadyInOrder(targetIds, stackedIdsAfterDiff);
    const idsToBack = targetIds.slice(0, start);
    const idsToFront = targetIds.slice(end);
    restackedSpan += (idsToBack.length > 0 ? stackedIdsAfterDiff.length : 0) + (idsToFront.length > 0 ? stackedIdsAfterDiff.length : 0);
    return [
      ...(idsToBack.length > 0 ? [{ op: 'order' as const, ids: idsToBack, to: 'back' as const }] : []),
      ...(idsToFront.length > 0 ? [{ op: 'order' as const, ids: idsToFront, to: 'front' as const }] : []),
    ];
  });
  return restackedSpan + changedOps.length + removedIds.size <= WHITEBOARD_LIMITS.opsPerPut ? orderOps : [];
}

function longestRunAlreadyInOrder(targetIds: readonly string[], stackedIds: readonly string[]): { start: number; end: number } {
  const stackPlaceById = new Map(stackedIds.map((id, place) => [id, place]));
  let longest = { start: 0, end: 0 };
  let runStart = 0;
  for (let index = 0; index < targetIds.length; index += 1) {
    const isRising = index > runStart && (stackPlaceById.get(targetIds[index] ?? '') ?? -1) > (stackPlaceById.get(targetIds[index - 1] ?? '') ?? -1);
    if (index > runStart && !isRising) runStart = index;
    if (index + 1 - runStart > longest.end - longest.start) longest = { start: runStart, end: index + 1 };
  }
  return longest;
}

const COPY_NUMBER_SUFFIX_RE = / \((\d+)\)$/;

function nextCopyTitle(title: string, existingTitles: ReadonlySet<string>): string {
  if (!existingTitles.has(title)) return title;
  const baseTitle = title.replace(COPY_NUMBER_SUFFIX_RE, '');
  for (let copyNumber = 2; ; copyNumber += 1) {
    const suffix = ` (${copyNumber})`;
    const candidate = `${[...baseTitle].slice(0, WHITEBOARD_LIMITS.title - suffix.length).join('').trimEnd()}${suffix}`;
    if (!existingTitles.has(candidate)) return candidate;
  }
}

export { addOpsOf, boardDiffOps, exportedAssetsOf, exportedBoardOf, exportedElementOf, importedElementsOf, nextCopyTitle };
export type { BoardContent };
