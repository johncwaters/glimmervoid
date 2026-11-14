import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Board, Element, ElementInput, Op, dialValuesOfBox, pointOfBox } from '../shared/contracts/whiteboard.ts';
import { reviewBoard } from '../shared/whiteboard-anchor-core.ts';
import { isRecord } from '../shared/coerce.ts';
import { upgradedBoardRecord } from '../server/core/whiteboard-store-core.ts';
import { layoutBoard, pinnedOffsetYAfterLeaving, pinnedOffsetYOf, placeBoardWithMemory } from '../shared/whiteboard-layout-core.ts';
import { boardSvgDocument } from '../shared/whiteboard-svg-core.ts';
import { elbowCornersAfterShift, rotatedAbout, wireHandlesOf } from '../shared/whiteboard-route-core.ts';
import { applyBoardDiff, applyOps, stageOps } from '../shared/whiteboard-ops-core.ts';
import { applyLayoutDelta, createLayoutWorld, layoutOf, resumeLayoutWorld, savedWorldOf, warningsOfWorld } from '../shared/whiteboard-layout-engine.ts';
import type { LayoutWorld } from '../shared/whiteboard-layout-engine.ts';
import { PlacedElement as PlacedElementShape, RememberedRoute } from '../shared/contracts/whiteboard-tiles.ts';
import { patchTileIndex, tileIndexOf, tileKeysFor, tileOf } from '../shared/whiteboard-tile-core.ts';
import { generateBoardRecord } from '../harness/load-cost/whiteboard-board-generator.ts';
import { EMPTY_HISTORY, UNDO_LIMIT, recordEdit, takeStep, undoOpsOf } from '../shared/whiteboard-undo-core.ts';
import type { LaidOutElement, PlacedElement, Rect } from '../shared/whiteboard-layout-core.ts';

function box(id: string) {
  return { kind: 'box', id, title: `step ${id} with a longer title`, lines: [{ text: 'a body line long enough to wrap twice over' }] };
}

function boardWithNearPinned(storedBoard: Record<string, unknown>): Board {
  const upgraded = upgradedBoardRecord({ board: storedBoard });
  return Board.parse(isRecord(upgraded) ? upgraded.board : upgraded);
}

type UnplacedBox = { id: string; width?: number } & Record<string, unknown>;

function stacked(stacks: UnplacedBox[][], spacing: { stackGap: number; boxGap: number } = { stackGap: 90, boxGap: 30 }): Record<string, unknown> {
  const elements: Record<string, unknown> = {};
  let stackLeft = 40;
  for (const stack of stacks) {
    stack.forEach((unplaced, index) => {
      const boxAbove = stack[index - 1];
      elements[unplaced.id] = { ...unplaced, ...(boxAbove ? { near: { of: boxAbove.id, side: 'bottom', gap: spacing.boxGap } } : { at: { x: stackLeft, y: 40 } }) };
    });
    stackLeft += Math.max(220, ...stack.map((unplaced) => unplaced.width ?? 220)) + spacing.stackGap;
  }
  return elements;
}

const crowdedBoard = boardWithNearPinned({
  id: 'crowded', title: 'crowded', version: 1, caption: null, createdAt: 0, updatedAt: 0,
  elements: {
    ...stacked([[box('a1'), box('a2')], [box('b1'), box('b2')], [box('c1'), box('c2'), box('c3')]], { stackGap: 200, boxGap: 160 }),
    f1: { kind: 'frame', id: 'f1', title: 'intake', contains: ['c2', 'c3'] },
    f2: { kind: 'frame', id: 'f2', title: 'triggers', contains: ['a1'] },
  },
});

