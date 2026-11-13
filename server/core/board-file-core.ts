import { BOARD_FILE_FORMAT, BOARD_FILE_VERSION, WHITEBOARD_LIMITS, boardMediaSavedName, sparseElement } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoardFile, BoxMedia, Element, Op } from '../../shared/contracts/whiteboard.ts';

type ExportedBoard = Omit<BoardFile, 'assets' | 'board'> & { board: Pick<Board, 'title' | 'caption' | 'legend'> & { elements: Record<string, unknown> } };

function exportedMediaOf(media: BoxMedia): BoxMedia {
  return { ...media, link: null, source: null };
}

function exportedElementOf(element: Element): Element {
  if (element.kind !== 'box' || !element.media) return element;
  return { ...element, media: exportedMediaOf(element.media) };
}

function exportedBoardOf(board: Board): ExportedBoard {
  const elements = Object.fromEntries([...board.elements.values()].map((element) => [element.id, sparseElement(exportedElementOf(element))]));
  return { format: BOARD_FILE_FORMAT, version: BOARD_FILE_VERSION, board: { title: board.title, caption: board.caption, legend: board.legend, elements } };
}

function exportedAssetsOf(board: Board): Map<string, { media: BoxMedia; name: string }> {
  const exportedByAssetId = new Map<string, { media: BoxMedia; name: string }>();
  for (const box of board.elements.valuesOfKind('box')) {
    if (!box.media || exportedByAssetId.has(box.media.asset)) continue;
    exportedByAssetId.set(box.media.asset, { media: box.media, name: boardMediaSavedName(box.media, box.title) });
  }
  return exportedByAssetId;
}

function importedMediaOf(exported: BoxMedia, adopted: BoxMedia, name: string): BoxMedia {
  return { ...adopted, alt: exported.alt, source: { from: 'upload', name } };
}

const ADD_RANK_BY_KIND: Record<Element['kind'], number> = { box: 0, stroke: 0, frame: 1, wire: 1 };

function elementsInAddOrder(elements: Iterable<Element>): Element[] {
  return [...elements].sort((first, second) => ADD_RANK_BY_KIND[first.kind] - ADD_RANK_BY_KIND[second.kind]);
}

function importOpsOf(file: BoardFile, adoptedByExportedAssetId: ReadonlyMap<string, { media: BoxMedia; name: string }>): Op[] | { error: string } {
  const ops: Op[] = [];
  for (const element of elementsInAddOrder(file.board.elements.values())) {
    if (element.kind !== 'box' || !element.media) {
      ops.push({ op: 'add', element });
      continue;
    }
    const adopted = adoptedByExportedAssetId.get(element.media.asset);
    if (!adopted) return { error: `box ${element.id} shows media ${element.media.asset}, which the board file does not carry` };
    ops.push({ op: 'add', element: { ...element, media: importedMediaOf(element.media, adopted.media, adopted.name) } });
  }
  return ops;
}

function uniqueImportTitle(title: string, existingTitles: ReadonlySet<string>): string {
  if (!existingTitles.has(title)) return title;
  for (let copyNumber = 2; ; copyNumber += 1) {
    const suffix = ` (${copyNumber})`;
    const candidate = `${[...title].slice(0, WHITEBOARD_LIMITS.title - suffix.length).join('').trimEnd()}${suffix}`;
    if (!existingTitles.has(candidate)) return candidate;
  }
}

export { exportedAssetsOf, exportedBoardOf, importOpsOf, uniqueImportTitle };
