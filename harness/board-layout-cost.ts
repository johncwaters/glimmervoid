import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import { execFileAsync } from '../server/child-process-safe.ts';
import type { Board } from '../shared/contracts/whiteboard.ts';
import { Element } from '../shared/contracts/whiteboard.ts';
import { layoutBoard, layoutBoardWithMemory } from '../shared/whiteboard-layout-core.ts';
import { emptyFlatRects, flatRectsOf, forEachTouchingPairAcross, setFlatRect } from '../shared/whiteboard-sweep-core.ts';
import { createBoard } from '../shared/whiteboard-ops-core.ts';
import type { BoardLayout } from '../shared/whiteboard-layout-core.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TIMED_RUNS = 3;
const BOX_SHARE = 0.7;
const COLUMN_BOX_EVERY = 10;
const BOX_SPACING_X = 300;
const BOX_SPACING_Y = 200;
const AT_GRID_LEFT = 1000;
const AT_GRID_LEFT_PER_ELEMENT = 1;
const AT_GRID_TOP = 300;
const BOX_INSET = 2;
const EDITED_BOX_COUNT = 8;
const EDIT_OFFSET = { x: 40, y: 30 };

type LayoutBoard = (board: Board) => BoardLayout;

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function benchmarkBoard(elementCount: number): Board {
  const nextRandom = seededRandom(7);
  const boxCount = Math.round(elementCount * BOX_SHARE);
  const boxesPerRow = Math.ceil(Math.sqrt(boxCount));
  const atGridLeft = AT_GRID_LEFT + elementCount * AT_GRID_LEFT_PER_ELEMENT;
  const elements: Board['elements'] = {};
  for (let boxIndex = 0; boxIndex < boxCount; boxIndex += 1) {
    const isInColumn = boxIndex % COLUMN_BOX_EVERY === 0;
    const place = isInColumn
      ? { column: boxIndex % (COLUMN_BOX_EVERY * 2) === 0 ? 'one' : 'two', order: boxIndex }
      : { at: { x: atGridLeft + (boxIndex % boxesPerRow) * BOX_SPACING_X, y: AT_GRID_TOP + Math.floor(boxIndex / boxesPerRow) * BOX_SPACING_Y } };
    elements[`b${boxIndex}`] = Element.parse({ kind: 'box', id: `b${boxIndex}`, title: `box ${boxIndex}`, lines: [{ text: 'a line' }], ...place });
  }
  for (let wireIndex = 0; wireIndex < elementCount - boxCount; wireIndex += 1) {
    const fromIndex = Math.floor(nextRandom() * boxCount);
    const toIndex = Math.min(boxCount - 1, fromIndex + 1 + Math.floor(nextRandom() * 3));
    elements[`w${wireIndex}`] = Element.parse({ kind: 'wire', id: `w${wireIndex}`, from: `b${fromIndex}`, to: `b${toIndex}` });
  }
  const board = createBoard({ id: '00000000-0000-4000-8000-000000000000', title: 'layout cost', nowMs: 0 });
  return { ...board, columns: [{ id: 'one', title: 'one' }, { id: 'two', title: 'two' }], elements };
}

function bestLayoutMs(layout: LayoutBoard, board: Board): { layoutMs: number; boardLayout: BoardLayout } {
  let layoutMs = Infinity;
  let boardLayout = layout(board);
  for (let run = 0; run < TIMED_RUNS; run += 1) {
    const startedAt = performance.now();
    boardLayout = layout(board);
    layoutMs = Math.min(layoutMs, performance.now() - startedAt);
  }
  return { layoutMs: Math.round(layoutMs), boardLayout };
}

function movedBoxesBoard(board: Board): Board {
  const nextRandom = seededRandom(11);
  const placedBoxes = Object.values(board.elements).flatMap((element) => (element.kind === 'box' && element.at ? [element] : []));
  const elements = { ...board.elements };
  for (let moved = 0; moved < EDITED_BOX_COUNT; moved += 1) {
    const box = placedBoxes[Math.floor(nextRandom() * placedBoxes.length)];
    if (!box?.at) continue;
    elements[box.id] = { ...box, at: { x: box.at.x + EDIT_OFFSET.x, y: box.at.y + EDIT_OFFSET.y } };
  }
  return { ...board, elements };
}

function bestEditMs(board: Board): { layoutMs: number; boardLayout: BoardLayout } {
  const { memory } = layoutBoardWithMemory(board, null);
  const editedBoard = movedBoxesBoard(board);
  return bestLayoutMs((edited) => layoutBoardWithMemory(edited, memory).layout, editedBoard);
}