function overlaps(first: Rect, second: Rect): boolean {
  return first.x < second.x + second.width && second.x < first.x + first.width && first.y < second.y + second.height && second.y < first.y + first.height;
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function isAllowedToTouch(first: LaidOutElement, second: LaidOutElement): boolean {
  if (first.kind === 'frame' && second.kind !== 'wire') return contains(first, second);
  if (second.kind === 'frame' && first.kind !== 'wire') return contains(second, first);
  return false;
}

test('frames wrap their boxes without drawing over boxes they do not belong to', () => {
  const layout = layoutBoard(crowdedBoard);
  const placed = layout.elements.filter((element) => element.kind !== 'wire');
  for (const [index, first] of placed.entries()) {
    for (const second of placed.slice(index + 1)) {
      if (!overlaps(first, second)) continue;
      assert.ok(isAllowedToTouch(first, second), `${first.id} overlaps ${second.id}`);
    }
  }
});

function wire(id: string, from: string, to: string, extra: Record<string, unknown> = {}) {
  return { kind: 'wire', id, from, to, ...extra };
}

const wiredBoard = boardWithNearPinned({
  ...crowdedBoard,
  elements: {
    ...crowdedBoard.elements.toJSON(),
    w1: wire('w1', 'a1', 'b2'), w2: wire('w2', 'a2', 'b2'), w3: wire('w3', 'b1', 'b2', { dashed: true }),
    w4: wire('w4', 'a1', 'c3', { label: 'skips the adapters' }), w5: wire('w5', 'c2', 'a2', { tone: 'fail', label: 'refused' }),
    w6: wire('w6', 'c1', 'c3'), w7: wire('w7', 'b2', 'c1', { label: 'yes' }),
  },
});

function segmentsOfPath(path: string): { x1: number; y1: number; x2: number; y2: number }[] {
  const segments: { x1: number; y1: number; x2: number; y2: number }[] = [];
  let previous: { x: number; y: number } | null = null;
  for (const [, command, x, y] of path.matchAll(/([ML]) (-?[\d.]+) (-?[\d.]+)/g)) {
    const point = { x: Number(x), y: Number(y) };
    if (command === 'L' && previous) segments.push({ x1: previous.x, y1: previous.y, x2: point.x, y2: point.y });
    previous = point;
  }
  return segments;
}

test('wires run at right angles around boxes, and same-style wires into one box side share one arrowhead', () => {
  const layout = layoutBoard(wiredBoard);
  const wires = layout.elements.flatMap((element) => (element.kind === 'wire' ? [element] : []));
  const boxes = layout.elements.flatMap((element) => (element.kind === 'box' ? [element] : []));
  assert.equal(wires.length, 7);
  for (const laidOut of wires) {
    const stored = wiredBoard.elements.get(laidOut.id);
    assert.ok(stored?.kind === 'wire');
    for (const segment of segmentsOfPath(laidOut.path)) {
      assert.ok(segment.x1 === segment.x2 || segment.y1 === segment.y2, `${laidOut.id} has a slanted segment`);
      for (const box of boxes) {
        if (box.id === stored.from || box.id === stored.to) continue;
        const isInside = Math.max(segment.x1, segment.x2) > box.x + 2 && Math.min(segment.x1, segment.x2) < box.x + box.width - 2
          && Math.max(segment.y1, segment.y2) > box.y + 2 && Math.min(segment.y1, segment.y2) < box.y + box.height - 2;
        assert.ok(!isInside, `${laidOut.id} runs through ${box.id}`);
      }
    }
  }
  const arrowheadIds = wires.filter((laidOut) => laidOut.hasArrowhead).map((laidOut) => laidOut.id);
  assert.ok(arrowheadIds.filter((id) => id === 'w1' || id === 'w2').length === 1, 'the solid wires into b2 share one arrowhead');
  assert.ok(arrowheadIds.includes('w3') && arrowheadIds.includes('w5'), 'a wire of another style keeps its own arrowhead');
  assert.deepEqual(layout.warnings.filter((warning) => warning.includes('runs through')), []);
});

function pointsOfLaidOutPath(path: string): { x: number; y: number }[] {
  const numbers = path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  return Array.from({ length: Math.floor(numbers.length / 2) }, (_, index) => ({ x: numbers[index * 2] ?? 0, y: numbers[index * 2 + 1] ?? 0 }));
}

function stepBox(id: string, title: string) {
  return { kind: 'box', id, title, step: {} };
}

function dependency(fromId: string, toId: string) {
  return { kind: 'wire', id: `${fromId}-to-${toId}`, from: fromId, to: toId };
}

test('unplaced step boxes draw as a plan band above the free drawing, one level per column, and a dragged step leaves the band where it was dropped', () => {
  const plannedBoard = boardWithNearPinned({
    ...wiredBoard,
    elements: {
      ...wiredBoard.elements.toJSON(),
      diff: stepBox('diff', 'Diff index'), endpoint: stepBox('endpoint', 'Search endpoint'),
      backfill: stepBox('backfill', 'Index backfill'), searchbox: stepBox('searchbox', 'Search box'),
      ...Object.fromEntries([dependency('diff', 'endpoint'), dependency('diff', 'backfill'), dependency('endpoint', 'searchbox'), dependency('diff', 'searchbox')].map((wire) => [wire.id, wire])),
      pinned: { ...box('pinned'), at: { x: 40, y: 900 } },
    },
  });
  const layout = layoutBoard(plannedBoard);
  const steps = layout.elements.flatMap((element) => (element.kind === 'box' && element.step ? [element] : []));
  const stepById = new Map(steps.map((laidOut) => [laidOut.id, laidOut]));
  assert.deepEqual(steps.map((laidOut) => laidOut.step?.label).sort(), ['1', '2a', '2b', '3']);
  const [diff, endpoint, backfill, searchbox] = ['diff', 'endpoint', 'backfill', 'searchbox'].map((id) => stepById.get(id));
  assert.ok(diff && endpoint && backfill && searchbox);
  assert.ok(diff.x < endpoint.x && endpoint.x === backfill.x && endpoint.x < searchbox.x, 'each level is its own column, left to right');
  const bandBottom = Math.max(...steps.map((laidOut) => laidOut.y + laidOut.height));
  for (const laidOut of layout.elements) {
    if (laidOut.kind === 'box' && !laidOut.step) assert.ok(laidOut.y > bandBottom, `box ${laidOut.id} starts inside the plan band`);
  }
  const placed = layout.elements.filter((element) => element.kind !== 'wire');
  for (const laidOut of steps) {
    for (const other of placed) {
      if (other.id !== laidOut.id) assert.ok(!overlaps(laidOut, other), `${laidOut.id} overlaps ${other.id}`);
    }
  }
  assert.equal(layoutBoard(wiredBoard).plan, null);

  const droppedAt = { x: 900, y: 700 };
  const draggedBoard = boardWithNearPinned({ ...plannedBoard, elements: { ...plannedBoard.elements.toJSON(), searchbox: { ...stepBox('searchbox', 'Search box'), at: droppedAt } } });
  const dragged = layoutBoard(draggedBoard).elements.find((element) => element.id === 'searchbox');
  assert.deepEqual(dragged?.kind === 'box' ? { x: dragged.x, y: dragged.y, label: dragged.step?.label } : null, { x: droppedAt.x, y: droppedAt.y + pinnedOffsetYOf(draggedBoard), label: '3' });
  for (const leaving of [[searchbox], [endpoint], [endpoint, backfill], [diff, endpoint, backfill, searchbox]]) {
    const leavingIds = new Set(leaving.map((laidOut) => laidOut.id));
    const leftBoard = boardWithNearPinned({ ...plannedBoard, elements: Object.fromEntries([...plannedBoard.elements.entries()].map(([id, element]) => [id, leavingIds.has(id) && element.kind === 'box' ? { ...element, place: { at: droppedAt } } : element])) });
    assert.equal(pinnedOffsetYAfterLeaving(layout.plan, leaving), pinnedOffsetYOf(leftBoard), `the band left by ${[...leavingIds].join(', ')} matches a whole-board layout`);
  }
});

test('a step status that disagrees with the code session changes warns, changed files no ref covers come back as uncovered, and an unread code session says it was not checked', () => {
  const reviewedBoard = boardWithNearPinned({
    id: 'reviewed', title: 'reviewed', version: 1, caption: null, createdAt: 0, updatedAt: 0, codeSessionId: 'builder',
    elements: {
      early: { kind: 'box', id: 'early', title: 'Started too soon', step: { status: 'planned' }, refs: ['src/parse.ts#L4'] },
      shipped: { kind: 'box', id: 'shipped', title: 'Shipped', step: { status: 'landed' }, refs: ['./src/save.ts', 'src//index.ts'] },
      quiet: { kind: 'box', id: 'quiet', title: 'Not started', step: { status: 'landed' }, refs: ['src/later.ts'] },
      parse: { kind: 'box', id: 'parse', title: 'Parse', at: { x: 40, y: 40 }, refs: ['src/parse.ts'] },
    },
  });
  const fileFactByPath = new Map(['src/parse.ts', 'src/save.ts', 'src/index.ts', 'src/later.ts'].map((filePath) => [filePath, { lineCount: 10 }]));
  const changes = {
    changedPaths: [
      { path: 'src/parse.ts', isCommitted: false },
      { path: 'src/save.ts', isCommitted: true },
      { path: 'src/index.ts', isCommitted: false },
      { path: 'src/stray.ts', isCommitted: true },
    ],
    worthALook: [{ path: 'src/parse.ts', reason: 'Also being changed in "planner"' }, { path: 'src/stray.ts', reason: 'Usually changes with src/save.ts, which is not in this change' }],
    error: null,
  };

  assert.deepEqual(reviewBoard(reviewedBoard, { fileFactByPath, changes }), {
    codeSessionId: 'builder',
    anchorWarnings: [],
    stepWarnings: [
      'step early is planned but src/parse.ts already changed',
      'step shipped is landed but src/index.ts has uncommitted changes',
      'step quiet is landed but src/later.ts is unchanged',
    ],
    uncoveredPaths: ['src/stray.ts'],
    worthALook: [{ path: 'src/parse.ts', reason: 'Also being changed in "planner"' }],
    flaggedStepIds: ['early', 'shipped', 'quiet'],
    notChecked: null,
    linkStates: [],
  });
  assert.equal(reviewBoard(reviewedBoard, { fileFactByPath, changes: { ...changes, error: 'git diff failed' } }).notChecked, 'the code session changes could not be read: git diff failed');
  assert.equal(reviewBoard(reviewedBoard, null).notChecked, 'code session builder is not running');

  const manyStrayChanges = { ...changes, changedPaths: Array.from({ length: 25 }, (_, index) => ({ path: `src/stray-${index}.ts`, isCommitted: true })) };
  const { uncoveredPaths } = reviewBoard(reviewedBoard, { fileFactByPath, changes: manyStrayChanges });
  assert.equal(uncoveredPaths.length, 20);
  assert.ok(uncoveredPaths.every((uncoveredPath) => uncoveredPath.startsWith('src/stray-')), uncoveredPaths.join(', '));
});

test('a stored near box is pinned beside its target and one whose target is missing is pinned at the board margin', () => {
  const nearBoard = boardWithNearPinned({
    id: 'near', title: 'near', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      ...stacked([[box('plain'), box('parse')], [box('apply'), box('stop')]]),
      aside: { kind: 'box', id: 'aside', title: 'Prior art', near: { of: 'stop', side: 'right' } },
      stray: { kind: 'box', id: 'stray', title: 'Stray', near: { of: 'gone', side: 'left' } },
      w1: wire('w1', 'parse', 'stop'),
    },
  });
  const layout = layoutBoard(nearBoard);
  const boxById = new Map(layout.elements.flatMap((element) => (element.kind === 'box' ? [[element.id, element] as const] : [])));
  const plain = boxById.get('plain');
  const parse = boxById.get('parse');
  const stop = boxById.get('stop');
  const aside = boxById.get('aside');
  assert.ok(plain && parse && stop && aside);
  assert.equal(parse.y, plain.y + plain.height + 30);
  assert.equal(aside.x, stop.x + stop.width + 60);
  assert.equal(aside.y + aside.height / 2, stop.y + stop.height / 2);
  const stray = nearBoard.elements.get('stray');
  assert.deepEqual(stray?.kind === 'box' ? pointOfBox(stray) : null, { x: 40, y: 40 });
  assert.deepEqual(layout.warnings.filter((warning) => warning.includes('runs through')), []);

  const removed = applyOps(nearBoard, [{ op: 'remove', id: 'stop' }], { id: 'operator', name: 'operator' }, 0);
  assert.ok(removed.ok);
  const afterRemove = layoutBoard(removed.board);
  assert.deepEqual(afterRemove.elements.filter((element) => element.id === 'stop' || element.id === 'w1'), [], 'a layout after a put that removed a box with near boxes no longer draws the removed box or its wires');

  const addedThenRemoved = applyOps(nearBoard, [
    { op: 'add', element: ElementInput.parse({ kind: 'box', id: 'temp', title: 'Temp', place: { at: { x: 600, y: 300 } } }) },
    { op: 'add', element: ElementInput.parse({ kind: 'box', id: 'kid', title: 'Kid', place: { near: { of: 'temp', side: 'right' } } }) },
    { op: 'remove', id: 'temp' },
  ], { id: 'operator', name: 'operator' }, 0);
  assert.ok(addedThenRemoved.ok);
  const kid = addedThenRemoved.board.elements.get('kid');
  assert.ok(kid?.kind === 'box' && pointOfBox(kid) !== null, 'a box placed near a box the same put adds and removes keeps a place on the board');

  const farFlung = boardWithNearPinned({ ...nearBoard, elements: { ...nearBoard.elements.toJSON(), far: { kind: 'box', id: 'far', title: 'Far', at: { x: 1e9, y: 1e9 } }, w2: wire('w2', 'plain', 'far') } });
  assert.ok(layoutBoard(farFlung).elements.some((element) => element.id === 'w2'), 'a wire to a box a billion units away lays out without walking every cell between');
});

