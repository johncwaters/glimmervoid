import { Element } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoardRecord } from '../../shared/contracts/whiteboard.ts';
import { elementTableOf } from '../../shared/whiteboard-element-table.ts';

const GROUP_PATTERN = ['box', 'box', 'box', 'box', 'box', 'box', 'box', 'box', 'box', 'box', 'box', 'box', 'near-box', 'wire', 'wire', 'wire', 'wire', 'note', 'note', 'frame'] as const;
const BOXES_PER_GROUP = GROUP_PATTERN.filter((kind) => kind === 'box').length;
const GROUP_COLUMNS = 4;
const CELL_WIDTH = 320;
const CELL_HEIGHT = 240;
const WORDS = ['ingest', 'queue', 'parse', 'store', 'index', 'render', 'cache', 'retry', 'merge', 'review', 'deploy', 'notify', 'trace', 'shard', 'replay', 'audit'];

interface GeneratedBoardOptions {
  elementCount: number;
  seed: number;
  boardId: string;
  title: string;
  createdAt: number;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function phraseOf(nextRandom: () => number, wordCount: number): string {
  return Array.from({ length: wordCount }, () => WORDS[Math.floor(nextRandom() * WORDS.length)] ?? 'step').join(' ');
}

function groupOrigin(groupIndex: number, groupsPerRow: number): { x: number; y: number } {
  const groupWidth = GROUP_COLUMNS * CELL_WIDTH;
  const groupHeight = Math.ceil(BOXES_PER_GROUP / GROUP_COLUMNS) * CELL_HEIGHT + CELL_HEIGHT;
  return { x: (groupIndex % groupsPerRow) * groupWidth, y: 600 + Math.floor(groupIndex / groupsPerRow) * groupHeight };
}

function generateElements({ elementCount, seed }: Pick<GeneratedBoardOptions, 'elementCount' | 'seed'>): Board['elements'] {
  const nextRandom = seededRandom(seed);
  const groupCount = Math.ceil(elementCount / GROUP_PATTERN.length);
  const groupsPerRow = Math.max(1, Math.ceil(Math.sqrt(groupCount)));
  const elements = elementTableOf();
  let made = 0;
  for (let groupIndex = 0; groupIndex < groupCount && made < elementCount; groupIndex += 1) {
    const origin = groupOrigin(groupIndex, groupsPerRow);
    const boxIds: string[] = [];
    let boxInGroup = 0;
    let wireInGroup = 0;
    let noteInGroup = 0;
    for (const kind of GROUP_PATTERN) {
      if (made >= elementCount) break;
      const id = `g${groupIndex}-${kind}-${boxInGroup + wireInGroup + noteInGroup}`;
      const candidate = elementOfKind(kind, { id, groupIndex, boxInGroup, wireInGroup, noteInGroup, origin, boxIds, nextRandom });
      if (!candidate) continue;
      elements.put(Element.parse(candidate));
      made += 1;
      if (kind === 'box') { boxIds.push(id); boxInGroup += 1; }
      if (kind === 'wire') wireInGroup += 1;
      if (kind === 'note') noteInGroup += 1;
    }
  }
  return elements;
}

interface ElementContext {
  id: string;
  groupIndex: number;
  boxInGroup: number;
  wireInGroup: number;
  noteInGroup: number;
  origin: { x: number; y: number };
  boxIds: readonly string[];
  nextRandom: () => number;
}

function elementOfKind(kind: (typeof GROUP_PATTERN)[number], context: ElementContext): unknown {
  const { id, groupIndex, boxInGroup, wireInGroup, noteInGroup, origin, boxIds, nextRandom } = context;
  if (kind === 'box') {
    const cellX = boxInGroup % GROUP_COLUMNS;
    const cellY = Math.floor(boxInGroup / GROUP_COLUMNS);
    return {
      kind: 'box', id, title: `${phraseOf(nextRandom, 2)} ${groupIndex}`,
      lines: [{ text: phraseOf(nextRandom, 4) }, { text: phraseOf(nextRandom, 3), style: 'item' }],
      at: { x: origin.x + cellX * CELL_WIDTH, y: origin.y + cellY * CELL_HEIGHT },
    };
  }
  if (kind === 'near-box') {
    const of = boxIds.at(-1);
    if (!of) return null;
    return { kind: 'box', id, title: `near ${phraseOf(nextRandom, 2)}`, near: { of, side: 'bottom' } };
  }
  if (kind === 'wire') {
    const from = boxIds[wireInGroup];
    const to = boxIds[wireInGroup + 1];
    if (!from || !to) return null;
    return { kind: 'wire', id, from, to, label: wireInGroup === 0 ? phraseOf(nextRandom, 1) : null };
  }
  if (kind === 'note') {
    const on = boxIds[noteInGroup * 5];
    if (!on) return null;
    return { kind: 'note', id, on, text: phraseOf(nextRandom, 8) };
  }
  const contains = boxIds.slice(8, 12);
  if (contains.length === 0) return null;
  return { kind: 'frame', id, title: `frame ${groupIndex}`, contains };
}

function generateBoardRecord(options: GeneratedBoardOptions): BoardRecord {
  const board: Board = {
    id: options.boardId,
    title: options.title,
    version: 1,
    caption: null,
    legend: [],
    codeSessionId: null,
    elements: generateElements(options),
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
  };
  return { board, log: [], cursorBySessionId: {}, createdBy: null };
}

function boxIdsOf(board: Board): string[] {
  return [...board.elements.values()].flatMap((element) => (element.kind === 'box' && element.at ? [element.id] : []));
}

export { boxIdsOf, generateBoardRecord, seededRandom };
export type { GeneratedBoardOptions };