function wiresThroughBoxesOf(board: Board, boardLayout: BoardLayout): number {
  const boxes = boardLayout.elements.flatMap((element) => (element.kind === 'box' ? [element] : []));
  const endsByWireId = new Map(Object.values(board.elements).flatMap((element) => (element.kind === 'wire' ? [[element.id, [element.from, element.to]] as const] : [])));
  const pieces: { wireId: string; isHorizontal: boolean; line: number; from: number; to: number }[] = [];
  for (const element of boardLayout.elements) {
    if (element.kind !== 'wire') continue;
    const points = [...element.path.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
    points.slice(1).forEach((point, index) => {
      const previous = points[index];
      if (!previous) return;
      const isHorizontal = previous.y === point.y;
      pieces.push({ wireId: element.id, isHorizontal, line: isHorizontal ? point.y : point.x, from: isHorizontal ? previous.x : previous.y, to: isHorizontal ? point.x : point.y });
    });
  }
  const pieceRects = emptyFlatRects(pieces.length);
  pieces.forEach((piece, index) => {
    if (piece.isHorizontal) setFlatRect(pieceRects, index, piece.from, piece.line, piece.to, piece.line);
    if (!piece.isHorizontal) setFlatRect(pieceRects, index, piece.line, piece.from, piece.line, piece.to);
  });
  const insets = boxes.map((box) => ({ x: box.x + BOX_INSET, y: box.y + BOX_INSET, width: box.width - BOX_INSET * 2, height: box.height - BOX_INSET * 2 }));
  const throughWireIds = new Set<string>();
  forEachTouchingPairAcross(pieceRects, flatRectsOf(insets), (pieceIndex, boxIndex) => {
    const piece = pieces[pieceIndex];
    const box = boxes[boxIndex];
    const inset = insets[boxIndex];
    if (!piece || !box || !inset || endsByWireId.get(piece.wireId)?.includes(box.id)) return;
    const [acrossLow, acrossHigh, alongLow, alongHigh] = piece.isHorizontal ? [inset.y, inset.y + inset.height, inset.x, inset.x + inset.width] : [inset.x, inset.x + inset.width, inset.y, inset.y + inset.height];
    const isInside = acrossLow < piece.line && piece.line < acrossHigh && Math.min(piece.from, piece.to) < alongHigh && Math.max(piece.from, piece.to) > alongLow;
    if (isInside) throughWireIds.add(piece.wireId);
  });
  return throughWireIds.size;
}

async function layoutAtRef(ref: string, scratchDirectory: string): Promise<LayoutBoard> {
  const archivePath = path.join(scratchDirectory, 'shared.tar');
  await execFileAsync('git', ['-C', REPO_ROOT, 'archive', '--output', archivePath, ref, 'shared'], { maxBuffer: 64 * 1024 * 1024 });
  await execFileAsync('tar', ['-x', '-f', archivePath, '-C', scratchDirectory]);
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(scratchDirectory, 'node_modules'), 'junction');
  const module: { layoutBoard: LayoutBoard } = await import(pathToFileURL(path.join(scratchDirectory, 'shared', 'whiteboard-layout-core.ts')).href);
  return module.layoutBoard;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      sizes: { type: 'string', default: '5000,10000,20000' },
      'compare-ref': { type: 'string' },
      'same-warnings': { type: 'boolean', default: false },
      'budget-ms': { type: 'string' },
      'expect-routed': { type: 'boolean', default: false },
      edit: { type: 'boolean', default: false },
    },
  });
  const sizes = values.sizes.split(',').map(Number);
  const budgetMs = values['budget-ms'] === undefined ? null : Number(values['budget-ms']);
  const compareRef = values['compare-ref'] ?? null;
  const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-layout-cost-'));
  let failureCount = 0;
  try {
    const referenceLayout = compareRef ? await layoutAtRef(compareRef, scratchDirectory) : null;
    for (const size of sizes) {
      const coldBoard = benchmarkBoard(size);
      const board = values.edit ? movedBoxesBoard(coldBoard) : coldBoard;
      const current = values.edit ? bestEditMs(coldBoard) : bestLayoutMs(layoutBoard, board);
      const reference = referenceLayout ? bestLayoutMs(referenceLayout, board) : null;
      const isOverBudget = budgetMs !== null && current.layoutMs > budgetMs;
      const hasSameWarnings = reference ? JSON.stringify(reference.boardLayout.warnings) === JSON.stringify(current.boardLayout.warnings) : null;
      const hasSameLayout = reference ? JSON.stringify(reference.boardLayout) === JSON.stringify(current.boardLayout) : null;
      const failsWarnings = values['same-warnings'] && hasSameWarnings === false;
      const wiresThroughBoxes = values['expect-routed'] ? wiresThroughBoxesOf(board, current.boardLayout) : null;
      const unroutedWarnings = current.boardLayout.warnings.filter((warning) => warning.includes('found no clear route')).length;
      const failsRouting = wiresThroughBoxes !== null && (wiresThroughBoxes > 0 || unroutedWarnings > 0);
      if (isOverBudget || failsWarnings || failsRouting) failureCount += 1;
      console.log(JSON.stringify({ size, layoutMs: current.layoutMs, referenceLayoutMs: reference?.layoutMs ?? null, budgetMs, isOverBudget, hasSameWarnings, hasSameLayout, wiresThroughBoxes, warnings: current.boardLayout.warnings.length }));
    }
  } finally {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
  return failureCount === 0 ? 0 : 1;
}

process.exitCode = await main();