test('wires keep their named sides, and overlaps and crowding warn by name', () => {
  const loopBoard = boardWithNearPinned({
    id: 'loop', title: 'loop', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      ...stacked([[box('read')], [box('check')], [box('write')]]),
      aside: { kind: 'box', id: 'aside', title: 'Aside', near: { of: 'write', side: 'bottom' } },
      first: { kind: 'box', id: 'first', title: 'First', at: { x: 900, y: 600 } }, second: { kind: 'box', id: 'second', title: 'Second', at: { x: 920, y: 610 } },
      f1: { kind: 'frame', id: 'f1', title: 'each page', contains: ['read', 'check', 'write'] },
      w1: wire('w1', 'read', 'check'), w2: wire('w2', 'check', 'write'),
      w3: wire('w3', 'write', 'read', { label: 'next page' }),
      w4: wire('w4', 'read', 'check', { fromSide: 'bottom', toSide: 'bottom' }),
      w5: wire('w5', 'read', 'aside'),
      low: { kind: 'box', id: 'low', title: 'Low', at: { x: 1300, y: 900 } }, w6: wire('w6', 'write', 'low'),
      tall: { kind: 'box', id: 'tall', title: 'Tall', lines: [{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'four' }], at: { x: 1800, y: 1300 } },
      short: { kind: 'box', id: 'short', title: 'Short', at: { x: 2200, y: 1340 } }, w7: wire('w7', 'tall', 'short'),
      walled: { kind: 'box', id: 'walled', title: 'Walled', at: { x: 1800, y: 2000 } },
      wall: { kind: 'box', id: 'wall', title: 'Wall', lines: [{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'four' }, { text: 'five' }, { text: 'six' }], at: { x: 2040, y: 1900 } },
      over: { kind: 'box', id: 'over', title: 'Over', at: { x: 2300, y: 1600 } }, w8: { ...wire('w8', 'walled', 'over'), toSide: 'bottom' },
    },
  });
  const layout = layoutBoard(loopBoard);
  const boxById = new Map(layout.elements.flatMap((element) => (element.kind === 'box' ? [[element.id, element] as const] : [])));
  const wireById = new Map(layout.elements.flatMap((element) => (element.kind === 'wire' ? [[element.id, element] as const] : [])));
  const [read, check, write] = ['read', 'check', 'write'].map((id) => boxById.get(id));
  const sided = wireById.get('w4');
  const low = boxById.get('low');
  const downward = wireById.get('w6');
  assert.ok(read && check && write && sided && low && downward);
  assert.deepEqual([downward.end.y, segmentsOfPath(downward.path).length], [low.y, 2], `a wire to a box wholly below it turns once into its top: ${downward.path}`);
  const level = wireById.get('w7');
  assert.ok(level);
  assert.equal(segmentsOfPath(level.path).length, 1, `a wire between boxes that share a height runs straight: ${level.path}`);
  const walled = wireById.get('w8');
  assert.ok(walled);
  assert.ok(segmentsOfPath(walled.path).length <= 3, `a wire whose facing side is walled off leaves from the side that turns least: ${walled.path}`);
  assert.equal(sided.start.y, read.y + read.height);
  assert.equal(sided.end.y, check.y + check.height);
  assert.deepEqual(layout.warnings.filter((warning) => warning.includes('runs through')), []);
  assert.ok(layout.warnings.includes('box first overlaps box second'), layout.warnings.join('; '));
});

test('a dense board routes every wire around the boxes instead of drawing dog-legs', () => {
  const stacks: UnplacedBox[][] = Array.from({ length: 12 }, () => []);
  for (let index = 0; index < 170; index += 1) stacks[index % 12]?.push({ kind: 'box', id: `b${index}`, title: `box ${index}`, lines: [] });
  const elements = stacked(stacks, { stackGap: 160, boxGap: 30 });
  for (let index = 0; index < 600; index += 1) elements[`w${index}`] = { kind: 'wire', id: `w${index}`, from: `b${(index * 7) % 170}`, to: `b${(index * 13 + 5) % 170}` };
  const layout = layoutBoard(boardWithNearPinned({ id: 'dense', title: 'dense', version: 1, caption: null, createdAt: 0, updatedAt: 0, elements }));
  assert.deepEqual(layout.warnings.filter((warning) => warning.includes('found no clear route') || warning.includes('runs through')), [], layout.warnings.join('\n'));
  assert.equal(layout.elements.filter((element) => element.kind === 'wire').length, 600);
});

test('a wire past a box placed above the content top goes around that box, not through it, and reaches a box pinned higher still', () => {
  const placedBox = (id: string, x: number, y = 40) => ({ kind: 'box', id, title: id, lines: [{ text: 'one' }, { text: 'two' }, { text: 'three' }], at: { x, y } });
  const elements = {
    a: placedBox('a', 0), b: placedBox('b', 300), c: placedBox('c', 600), high: placedBox('high', 200, -370),
    w: { kind: 'wire', id: 'w', from: 'a', to: 'c', fromSide: 'right', toSide: 'left' },
    up: { kind: 'wire', id: 'up', from: 'c', to: 'high', fromSide: 'top', toSide: 'right', label: 'compiles' },
    down: { kind: 'wire', id: 'down', from: 'high', to: 'a', fromSide: 'left', toSide: 'top', label: 'pushes' },
  };
  const layout = layoutBoard(boardWithNearPinned({ id: 'top', title: 'top', version: 1, caption: null, createdAt: 0, updatedAt: 0, elements }));
  assert.deepEqual(layout.warnings.filter((warning) => warning.includes('runs through') || warning.includes('found no clear route') || warning.includes('no clear spot')), [], layout.warnings.join('\n'));
});

test('two wires whose end ports line up across a corridor are drawn apart rather than over each other', () => {
  const placedBox = (id: string, x: number, y: number) => ({ kind: 'box', id, title: id, at: { x, y } });
  const elements = {
    a: placedBox('a', 0, 0), b: placedBox('b', 0, 300), top: placedBox('top', 300, 0), bottom: placedBox('bottom', 300, 300), c: placedBox('c', 600, 0), d: placedBox('d', 600, 300),
    down: { kind: 'wire', id: 'down', from: 'a', to: 'd' },
    up: { kind: 'wire', id: 'up', from: 'b', to: 'c' },
  };
  const layout = layoutBoard(boardWithNearPinned({ id: 'corridor', title: 'corridor', version: 1, caption: null, createdAt: 0, updatedAt: 0, elements }));
  assert.deepEqual(layout.warnings.filter((warning) => warning.includes('overlaps wire')), []);
});

test('a decision fanning out to a stack of boxes draws its wires without crossings', () => {
  const fanBoard = boardWithNearPinned({
    id: 'fan', title: 'fan', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      ...stacked([
        [{ kind: 'box', id: 'pick', title: 'Disposition', shape: 'decision' }],
        [
          { kind: 'box', id: 'session', title: 'Session on branch', lines: [{ text: 'spawn / message PR session', style: 'item' }, { text: 'new push re-enters Sources', muted: true, style: 'item' }] },
          { kind: 'box', id: 'reply', title: 'Reply + resolve', lines: [{ text: 'post operator reason', style: 'item' }, { text: 'resolve thread', style: 'item' }] },
          { kind: 'box', id: 'resolve', title: 'ReviewHog Resolve', lines: [{ text: 'run_mode: resolve_only', style: 'code' }, { text: 'owner opt-in required', muted: true, style: 'item' }, { text: 'only when no local push', muted: true, style: 'item' }] },
          { kind: 'box', id: 'waiting', title: 'Waiting card', lines: [{ text: 'dashboard + Telegram', style: 'item' }] },
        ],
      ], { stackGap: 260, boxGap: 30 }),
      w10: { kind: 'wire', id: 'w10', from: 'pick', to: 'session', label: 'fix locally' },
      w11: { kind: 'wire', id: 'w11', from: 'pick', to: 'reply', label: 'dismiss' },
      w12: { kind: 'wire', id: 'w12', from: 'pick', to: 'resolve', label: 'fix remotely', dashed: true },
      w13: { kind: 'wire', id: 'w13', from: 'pick', to: 'waiting', label: 'escalate', tone: 'fail' },
    },
  });
  const crossings = layoutBoard(fanBoard).warnings.filter((warning) => warning.includes('crosses wire'));
  assert.deepEqual(crossings, []);
});

test('styled lines carry their markers, a panel with no place stacks clear right of every box until it is given one, and the legend names the wire styles in use with custom labels winning', () => {
  const styledBoard = boardWithNearPinned({
    id: 'styled', title: 'styled', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    legend: [{ tone: 'fail', label: 'gives up' }, { tone: 'plain', dashed: true, label: 'retry' }, { tone: 'join', label: 'merges back' }],
    elements: {
      first: { kind: 'box', id: 'first', title: 'First', at: { x: 40, y: 40 }, lines: [
        { text: 'a break' }, { text: '30s', style: 'kv', key: 'timeout' }, { text: 'npm test', style: 'code' }, { text: 'one point', style: 'item' },
      ] },
      second: { kind: 'box', id: 'second', title: 'Second', at: { x: 700, y: 200 } },
      prior: { kind: 'box', id: 'prior', title: 'Prior art', shape: 'panel', lines: [{ text: 'the old router', style: 'item' }] },
      w1: { kind: 'wire', id: 'w1', from: 'first', to: 'second', tone: 'fail' },
      w2: { kind: 'wire', id: 'w2', from: 'second', to: 'first', dashed: true },
    },
  });
  assert.throws(() => boardWithNearPinned({ ...styledBoard, elements: { ...styledBoard.elements.toJSON(), first: { ...styledBoard.elements.get('first'), lines: [{ text: 'x', style: 'kv' }] } } }), /a kv line needs a key/);
  const layout = layoutBoard(styledBoard);
  const first = layout.elements.find((element) => element.id === 'first');
  assert.ok(first?.kind === 'box');
  assert.deepEqual(first.bodyLines.map((line) => line.marker), [null, 'timeout', null, null]);
  const panel = layout.elements.find((element) => element.id === 'prior');
  const storedPanel = styledBoard.elements.get('prior');
  assert.ok(panel?.kind === 'box' && storedPanel?.kind === 'box');
  assert.equal(storedPanel.place, 'aside', 'a stored unplaced panel loads as an aside box');
  const besidePanel = layout.elements.filter((element) => element.kind === 'box' && element.id !== 'prior');
  assert.ok(besidePanel.every((element) => element.kind !== 'wire' && panel.x > element.x + element.width), `panel at ${panel.x} overlaps a box or note`);
  assert.deepEqual(layout.legend.map((row) => row.label), ['gives up', 'retry', 'merges back']);
  assert.equal(layout.warnings.filter((warning) => warning.includes('prior')).length, 0, layout.warnings.join('\n'));
  const author = { id: 'agent', name: 'agent' };
  const nearStacked = applyOps(styledBoard, [{ op: 'add', element: ElementInput.parse({ kind: 'box', id: 'beside', title: 'Beside', place: { near: { of: 'prior', side: 'bottom' } } }) }], author, 0);
  assert.equal(nearStacked.ok ? '' : nearStacked.error, 'op 1: box beside sits near prior, which is aside, so give prior a point first');
  const dragged = applyOps(styledBoard, [{ op: 'set', id: 'prior', fields: { place: { at: { x: 40, y: 900 } } } }], author, 0);
  assert.ok(dragged.ok, dragged.ok ? '' : dragged.error);
  const droppedPanel = layoutBoard(dragged.board).elements.find((element) => element.id === 'prior');
  assert.ok(droppedPanel?.kind === 'box');
  assert.deepEqual([droppedPanel.x, droppedPanel.y], [40, 900]);
  const withBoxNearPanel = applyOps(dragged.board, [{ op: 'add', element: ElementInput.parse({ kind: 'box', id: 'beside', title: 'Beside', place: { near: { of: 'prior', side: 'bottom' } } }) }], author, 0);
  assert.ok(withBoxNearPanel.ok, withBoxNearPanel.ok ? '' : withBoxNearPanel.error);
  const placedBeside = withBoxNearPanel.board.elements.get('beside');
  const restacked = applyOps(withBoxNearPanel.board, [{ op: 'set', id: 'prior', fields: { place: 'aside' } }], author, 0);
  assert.ok(restacked.ok, restacked.ok ? '' : restacked.error);
  assert.deepEqual(restacked.board.elements.get('beside'), placedBeside);
  assert.throws(() => Element.parse({ kind: 'panel', id: 'old', title: 'Old' }), /an element kind is box, frame, wire or stroke/);
});

test('a dashboard applying an edit diff reaches the server board exactly, and undoing it restores the board it started from, cascades included, a removed box leaving its note box in place, and the history keeps only the newest entries', () => {
  const author = { id: 'operator', name: 'operator' };
  const decision = { kind: 'box', id: 'gate', title: 'gate', place: { at: { x: 1200, y: 40 } }, shape: 'decision' };
  const before = applyOps(crowdedBoard, [
    { op: 'add', element: ElementInput.parse(decision) },
    { op: 'add', element: ElementInput.parse({ kind: 'wire', id: 'w1', from: 'gate', to: 'c1', label: 'ok' }) },
  ], author, 1);
  assert.ok(before.ok);
  const noted = applyOps(before.board, [
    { op: 'add', element: ElementInput.parse({ kind: 'box', id: 'n3', shape: 'note', title: 'agent finding', place: { at: { x: 1200, y: 300 } } }) },
    { op: 'add', element: ElementInput.parse({ kind: 'wire', id: 'n3-to-b1', from: 'n3', to: 'b1', dashed: true }) },
  ], { id: 'session-uuid', name: 'agent-a' }, 1);
  assert.ok(noted.ok, noted.ok ? '' : noted.error);
  const start = noted.board;
  const edits: Op[] = [
    { op: 'set', id: 'n3', fields: { title: 'rewritten by the operator' } },
    { op: 'remove', id: 'b1' },
    { op: 'set', id: 'gate', fields: { shape: 'box', title: 'renamed' } },
    { op: 'set', id: 'c2', fields: { place: { at: { x: 1500, y: 600 } } } },
    { op: 'board', title: 'renamed board', legend: [{ tone: 'fail', dashed: false, label: 'gives up' }], codeSessionId: 'builder-session' },
  ];
  const edited = applyOps(start, [{ op: 'remove', id: 'w1' }, ...edits], author, 2);
  assert.ok(edited.ok);
  assert.deepEqual([edited.board.elements.get('n3')?.kind, edited.board.elements.has('n3-to-b1')], ['box', false]);
  assert.equal(JSON.stringify(applyBoardDiff(start, edited.diff, edited.board.version, edited.board.updatedAt)), JSON.stringify(edited.board));
  const undone = applyOps(edited.board, undoOpsOf(edited.before, edited.diff), author, 3);
  assert.ok(undone.ok, undone.ok ? '' : undone.error);
  const comparable = (board: Board) => {
    const drawnAtById = new Map(layoutBoard(board).elements.flatMap((drawn) => (drawn.kind === 'box' ? [[drawn.id, { x: drawn.x, y: drawn.y }] as const] : [])));
    const elements = Object.fromEntries(Object.entries(board.elements.toJSON()).map(([id, element]) => [id, element.kind === 'box' ? { ...element, place: { at: drawnAtById.get(id) } } : element]));
    return { title: board.title, legend: board.legend, codeSessionId: board.codeSessionId, elements };
  };
  assert.deepEqual(comparable(undone.board), comparable(start));

  let history = EMPTY_HISTORY;
  for (let index = 0; index <= UNDO_LIMIT; index += 1) history = recordEdit(history, [{ op: 'remove', id: `edit-${index}` }]);
  assert.equal(history.undo.length, UNDO_LIMIT);
  assert.deepEqual(takeStep(history, 'undo')?.entry, [{ op: 'remove', id: `edit-${UNDO_LIMIT}` }]);
});

test('a dashboard keeps the server element order when an edit removes and re-adds ids', () => {
  const placedBox = (id: string) => ({ ...box(id), place: { at: { x: 40, y: 40 } } });
  const orderedBoard = (ids: string[]) => boardWithNearPinned({
    id: 'reorder', title: 'reorder', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: Object.fromEntries(ids.map((id) => [id, placedBox(id)])),
  });
  const readdingEdits: [string[], Op[]][] = [
    [['a', 'b', 'c'], [{ op: 'remove', id: 'a' }, { op: 'remove', id: 'c' }, { op: 'add', element: ElementInput.parse(placedBox('a')) }, { op: 'add', element: ElementInput.parse(placedBox('c')) }]],
    [['a', 'b'], [{ op: 'add', element: ElementInput.parse(placedBox('n')) }, { op: 'remove', id: 'b' }, { op: 'add', element: ElementInput.parse(placedBox('b')) }]],
  ];
  for (const [ids, edits] of readdingEdits) {
    const start = orderedBoard(ids);
    const edited = applyOps(start, edits, { id: 'operator', name: 'operator' }, 1);
    assert.ok(edited.ok, edited.ok ? '' : edited.error);
    assert.deepEqual([...applyBoardDiff(start, edited.diff, edited.board.version, edited.board.updatedAt)?.elements.keys() ?? []], [...edited.board.elements.keys()]);
  }
});

test('a board with plan steps keys their statuses in the legend, and a board without them keeps the legend free of statuses', () => {
  const planBoard = boardWithNearPinned({
    id: 'plan', title: 'plan', version: 1, caption: null, createdAt: 0, updatedAt: 0, legend: [],
    elements: { step: { kind: 'box', id: 'step', title: 'Index the diffs', step: { status: 'building' } } },
  });
  const layout = layoutBoard(planBoard);
  assert.deepEqual(layout.legend.map((row) => row.label), ['plan step planned', 'plan step building', 'plan step landed']);
  const svg = boardSvgDocument(layout);
  for (const status of ['planned', 'building', 'landed']) assert.match(svg, new RegExp(`class="wb-legend-swatch wb-step-swatch wb-step-${status}"`));
  for (const status of ['planned', 'building', 'landed']) assert.match(svg, new RegExp(`\\.wb-step-${status} \\{ fill: #`), `the export colors the ${status} swatch`);
  const plainBoard = boardWithNearPinned({ ...planBoard, elements: { only: { kind: 'box', id: 'only', title: 'Only' } } });
  assert.deepEqual(layoutBoard(plainBoard).legend, []);
});

test('a box width rewraps its text and grows its picture, a box height is a minimum the content can exceed, while an unsized box keeps the default and an out of range size is refused', () => {
  const picture = { kind: 'image' as const, asset: 'a'.repeat(64), mime: 'image/webp', width: 800, height: 400 };
  const sizedBoard = boardWithNearPinned({
    id: 'sized', title: 'sized', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      wide: { ...box('wide'), at: { x: 40, y: 40 }, width: 440, media: picture },
      narrow: { ...box('narrow'), near: { of: 'wide', side: 'bottom', gap: 30 } },
      next: { ...box('next'), near: { of: 'wide', side: 'right', gap: 90 }, height: 300 },
            squat: { ...box('squat'), near: { of: 'next', side: 'bottom', gap: 30 }, width: 160, height: 1, media: picture },
      free: { kind: 'box', id: 'free', title: 'Free', at: { x: 900, y: 400 }, width: 160, media: picture },
      'tall-page': { kind: 'box', id: 'tall-page', title: 'Page', at: { x: 0, y: 2000 }, width: 960, height: 1400, media: { kind: 'page', asset: 'b'.repeat(64), mime: 'text/html', width: 1280, height: 800 } },
      'tall-doc': { kind: 'box', id: 'tall-doc', title: 'Doc', at: { x: 1200, y: 2000 }, height: 900, media: { kind: 'doc', asset: 'c'.repeat(64), mime: 'text/markdown', width: 800, height: 1000 } },
      'tall-picture': { kind: 'box', id: 'tall-picture', title: 'Picture', at: { x: 1600, y: 2000 }, height: 900, media: picture },
      'short-page': { kind: 'box', id: 'short-page', title: 'Page', at: { x: 2000, y: 2000 }, media: { kind: 'page', asset: 'b'.repeat(64), mime: 'text/html', width: 1280, height: 800 } },
    },
  });
  const boxById = new Map(layoutBoard(sizedBoard).elements.flatMap((element) => (element.kind === 'box' ? [[element.id, element] as const] : [])));
  const wide = boxById.get('wide');
  const narrow = boxById.get('narrow');
  const next = boxById.get('next');
  const free = boxById.get('free');
  const squat = boxById.get('squat');
  assert.ok(wide && narrow && next && free && squat);
  assert.equal(next.height, 300, 'a box height taller than its content sets the box height');
  assert.equal(squat.y, next.y + 300 + 30, 'a box below the tall one clears its set height');
  assert.ok(squat.height > 68, 'content taller than a box height still fits');
  assert.equal(narrow.width, 220, 'a box with no width keeps the default');
  assert.equal(wide.width, 440);
  assert.equal(wide.titleLines.length, 1, 'a wider box wraps its title to its width');
  assert.equal(narrow.titleLines.length, 2);
  assert.deepEqual([wide.media?.width, wide.media?.height], [416, 208], 'the picture fills the wider inner width');
  assert.deepEqual([free.media?.width, free.media?.height], [136, 68]);
  for (const id of ['tall-page', 'tall-doc']) {
    const tall = boxById.get(id);
    assert.ok(tall?.media);
    assert.equal(tall.media.y + tall.media.height, tall.y + tall.height - 12, `${id} media fills the set box height down to its bottom padding`);
  }
  const tallPicture = boxById.get('tall-picture');
  assert.deepEqual([tallPicture?.media?.width, tallPicture?.media?.height], [196, 98], 'a picture keeps its aspect in a tall box');
  assert.deepEqual([boxById.get('short-page')?.media?.width, boxById.get('short-page')?.media?.height], [196, 123], 'a page with no set height keeps its aspect size');
  assert.equal(next.x, wide.x + wide.width + 90, 'a box beside the widened one clears its new width');
  const refused = applyOps(sizedBoard, [{ op: 'set', id: 'narrow', fields: { width: 2000 } }], { id: 'agent', name: 'agent' }, 0);
  assert.equal(refused.ok ? '' : refused.error, 'op 1: narrow: a box width is 160 to 960');
  const tooTall = applyOps(sizedBoard, [{ op: 'set', id: 'narrow', fields: { height: 5000 } }], { id: 'agent', name: 'agent' }, 0);
  assert.equal(tooTall.ok ? '' : tooTall.error, 'op 1: narrow: a box height is 1 to 2400');
});

test('a long identifier breaks after a separator, an agent box with no width is stored wide enough for its title, and a title still cut mid-word warns with the width that fits', () => {
  const identifierBoard = boardWithNearPinned({
    id: 'identifiers', title: 'identifiers', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      separated: { kind: 'box', id: 'separated', title: 'run_merge_check_against_repository', at: { x: 40, y: 40 } },
      unbroken: { kind: 'box', id: 'unbroken', title: 'abcdefghijklmnopqrstuvwxyzabcd', at: { x: 400, y: 40 } },
    },
  });
  const layout = layoutBoard(identifierBoard);
  const separated = layout.elements.find((element) => element.id === 'separated');
  assert.ok(separated?.kind === 'box');
  assert.deepEqual(separated.titleLines, ['run_merge_check_', 'against_repository']);
  assert.deepEqual(layout.warnings.filter((warning) => warning.includes('cut mid-word')), ['box unbroken title is cut mid-word at width 220; set width 320']);

  const author = { id: 'agent', name: 'agent' };
  const added = applyOps(identifierBoard, [{ op: 'add', element: ElementInput.parse({ kind: 'box', id: 'fitted', title: 'landed_change(repository, row)', place: { at: { x: 40, y: 400 } } }) }], author, 0);
  assert.ok(added.ok);
  const fitted = layoutBoard(added.board).elements.find((element) => element.id === 'fitted');
  assert.ok(fitted?.kind === 'box');
  assert.deepEqual([fitted.width, fitted.titleLines], [320, ['landed_change(repository, row)']]);
  const unfittable = applyOps(identifierBoard, [
    { op: 'add', element: ElementInput.parse({ kind: 'box', id: 'hashed', title: 'Key', place: { at: { x: 40, y: 700 } }, lines: [{ style: 'code', text: 'A'.repeat(100) }] }) },
    { op: 'add', element: ElementInput.parse({ kind: 'box', id: 'endless', title: 'A'.repeat(60), place: { at: { x: 40, y: 1000 } } }) },
  ], author, 0);
  assert.ok(unfittable.ok);
  const unfittableWidths = ['hashed', 'endless'].map((id) => { const stored = unfittable.board.elements.get(id); return stored?.kind === 'box' ? stored.width : undefined; });
  assert.deepEqual(unfittableWidths, [null, null], 'a body or title word no width up to 480 fits does not widen the box');

  const world = createLayoutWorld(identifierBoard, null, 0);
  const widened = stageOps(identifierBoard, [Op.parse({ op: 'set', id: 'unbroken', fields: { width: 320 } })], author, 0, null);
  assert.ok(widened.ok);
  const changes = new Map(Object.entries(widened.diff.elements).map(([id, change]) => [id, { before: identifierBoard.elements.get(id), after: widened.afterById.get(id) ?? null, isAppended: change[0] === 'put' }]));
  widened.commit();
  const applied = applyLayoutDelta(world, widened.board, changes);
  assert.equal(applied.delta.isRebuilt, false);
  assert.deepEqual(warningsOfWorld(applied.world).filter((warning) => warning.includes('cut mid-word')), [], 'the incremental layout drops the warning once the width fits');
});

test('a wire ends at a free point or a box edge, rotated or not, runs sharp, curved or elbow through its bend points, carries arrowheads at none, one or both ends, and its points move with the plan band', () => {
  const freeBoard = Board.parse({ id: 'free', title: 'free', version: 1, caption: null, createdAt: 0, updatedAt: 0, elements: {
    plan: { kind: 'box', id: 'plan', title: 'Planned', place: 'plan', step: {} },
    left: { kind: 'box', id: 'left', title: 'Left', place: { at: { x: 0, y: 0 } } },
    right: { kind: 'box', id: 'right', title: 'Right', place: { at: { x: 600, y: 300 } } },
    pointer: { kind: 'wire', id: 'pointer', from: 'left', to: { x: 300, y: -200 }, route: 'sharp', arrows: 'both' },
    bowed: { kind: 'wire', id: 'bowed', from: 'left', to: 'right', route: 'curved', arrows: 'none', label: 'bends' },
    bent: { kind: 'wire', id: 'bent', from: { x: -300, y: 500 }, to: 'right', arrows: 'end' },
    loose: { kind: 'wire', id: 'loose', from: { x: 900, y: 0 }, to: { x: 1100, y: 40 }, route: 'sharp' },
    routed: { kind: 'wire', id: 'routed', from: 'right', to: 'left' },
    kinked: { kind: 'wire', id: 'kinked', from: 'left', to: 'right', route: 'sharp', via: [{ x: 400, y: -100 }] },
    swept: { kind: 'wire', id: 'swept', from: 'left', to: 'right', route: 'curved', via: [{ x: 250, y: 400 }] },
    shifted: { kind: 'wire', id: 'shifted', from: 'left', to: 'right', via: [{ x: 300, y: 20 }, { x: 300, y: 330 }] },
    turned: { kind: 'box', id: 'turned', title: 'Turned', angle: 45, place: { at: { x: 1600, y: 300 } } },
    'to-turned': { kind: 'wire', id: 'to-turned', from: { x: 1300, y: 250 }, to: 'turned', route: 'sharp' },
  } });
  const layout = layoutBoard(freeBoard);
  const laidOutById = new Map(layout.elements.map((element) => [element.id, element]));
  const wireOf = (id: string) => {
    const laidOut = laidOutById.get(id);
    assert.ok(laidOut?.kind === 'wire', `${id} is drawn`);
    return { ...laidOut, points: pointsOfLaidOutPath(laidOut.path) };
  };
  const left = laidOutById.get('left');
  assert.ok(left?.kind === 'box' && layout.pinnedOffsetY > 0, 'the plan band pushes the free drawing down');
  const pointer = wireOf('pointer');
  assert.equal(pointer.points.length, 2, 'a sharp wire is one straight line');
  assert.deepEqual(pointer.end, { x: 300, y: -200 + layout.pinnedOffsetY }, 'a free point moves with the plan band like the boxes do');
  const onLeftEdge = Math.abs(pointer.start.x - left.x) < 0.2 || Math.abs(pointer.start.x - (left.x + left.width)) < 0.2 || Math.abs(pointer.start.y - left.y) < 0.2 || Math.abs(pointer.start.y - (left.y + left.height)) < 0.2;
  assert.ok(onLeftEdge, `a sharp wire leaves its box from the edge, got ${JSON.stringify(pointer.start)}`);
  assert.deepEqual([pointer.hasArrowhead, pointer.hasStartArrowhead], [true, true]);
  const bowed = wireOf('bowed');
  const straightLine = { from: bowed.points[0], to: bowed.points[bowed.points.length - 1] };
  assert.ok(bowed.points.length > 3 && straightLine.from && straightLine.to, 'a curved wire is drawn as many points');
  const middle = bowed.points[Math.floor(bowed.points.length / 2)];
  assert.ok(middle && Math.hypot(middle.x - (straightLine.from.x + straightLine.to.x) / 2, middle.y - (straightLine.from.y + straightLine.to.y) / 2) > 20, 'a curved wire bows away from the straight line');
  assert.deepEqual([bowed.hasArrowhead, bowed.hasStartArrowhead], [false, false]);
  const bent = wireOf('bent');
  assert.ok(bent.points.length <= 3, 'an elbow wire with a free end bends at most once');
  for (const [index, point] of bent.points.slice(1).entries()) {
    const previous = bent.points[index];
    assert.ok(previous && (previous.x === point.x || previous.y === point.y), 'an elbow wire with a free end runs at right angles');
  }
  assert.equal(wireOf('loose').points.length, 2, 'a wire with two free ends needs no box');
  assert.ok(wireOf('routed').points.every((point, index, points) => index === 0 || points[index - 1]?.x === point.x || points[index - 1]?.y === point.y), 'a box to box elbow wire still takes the router');
  const kinked = wireOf('kinked');
  const kinkedCorner = { x: 400, y: -100 + layout.pinnedOffsetY };
  assert.deepEqual([kinked.points.length, kinked.points[1], kinked.bends], [3, kinkedCorner, [kinkedCorner]], 'a sharp wire runs straight through its bend point, which moves with the plan band');
  assert.deepEqual(wireHandlesOf(kinked).map((handle) => handle.kind), ['bend', 'midpoint', 'midpoint'], 'a bent sharp wire offers its bend and a midpoint on each side to add another');
  const sweptCorner = { x: 250, y: 400 + layout.pinnedOffsetY };
  assert.ok(wireOf('swept').points.some((point) => point.x === sweptCorner.x && point.y === sweptCorner.y), 'a curved wire passes through its bend point');
  const shifted = wireOf('shifted');
  const isOrthogonal = (points: readonly { x: number; y: number }[]) => points.every((point, index) => index === 0 || points[index - 1]?.x === point.x || points[index - 1]?.y === point.y);
  assert.ok(isOrthogonal(shifted.points), 'an elbow wire with corners still runs at right angles');
  assert.ok([20, 330].every((cornerY) => shifted.points.some((point) => point.x === 300 && point.y === cornerY + layout.pinnedOffsetY)), `an elbow wire turns at its stored corners, got ${JSON.stringify(shifted.points)}`);
  const middleSegment = wireHandlesOf(shifted).find((handle) => handle.kind === 'segment' && handle.at.x === 300);
  assert.ok(middleSegment, 'an elbow wire offers a handle on its middle segment');
  const movedCorners = elbowCornersAfterShift(shifted.points, middleSegment.index, { x: 60, y: 999 });
  assert.ok(movedCorners.length >= 2 && movedCorners.every((corner) => corner.x !== 300) && isOrthogonal([shifted.start, ...movedCorners, shifted.end]), `dragging the middle segment shifts it sideways only, got ${JSON.stringify(movedCorners)}`);
  const turned = laidOutById.get('turned');
  assert.ok(turned?.kind === 'box' && turned.angle === 45, 'a laid out box carries its angle');
  const turnedCenter = { x: turned.x + turned.width / 2, y: turned.y + turned.height / 2 };
  const turnedEnd = rotatedAbout(wireOf('to-turned').end, turnedCenter, -45);
  const isOnTurnedOutline = Math.abs(Math.abs(turnedEnd.x - turnedCenter.x) - turned.width / 2) < 0.5 || Math.abs(Math.abs(turnedEnd.y - turnedCenter.y) - turned.height / 2) < 0.5;
  assert.ok(isOnTurnedOutline, `a wire attaches to the rotated outline of its box, got ${JSON.stringify(turnedEnd)}`);
  const pictured = boardSvgDocument(layout);
  assert.ok(pictured.includes(`transform="rotate(45 ${turnedCenter.x} ${turnedCenter.y})"`), 'the SVG draws a rotated box rotated about its center');
  assert.ok(/data-element-id="pointer"[\s\S]*?marker-start="url\(#wb-arrow\)"/.test(pictured), 'the SVG draws an arrowhead at the start of a both-ends wire');
  const world = createLayoutWorld(freeBoard, null, 0);
  const incremental = layoutOf(world).elements.find((element) => element.id === 'pointer');
  assert.ok(incremental?.kind === 'wire' && incremental.path === pointer.path, 'the incremental layout draws the free wire the same way');
});

test('a wire to a box beside and below leaves through the facing side with a jog, never around the corner from the bottom', () => {
  const sideBySide = boardWithNearPinned({
    id: 'jog', title: 'jog', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      check: { kind: 'box', id: 'check', title: 'Check', at: { x: 40, y: 40 } },
      write: { kind: 'box', id: 'write', title: 'Write', at: { x: 420, y: 40 } },
      retry: { kind: 'box', id: 'retry', title: 'Retry', at: { x: 420, y: 260 } },
      passes: { kind: 'wire', id: 'passes', from: 'check', to: 'write', label: 'merges clean' },
      fails: { kind: 'wire', id: 'fails', from: 'check', to: 'retry', label: 'conflict', tone: 'fail' },
      tight: { kind: 'box', id: 'tight', title: 'Tight', at: { x: 40, y: 600 } },
      close: { kind: 'box', id: 'close', title: 'Close', at: { x: 272, y: 700 } },
      squeezed: { kind: 'wire', id: 'squeezed', from: 'tight', to: 'close' },
      source: { kind: 'box', id: 'source', title: 'Source', at: { x: 40, y: 1000 } },
      target: { kind: 'box', id: 'target', title: 'Target', at: { x: 420, y: 1260 } },
      bystander: { kind: 'box', id: 'bystander', title: 'Bystander', at: { x: 342, y: 1040 } },
      crowded: { kind: 'wire', id: 'crowded', from: 'source', to: 'target' },
    },
  });
  const layout = layoutBoard(sideBySide);
  const fails = layout.elements.find((element) => element.id === 'fails');
  const check = layout.elements.find((element) => element.id === 'check');
  assert.ok(fails?.kind === 'wire' && check?.kind === 'box');
  assert.deepEqual([fails.start.x, fails.end.x], [check.x + check.width, 420], layout.warnings.join('\n'));
  const squeezed = layout.elements.find((element) => element.id === 'squeezed');
  assert.ok(squeezed?.kind === 'wire');
  assert.notEqual(squeezed.start.x, 260, 'a gap too narrow for a lead on each side of the jog keeps the route around the corner');
  const crowded = layout.elements.find((element) => element.id === 'crowded');
  const bystander = layout.elements.find((element) => element.id === 'bystander');
  assert.ok(crowded?.kind === 'wire' && bystander?.kind === 'box');
  const crowdedXs = crowded.path.split(' L ').map((point) => Number(point.replace('M ', '').split(' ')[0]));
  assert.ok(crowdedXs.every((x) => x <= bystander.x - 14 || x >= bystander.x + bystander.width + 14 || x === crowded.end.x), `a jog keeps the search clearance from a third box: ${crowded.path}`);
  assert.deepEqual(layout.warnings, []);
});

function savedThroughJson(world: LayoutWorld) {
  const saved = JSON.parse(JSON.stringify({ laidOut: layoutOf(world).elements, chrome: world.chrome, ...savedWorldOf(world), routeById: [...world.routeMemory.routeById] }));
  return {
    laidOut: z.array(PlacedElementShape).parse(saved.laidOut),
    chrome: saved.chrome,
    routeById: new Map(z.array(z.tuple([z.string(), RememberedRoute])).parse(saved.routeById)),
    routeWarnings: z.array(z.string()).parse(saved.routeWarnings),
    placementWarnings: z.array(z.string()).parse(saved.placementWarnings),
  };
}

test('a layout world kept across a box rotation routes its wires as a fresh layout does, around the turned box and from a turned end box', () => {
  const author = { id: 'operator', name: 'operator' };
  let board = Board.parse({ id: 'turning', title: 'turning', version: 1, caption: null, createdAt: 0, updatedAt: 0, elements: {
    a: { kind: 'box', id: 'a', title: 'A', place: { at: { x: 0, y: 0 } } },
    b: { kind: 'box', id: 'b', title: 'B', place: { at: { x: 900, y: 0 } } },
    w: { kind: 'wire', id: 'w', from: 'a', to: 'b' },
    c: { kind: 'box', id: 'c', title: 'C', width: 400, place: { at: { x: 250, y: 160 } } },
    d: { kind: 'box', id: 'd', title: 'D', angle: 180, place: { at: { x: 600, y: 600 } } },
    e: { kind: 'box', id: 'e', title: 'E', place: { at: { x: 1200, y: 900 } } },
    v: { kind: 'wire', id: 'v', from: 'a', to: 'd' },
    u: { kind: 'wire', id: 'u', from: 'e', to: 'd' },
  } });
  let world = createLayoutWorld(board, null, 0);
  for (const op of [{ op: 'set', id: 'c', fields: { angle: 90 } }, { op: 'set', id: 'e', fields: { title: 'E2' } }]) {
    const staged = stageOps(board, [Op.parse(op)], author, 0, null);
    assert.ok(staged.ok, staged.ok ? '' : staged.error);
    const changes = new Map(Object.entries(staged.diff.elements).map(([id, change]) => [id, { before: board.elements.get(id), after: staged.afterById.get(id) ?? null, isAppended: change[0] === 'put' }]));
    staged.commit();
    board = staged.board;
    const applied = applyLayoutDelta(world, board, changes);
    assert.equal(applied.delta.isRebuilt, false);
    world = applied.world;
    const pathById = (elements: readonly (LaidOutElement | PlacedElement)[]) => new Map(elements.flatMap((element) => (element.kind === 'wire' ? [[element.id, element.path] as const] : [])));
    assert.deepEqual(pathById(layoutOf(world).elements), pathById(layoutBoard(board).elements), `after ${JSON.stringify(op)}`);
  }
});

test('a layout world kept across puts places what a fresh layout places, and its patched tile index paints what a fresh index paints', () => {
  let { board } = generateBoardRecord({ elementCount: 400, seed: 7, boardId: 'kept', title: 'kept', createdAt: 0 });
  const author = { id: 'operator', name: 'operator' };
  let world = createLayoutWorld(board, null, 0);
  const tileIndex = tileIndexOf(layoutOf(world), board.version, board);
  const pinnedBoxes = [...board.elements.values()].flatMap((element) => (element.kind === 'box' && pointOfBox(element) ? [element] : []));
  const [moved, noted, framed, removed, wired] = pinnedBoxes;
  const movedAt = moved ? pointOfBox(moved) : null;
  const notedAt = noted ? pointOfBox(noted) : null;
  const anyNote = [...board.elements.values()].find((element) => element.kind === 'box' && element.shape === 'note');
  assert.ok(moved && movedAt && noted && notedAt && framed && removed && wired && anyNote);
  const puts = [
    [{ op: 'set', id: moved.id, fields: { place: { at: { x: movedAt.x + 180, y: movedAt.y + 60 } } } }],
    [{ op: 'add', element: { kind: 'box', id: 'kept-note', shape: 'note', title: 'a note added after the first layout', place: { at: { x: notedAt.x + 244, y: notedAt.y } } } }, { op: 'add', element: { kind: 'wire', id: 'kept-note-wire', from: 'kept-note', to: noted.id, dashed: true } }],
    [{ op: 'add', element: { kind: 'box', id: '5', shape: 'note', title: 'a note whose id the board object lists first', place: { at: { x: notedAt.x + 244, y: notedAt.y + 120 } } } }],
    [{ op: 'remove', id: anyNote.id }],
    [{ op: 'add', element: { kind: 'box', id: 'kept-near', title: 'beside', place: { near: { of: noted.id, side: 'right' } } } }],
    [{ op: 'add', element: { kind: 'frame', id: 'kept-frame', title: 'kept frame', contains: [framed.id, moved.id] } }],
    [{ op: 'add', element: { kind: 'wire', id: 'kept-wire', from: wired.id, to: noted.id, label: 'kept' } }],
    [{ op: 'set', id: noted.id, fields: { title: 'a much longer title that wraps over several lines of the box' } }],
    [{ op: 'remove', id: removed.id }],
  ];
  const resumeAfterPut = 4;
  let resumed: LayoutWorld | null = null;
  let savedMirror: { routeById: Map<string, unknown>; routeWarnings: string[]; placementWarnings: string[] } | null = null;
  for (const [putIndex, ops] of puts.entries()) {
    if (putIndex === resumeAfterPut) {
      const saved = savedThroughJson(world);
      resumed = resumeLayoutWorld(board, saved, 0);
      savedMirror = { routeById: new Map(saved.routeById), routeWarnings: [...saved.routeWarnings], placementWarnings: [...saved.placementWarnings] };
    }
    const staged = stageOps(board, ops.map((op) => Op.parse(op)), author, 0, null);
    assert.ok(staged.ok, staged.ok ? '' : staged.error);
    const changes = new Map(Object.entries(staged.diff.elements).map(([id, change]) => [id, { before: board.elements.get(id), after: staged.afterById.get(id) ?? null, isAppended: change[0] === 'put' }]));
    staged.commit();
    board = staged.board;
    const applied = applyLayoutDelta(world, board, changes);
    assert.equal(applied.delta.isRebuilt, false);
    world = applied.world;
    patchTileIndex(tileIndex, board, { version: board.version, chrome: world.chrome, changed: applied.delta.changed, removedIds: applied.delta.removedIds, recordChangedIds: [...changes.keys()] });
    if (resumed && savedMirror) {
      const resumedApplied = applyLayoutDelta(resumed, board, changes);
      assert.equal(resumedApplied.delta.isRebuilt, false);
      resumed = resumedApplied.world;
      for (const id of applied.delta.worldChanges.routeIds) {
        const route = world.routeMemory.routeById.get(id);
        if (route) savedMirror.routeById.set(id, route);
        if (!route) savedMirror.routeById.delete(id);
      }
      for (const { book, text, isPresent } of applied.delta.worldChanges.warnings) {
        const texts = book === 'route' ? savedMirror.routeWarnings : savedMirror.placementWarnings;
        const kept = texts.filter((known) => known !== text);
        if (isPresent) kept.push(text);
        texts.splice(0, texts.length, ...kept);
      }
    }
  }
  assert.ok(resumed && savedMirror);
  assert.deepEqual(layoutOf(resumed).elements, layoutOf(world).elements);
  assert.deepEqual(warningsOfWorld(resumed), warningsOfWorld(world));
  assert.deepEqual(resumed.chrome, world.chrome);
  const savedAtEnd = savedWorldOf(world);
  assert.deepEqual(savedMirror, { routeById: new Map(savedAtEnd.routeById), routeWarnings: savedAtEnd.routeWarnings, placementWarnings: savedAtEnd.placementWarnings });
  const kept = layoutOf(world);
  const fresh = placeBoardWithMemory(board, null).layout;
  const solidsOf = (elements: readonly PlacedElement[]) => elements.filter((element) => element.kind !== 'wire').map((element) => JSON.stringify(element)).sort();
  assert.deepEqual(solidsOf(kept.elements), solidsOf(fresh.elements));
  assert.deepEqual(kept.elements.filter((element) => element.kind === 'wire').map((element) => element.id).sort(), fresh.elements.filter((element) => element.kind === 'wire').map((element) => element.id).sort());
  assert.deepEqual(kept.bounds, fresh.bounds);
  const freshIndex = tileIndexOf(kept, board.version, board);
  const paintedIn = (index: typeof tileIndex, key: ReturnType<typeof tileKeysFor>[number]) => tileOf(index, key).elements.map((painted) => JSON.stringify(painted.element)).sort();
  for (const key of tileKeysFor(kept.bounds, 'full')) assert.deepEqual(paintedIn(tileIndex, key), paintedIn(freshIndex, key));
  assert.deepEqual(tileIndex.chrome, freshIndex.chrome);
});

test('a collapsed frame draws as one stack card, hides the boxes under its first, ends their wires at the card, and refuses a box already in another stack', () => {
  const author = { id: 'agent', name: 'agent' };
  const stackBoard = boardWithNearPinned({
    id: 'stacks', title: 'stacks', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      top: { kind: 'box', id: 'top', title: 'Top card', at: { x: 40, y: 40 } },
      under: { kind: 'box', id: 'under', title: 'Under card', at: { x: 40, y: 400 } },
      source: { kind: 'box', id: 'source', title: 'Source', at: { x: 600, y: 400 } },
      follower: { kind: 'box', id: 'follower', title: 'Follower', near: { of: 'source', side: 'bottom' } },
      w1: { kind: 'wire', id: 'w1', from: 'source', to: 'under' },
      inside: { kind: 'wire', id: 'inside', from: 'top', to: 'under' },
      refs: { kind: 'frame', id: 'refs', title: 'Refs', contains: ['top', 'under', 'follower'] },
    },
  });
  let world = createLayoutWorld(stackBoard, null, 0);
  const staged = stageOps(stackBoard, [Op.parse({ op: 'set', id: 'refs', fields: { collapsed: true } })], author, 0, null);
  assert.ok(staged.ok, staged.ok ? '' : staged.error);
  const changes = new Map(Object.entries(staged.diff.elements).map(([id, change]) => [id, { before: stackBoard.elements.get(id), after: staged.afterById.get(id) ?? null, isAppended: change[0] === 'put' }]));
  staged.commit();
  world = applyLayoutDelta(world, staged.board, changes).world;
  const kept = layoutOf(world);
  const fresh = layoutBoard(staged.board);
  assert.deepEqual(kept.elements.map((element) => element.id).sort(), fresh.elements.map((element) => element.id).sort(), 'a layout world kept across the collapse places what a fresh layout places');
  const byId = new Map(fresh.elements.map((element) => [element.id, element]));
  assert.equal(byId.has('under'), false, 'the box under the top card is hidden');
  assert.equal(byId.has('inside'), false, 'a wire between two stacked boxes is hidden');
  const card = byId.get('refs');
  const topCard = byId.get('top');
  const wire = byId.get('w1');
  assert.ok(card?.kind === 'frame' && topCard?.kind === 'box' && wire?.kind === 'wire');
  assert.equal(card.stackedBoxCount, 3);
  assert.ok(contains(card, topCard), 'the card sits around the top box');
  assert.ok(wire.end.x >= topCard.x - 1 && wire.end.x <= topCard.x + topCard.width + 1 && wire.end.y >= topCard.y - 1 && wire.end.y <= topCard.y + topCard.height + 1, 'a wire to a hidden box ends at the card');
  const moved = stageOps(staged.board, [Op.parse({ op: 'set', id: 'source', fields: { place: { at: { x: 700, y: 420 } } } })], author, 0, null);
  assert.ok(moved.ok, moved.ok ? '' : moved.error);
  const moveChanges = new Map(Object.entries(moved.diff.elements).map(([id, change]) => [id, { before: staged.board.elements.get(id), after: moved.afterById.get(id) ?? null, isAppended: change[0] === 'put' }]));
  moved.commit();
  const keptAfterMove = layoutOf(applyLayoutDelta(world, moved.board, moveChanges).world);
  assert.deepEqual(keptAfterMove.elements.map((element) => element.id).sort(), layoutBoard(moved.board).elements.map((element) => element.id).sort(), 'moving a box wired into a stack keeps its wire to the card, and a stacked box placed near it stays hidden');
  const second = applyOps(staged.board, [Op.parse({ op: 'add', element: { kind: 'frame', id: 'again', title: 'Again', contains: ['under'], collapsed: true } })], author, 0);
  assert.equal(second.ok ? '' : second.error, 'op 1: frame again stacks under, which is already in stack refs');
});

test('a board keeps a box height, dial values, page dials and a collapsed frame through its stored element table', () => {
  const dialedPage = { kind: 'page' as const, asset: 'b'.repeat(64), mime: 'text/html' as const, width: 800, height: 600, dials: [{ id: 'hue', kind: 'range' as const, label: 'Hue', min: 0, max: 360, default: 120 }, { id: 'dark', kind: 'toggle' as const, label: 'Dark' }, { id: 'toString', kind: 'toggle' as const, label: 'Named like an object method' }] };
  const rawElements = [
    { kind: 'box', id: 'page', title: 'Page', place: { at: { x: 40, y: 40 } }, height: 500, media: dialedPage, params: { hue: 200, dark: true } },
    { kind: 'box', id: 'card', title: 'Card', place: { at: { x: 900, y: 40 } } },
    { kind: 'frame', id: 'pile', title: 'Pile', contains: ['page', 'card'], collapsed: true },
  ];
  const board = boardWithNearPinned({ id: 'kept', title: 'kept', version: 1, caption: null, createdAt: 0, updatedAt: 0, elements: Object.fromEntries(rawElements.map((element) => [element.id, element])) });
  for (const rawElement of rawElements) assert.deepEqual(board.elements.get(rawElement.id), Element.parse(rawElement), `${rawElement.id} reads back whole`);
  const page = board.elements.get('page');
  assert.ok(page?.kind === 'box');
  assert.deepEqual(dialValuesOfBox(page), { hue: 200, dark: true, toString: false }, 'a dial named like an object method reads its default');
});

test('a device draws borderless unless set false, and a shape change takes the new shape default', () => {
  const author = { id: 'operator', name: 'operator' };
  const deviceBoard = boardWithNearPinned({
    id: 'devices', title: 'devices', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      phone: { kind: 'box', id: 'phone', title: 'Phone', shape: 'device', device: 'phone', at: { x: 0, y: 0 } },
      carded: { kind: 'box', id: 'carded', title: 'Carded', shape: 'device', device: 'phone', borderless: false, at: { x: 400, y: 0 } },
      plain: { kind: 'box', id: 'plain', title: 'Plain', at: { x: 800, y: 0 } },
    },
  });
  const reshaped = applyOps(deviceBoard, [
    { op: 'set', id: 'plain', fields: { shape: 'device', device: 'phone' } },
    { op: 'set', id: 'phone', fields: { shape: 'box' } },
  ], author, 0);
  assert.ok(reshaped.ok);
  const isBorderlessById = new Map(layoutBoard(reshaped.board).elements.flatMap((element) => (element.kind === 'box' ? [[element.id, element.isBorderless]] : [])));
  assert.deepEqual(Object.fromEntries(isBorderlessById), { phone: false, carded: false, plain: true });
});

test('a stored sticky loads as a note in its tone and stored text as a borderless box', () => {
  const noteBoard = boardWithNearPinned({
    id: 'notes', title: 'notes', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      pink: { kind: 'box', id: 'pink', title: 'Pink note', shape: 'sticky', tone: 'pink', at: { x: 40, y: 40 } },
      plain: { kind: 'box', id: 'plain', title: 'Default note', shape: 'sticky', at: { x: 400, y: 40 } },
      words: { kind: 'box', id: 'words', title: 'Words', shape: 'text', at: { x: 40, y: 300 }, lines: [{ text: 'free text' }] },
    },
  });
  const laidOutById = new Map(layoutBoard(noteBoard).elements.flatMap((element) => (element.kind === 'box' ? [[element.id, element] as const] : [])));
  const skinOf = (id: string) => [laidOutById.get(id)?.shape, laidOutById.get(id)?.tone, laidOutById.get(id)?.isBorderless];
  assert.deepEqual([skinOf('pink'), skinOf('plain'), skinOf('words')], [['note', 'pink', false], ['note', 'yellow', false], ['box', null, true]]);
  const svg = boardSvgDocument(layoutBoard(noteBoard));
  assert.match(svg, /class="wb-element wb-box wb-note wb-tone-pink"/);
  assert.match(svg, /class="wb-element wb-box wb-borderless"/);
});

test('a layout world kept across an edit bounds the board around far ink as a fresh layout does', () => {
  const author = { id: 'operator', name: 'operator' };
  const inkBoard = boardWithNearPinned({
    id: 'ink', title: 'ink', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      a: { kind: 'box', id: 'a', title: 'A', at: { x: 40, y: 40 } },
      c: { kind: 'box', id: 'c', title: 'C', at: { x: 400, y: 40 } },
      far: { kind: 'stroke', id: 'far', points: [5000, 5000, 5100, 5100] },
    },
  });
  const world = createLayoutWorld(inkBoard, null, 1);
  const staged = stageOps(inkBoard, [Op.parse({ op: 'set', id: 'c', fields: { place: { at: { x: 420, y: 40 } } } })], author, 0, null);
  assert.ok(staged.ok, staged.ok ? '' : staged.error);
  const changes = new Map(Object.entries(staged.diff.elements).map(([id, change]) => [id, { before: inkBoard.elements.get(id), after: staged.afterById.get(id) ?? null, isAppended: change[0] === 'put' }]));
  staged.commit();
  const kept = applyLayoutDelta(world, staged.board, changes);
  assert.equal(kept.delta.isRebuilt, false);
  assert.deepEqual(layoutOf(kept.world).bounds, layoutBoard(staged.board).bounds);
});

test('placeholder text wider than its media is cut to fit in the board picture, wide characters counting double, while its title keeps the whole text', () => {
  const longAlt = 'The X post as it shows on a phone, with the board video under the text';
  const wideAlt = String.fromCharCode(0x56fe).repeat(40);
  const pageMedia = (alt: string) => ({ kind: 'page', asset: 'a'.repeat(64), mime: 'text/html', width: 1280, height: 800, alt });
  const pictured = boardSvgDocument(layoutBoard(Board.parse({ id: 'b', title: 'b', version: 1, caption: null, createdAt: 0, updatedAt: 0, elements: {
    phone: { kind: 'box', id: 'phone', title: 'Phone', shape: 'device', device: 'phone', width: 240, media: pageMedia(longAlt), place: { at: { x: 0, y: 0 } } },
    wide: { kind: 'box', id: 'wide', title: 'Wide', shape: 'device', device: 'phone', width: 240, media: pageMedia(wideAlt), place: { at: { x: 400, y: 0 } } },
    roomy: { kind: 'box', id: 'roomy', title: 'Roomy', width: 600, media: pageMedia('short alt'), place: { at: { x: 800, y: 0 } } },
  } })));
  const drawnTexts = [...pictured.matchAll(/wb-image-placeholder-text"[^>]*>([^<]*)</g)].map((match) => match[1]);
  assert.deepEqual(drawnTexts, ['The X post as it shows on...', `${wideAlt.slice(0, 12)}...`, 'short alt']);
  assert.ok(pictured.includes(`<title>${longAlt}</title>`), 'the title keeps the whole text');
});
