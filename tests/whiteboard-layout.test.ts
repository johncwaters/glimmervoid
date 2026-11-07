import test from 'node:test';
import assert from 'node:assert/strict';
import { Board, Op } from '../shared/contracts/whiteboard.ts';
import { reviewBoard } from '../shared/whiteboard-anchor-core.ts';
import { layoutBoard, pinnedOffsetYAfterLeaving, pinnedOffsetYOf, placeBoardWithMemory } from '../shared/whiteboard-layout-core.ts';
import { boardSvgDocument } from '../shared/whiteboard-svg-core.ts';
import { applyBoardDiff, applyOps, stageOps } from '../shared/whiteboard-ops-core.ts';
import { applyLayoutDelta, createLayoutWorld, layoutOf } from '../shared/whiteboard-layout-engine.ts';
import { layoutBoardRemembered, pinPositionsOfBoard } from '../shared/whiteboard-layout-cache.ts';
import { patchTileIndex, tileIndexOf, tileKeysFor, tileOf } from '../shared/whiteboard-tile-core.ts';
import { generateBoardRecord } from '../harness/load-cost/whiteboard-board-generator.ts';
import { EMPTY_HISTORY, UNDO_LIMIT, recordEdit, takeStep, undoOpsOf } from '../shared/whiteboard-undo-core.ts';
import type { LaidOutElement, PlacedElement, Rect } from '../shared/whiteboard-layout-core.ts';

function box(id: string) {
  return { kind: 'box', id, title: `step ${id} with a longer title`, lines: [{ text: 'a body line long enough to wrap twice over' }] };
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

const crowdedBoard = Board.parse({
  id: 'crowded', title: 'crowded', version: 1, caption: null, createdAt: 0, updatedAt: 0,
  elements: {
    ...stacked([[box('a1'), box('a2')], [box('b1'), box('b2')], [box('c1'), box('c2'), box('c3')]], { stackGap: 200, boxGap: 160 }),
    n1: { kind: 'note', id: 'n1', on: 'b1', text: 'Outside authors stop here now; the author check runs before any docs request is built for them' },
    n2: { kind: 'note', id: 'n2', on: 'b1', text: 'A second note stacks under the first' },
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

function isNoteOnItsOwnBox(note: LaidOutElement, other: LaidOutElement): boolean {
  const stored = crowdedBoard.elements[note.id];
  return stored?.kind === 'note' && stored.on === other.id;
}

function isAllowedToTouch(first: LaidOutElement, second: LaidOutElement): boolean {
  if (first.kind === 'note' && isNoteOnItsOwnBox(first, second)) return true;
  if (second.kind === 'note' && isNoteOnItsOwnBox(second, first)) return true;
  if (first.kind === 'frame' && second.kind !== 'wire') return contains(first, second);
  if (second.kind === 'frame' && first.kind !== 'wire') return contains(second, first);
  return false;
}

test('notes stack beside their box and frames wrap their boxes without drawing over boxes they do not belong to', () => {
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

const wiredBoard = Board.parse({
  ...crowdedBoard,
  elements: {
    ...crowdedBoard.elements,
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
    const stored = wiredBoard.elements[laidOut.id];
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

function stepBox(id: string, title: string, linkedBoardId: string | null = null) {
  return { kind: 'box', id, title, step: { linkedBoardId } };
}

function dependency(fromId: string, toId: string) {
  return { kind: 'wire', id: `${fromId}-to-${toId}`, from: fromId, to: toId };
}

test('unplaced step boxes draw as a plan band above the free drawing, one level per column, and a dragged step leaves the band where it was dropped', () => {
  const plannedBoard = Board.parse({
    ...wiredBoard,
    elements: {
      ...wiredBoard.elements,
      diff: stepBox('diff', 'Diff index'), endpoint: stepBox('endpoint', 'Search endpoint'),
      backfill: stepBox('backfill', 'Index backfill', 'backfill-board'), searchbox: stepBox('searchbox', 'Search box'),
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
  assert.equal(backfill.step?.linkedBoardId, 'backfill-board');
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
  const draggedBoard = Board.parse({ ...plannedBoard, elements: { ...plannedBoard.elements, searchbox: { ...stepBox('searchbox', 'Search box'), at: droppedAt } } });
  const dragged = layoutBoard(draggedBoard).elements.find((element) => element.id === 'searchbox');
  assert.deepEqual(dragged?.kind === 'box' ? { x: dragged.x, y: dragged.y, label: dragged.step?.label } : null, { x: droppedAt.x, y: droppedAt.y + pinnedOffsetYOf(draggedBoard), label: '3' });
  for (const leaving of [[searchbox], [endpoint], [endpoint, backfill], [diff, endpoint, backfill, searchbox]]) {
    const leavingIds = new Set(leaving.map((laidOut) => laidOut.id));
    const leftBoard = Board.parse({ ...plannedBoard, elements: Object.fromEntries(Object.entries(plannedBoard.elements).map(([id, element]) => [id, leavingIds.has(id) && element.kind === 'box' ? { ...element, at: droppedAt } : element])) });
    assert.equal(pinnedOffsetYAfterLeaving(layout.plan, leaving), pinnedOffsetYOf(leftBoard), `the band left by ${[...leavingIds].join(', ')} matches a whole-board layout`);
  }
});

test('a step status that disagrees with the code session changes warns, changed files no ref covers come back as uncovered, and an unread code session says it was not checked', () => {
  const reviewedBoard = Board.parse({
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
    worthALookPaths: ['src/parse.ts', 'src/stray.ts'],
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
    worthALookPaths: ['src/parse.ts'],
    flaggedStepIds: ['early', 'shipped', 'quiet'],
    notChecked: null,
  });
  assert.equal(reviewBoard(reviewedBoard, { fileFactByPath, changes: { ...changes, error: 'git diff failed' } }).notChecked, 'the code session changes could not be read: git diff failed');
  assert.equal(reviewBoard(reviewedBoard, null).notChecked, 'code session builder is not running');

  const manyStrayChanges = { ...changes, changedPaths: Array.from({ length: 25 }, (_, index) => ({ path: `src/stray-${index}.ts`, isCommitted: true })) };
  const { uncoveredPaths } = reviewBoard(reviewedBoard, { fileFactByPath, changes: manyStrayChanges });
  assert.equal(uncoveredPaths.length, 20);
  assert.ok(uncoveredPaths.every((uncoveredPath) => uncoveredPath.startsWith('src/stray-')), uncoveredPaths.join(', '));
});

test('a near box sits beside its target and a near box whose target is missing warns by name', () => {
  const nearBoard = Board.parse({
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
  assert.ok(layout.warnings.includes('box stray sits near gone, which is not placed on the board'));
  assert.deepEqual(layout.warnings.filter((warning) => warning.includes('runs through')), []);

  const removed = applyOps(nearBoard, [{ op: 'remove', id: 'stop' }], { id: 'operator', name: 'operator' }, 0);
  assert.ok(removed.ok);
  const afterRemove = layoutBoard(removed.board);
  assert.deepEqual(afterRemove.elements.filter((element) => element.id === 'stop' || element.id === 'w1'), [], 'a layout after a put that removed a box with near boxes no longer draws the removed box or its wires');

  const addedThenRemoved = applyOps(nearBoard, [
    { op: 'add', element: Board.shape.elements.valueType.parse({ kind: 'box', id: 'temp', title: 'Temp', at: { x: 600, y: 300 } }) },
    { op: 'add', element: Board.shape.elements.valueType.parse({ kind: 'box', id: 'kid', title: 'Kid', near: { of: 'temp', side: 'right' } }) },
    { op: 'remove', id: 'temp' },
  ], { id: 'operator', name: 'operator' }, 0);
  assert.ok(addedThenRemoved.ok);
  const kid = addedThenRemoved.board.elements.kid;
  assert.ok(kid?.kind === 'box' && kid.near === null && kid.at !== null, 'a box placed near a box the same put adds and removes keeps a place on the board');

  const farFlung = Board.parse({ ...nearBoard, elements: { ...nearBoard.elements, far: { kind: 'box', id: 'far', title: 'Far', at: { x: 1e9, y: 1e9 } }, w2: wire('w2', 'plain', 'far') } });
  assert.ok(layoutBoard(farFlung).elements.some((element) => element.id === 'w2'), 'a wire to a box a billion units away lays out without walking every cell between');
});

test('wires keep their named sides, a back wire returns around the outside of the flow, and overlaps and crowding warn by name', () => {
  const loopBoard = Board.parse({
    id: 'loop', title: 'loop', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      ...stacked([[box('read')], [box('check')], [box('write')]]),
      aside: { kind: 'box', id: 'aside', title: 'Aside', near: { of: 'write', side: 'bottom' } },
      first: { kind: 'box', id: 'first', title: 'First', at: { x: 900, y: 600 } }, second: { kind: 'box', id: 'second', title: 'Second', at: { x: 920, y: 610 } },
      f1: { kind: 'frame', id: 'f1', title: 'each page', contains: ['read', 'check', 'write'], loop: true },
      w1: wire('w1', 'read', 'check'), w2: wire('w2', 'check', 'write'),
      w3: wire('w3', 'write', 'read', { back: true, label: 'next page' }),
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
  const back = wireById.get('w3');
  const low = boxById.get('low');
  const downward = wireById.get('w6');
  assert.ok(read && check && write && sided && back && low && downward);
  assert.deepEqual([downward.end.y, segmentsOfPath(downward.path).length], [low.y, 2], `a wire to a box wholly below it turns once into its top: ${downward.path}`);
  const level = wireById.get('w7');
  assert.ok(level);
  assert.equal(segmentsOfPath(level.path).length, 1, `a wire between boxes that share a height runs straight: ${level.path}`);
  const walled = wireById.get('w8');
  assert.ok(walled);
  assert.ok(segmentsOfPath(walled.path).length <= 3, `a wire whose facing side is walled off leaves from the side that turns least: ${walled.path}`);
  assert.equal(sided.start.y, read.y + read.height);
  assert.equal(sided.end.y, check.y + check.height);
  assert.ok(back.isBack && back.isDashed);
  const flowBottom = Math.max(read.y + read.height, check.y + check.height, write.y + write.height);
  const flowTop = Math.min(read.y, check.y, write.y);
  const innerPoints = segmentsOfPath(back.path).flatMap((segment) => [{ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 }])
    .filter((point) => point.y !== back.start.y && point.y !== back.end.y);
  assert.ok(innerPoints.every((point) => point.y > flowBottom || point.y < flowTop), `the back wire cuts through the forward flow: ${back.path}`);
  assert.ok(layout.elements.some((element) => element.kind === 'frame' && element.isLoop));
  assert.deepEqual(layout.warnings.filter((warning) => warning.includes('runs through')), []);
  assert.ok(layout.warnings.includes('box first overlaps box second'), layout.warnings.join('; '));
});

test('a dense board routes every wire around the boxes instead of drawing dog-legs', () => {
  const stacks: UnplacedBox[][] = Array.from({ length: 12 }, () => []);
  for (let index = 0; index < 170; index += 1) stacks[index % 12]?.push({ kind: 'box', id: `b${index}`, title: `box ${index}`, lines: [] });
  const elements = stacked(stacks, { stackGap: 160, boxGap: 30 });
  for (let index = 0; index < 600; index += 1) elements[`w${index}`] = { kind: 'wire', id: `w${index}`, from: `b${(index * 7) % 170}`, to: `b${(index * 13 + 5) % 170}` };
  const layout = layoutBoard(Board.parse({ id: 'dense', title: 'dense', version: 1, caption: null, createdAt: 0, updatedAt: 0, elements }));
  assert.deepEqual(layout.warnings.filter((warning) => warning.includes('found no clear route') || warning.includes('runs through')), [], layout.warnings.join('\n'));
  assert.equal(layout.elements.filter((element) => element.kind === 'wire').length, 600);
});

test('a wire past a box placed above the content top goes around that box, not through it', () => {
  const placedBox = (id: string, x: number) => ({ kind: 'box', id, title: id, lines: [{ text: 'one' }, { text: 'two' }, { text: 'three' }], at: { x, y: 40 } });
  const elements = { a: placedBox('a', 0), b: placedBox('b', 300), c: placedBox('c', 600), w: { kind: 'wire', id: 'w', from: 'a', to: 'c', fromSide: 'right', toSide: 'left' } };
  const layout = layoutBoard(Board.parse({ id: 'top', title: 'top', version: 1, caption: null, createdAt: 0, updatedAt: 0, elements }));
  assert.deepEqual(layout.warnings.filter((warning) => warning.includes('runs through') || warning.includes('found no clear route')), [], layout.warnings.join('\n'));
});

test('a decision fanning out to a stack of boxes keeps only the crossing its output order forces', () => {
  const fanBoard = Board.parse({
    id: 'fan', title: 'fan', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      ...stacked([
        [{ kind: 'box', id: 'pick', title: 'Disposition', shape: 'decision', outputs: [{ id: 'local', label: 'fix locally' }, { id: 'dismiss', label: 'dismiss w/ reason' }, { id: 'remote', label: 'fix remotely' }, { id: 'escalate', label: 'escalate' }] }],
        [
          { kind: 'box', id: 'session', title: 'Session on branch', lines: [{ text: 'spawn / message PR session', style: 'item' }, { text: 'new push re-enters Sources', muted: true, style: 'item' }] },
          { kind: 'box', id: 'reply', title: 'Reply + resolve', lines: [{ text: 'post operator reason', style: 'item' }, { text: 'resolve thread', style: 'item' }] },
          { kind: 'box', id: 'resolve', title: 'ReviewHog Resolve', lines: [{ text: 'run_mode: resolve_only', style: 'code' }, { text: 'owner opt-in required', muted: true, style: 'item' }, { text: 'only when no local push', muted: true, style: 'item' }] },
          { kind: 'box', id: 'waiting', title: 'Waiting card', lines: [{ text: 'dashboard + Telegram', style: 'item' }] },
        ],
      ], { stackGap: 260, boxGap: 30 }),
      w10: { kind: 'wire', id: 'w10', from: 'pick', to: 'session', fromOutput: 'local' },
      w11: { kind: 'wire', id: 'w11', from: 'pick', to: 'reply', fromOutput: 'dismiss' },
      w12: { kind: 'wire', id: 'w12', from: 'pick', to: 'resolve', fromOutput: 'remote', dashed: true },
      w13: { kind: 'wire', id: 'w13', from: 'pick', to: 'waiting', fromOutput: 'escalate', tone: 'fail' },
      open: { kind: 'note', id: 'open', on: 'pick', text: 'Open: does Resolve decline with a reason, or only fix? Decides if dismiss stays local-only.', author: 'PR bot triage' },
    },
  });
  const crossings = layoutBoard(fanBoard).warnings.filter((warning) => warning.includes('crosses wire'));
  assert.deepEqual(crossings, ['wire w12 crosses wire w13']);
});

test('a decision draws its outputs as rows in order and each output wire leaves from its own row, while a stray output is refused', () => {
  const decisionBoard = Board.parse({
    id: 'decide', title: 'decide', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      ...stacked([
        [{ kind: 'box', id: 'classify', title: 'Classify', shape: 'decision', outputs: [{ id: 'failed', label: 'failed' }, { id: 'clean', label: 'clean' }] }],
        [{ kind: 'box', id: 'stop', title: 'Stop' }, { kind: 'box', id: 'go', title: 'Continue' }],
      ]),
      w1: { kind: 'wire', id: 'w1', from: 'classify', to: 'go', fromOutput: 'clean' },
      w2: { kind: 'wire', id: 'w2', from: 'classify', to: 'stop', fromOutput: 'failed', tone: 'fail' },
    },
  });
  const layout = layoutBoard(decisionBoard);
  const decision = layout.elements.find((element) => element.id === 'classify');
  assert.ok(decision?.kind === 'box');
  const [failedOutput, cleanOutput] = decision.outputs;
  assert.deepEqual(decision.outputs.map((output) => output.id), ['failed', 'clean']);
  assert.ok(failedOutput && cleanOutput && failedOutput.port.y < cleanOutput.port.y);
  const wireStart = (wireId: string) => {
    const wire = layout.elements.find((element) => element.id === wireId);
    assert.ok(wire?.kind === 'wire');
    return wire.start;
  };
  assert.deepEqual(wireStart('w2'), failedOutput.port);
  assert.deepEqual(wireStart('w1'), cleanOutput.port);
  assert.equal(layout.warnings.filter((warning) => warning.includes('runs through')).length, 0, layout.warnings.join('\n'));
  const author = { id: 'agent', name: 'agent' };
  const missingOutput = applyOps(decisionBoard, [{ op: 'add', element: Board.shape.elements.valueType.parse({ kind: 'wire', id: 'w3', from: 'classify', to: 'stop', fromOutput: 'maybe' }) }], author, 0);
  assert.equal(missingOutput.ok ? '' : missingOutput.error, 'op 1: wire w3 starts at output maybe, which decision classify does not have');
  const droppedOutput = applyOps(decisionBoard, [{ op: 'set', id: 'classify', fields: { outputs: [{ id: 'failed', label: 'failed' }] } }], author, 0);
  assert.equal(droppedOutput.ok ? '' : droppedOutput.error, 'op 1: wire w1 still starts at output clean of classify, so change or remove that wire first');
  const plainWithOutputs = applyOps(decisionBoard, [{ op: 'set', id: 'stop', fields: { outputs: [{ id: 'x', label: 'x' }] } }], author, 0);
  assert.equal(plainWithOutputs.ok ? '' : plainWithOutputs.error, 'op 1: stop: only a decision has outputs, so set shape to decision');
});

test('styled lines carry their markers, a panel with no place stacks clear right of every box until it is given one, and the legend names the wire styles in use with custom labels winning', () => {
  const styledBoard = Board.parse({
    id: 'styled', title: 'styled', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    legend: [{ tone: 'fail', label: 'gives up' }, { tone: 'plain', back: true, label: 'retry' }, { tone: 'join', label: 'merges back' }],
    elements: {
      first: { kind: 'box', id: 'first', title: 'First', at: { x: 40, y: 40 }, lines: [
        { text: 'parse', style: 'numbered' }, { text: 'store', style: 'numbered' }, { text: 'a break' }, { text: 'again', style: 'numbered' },
        { text: '30s', style: 'kv', key: 'timeout' }, { text: 'npm test', style: 'code' }, { text: 'one point', style: 'item' },
      ] },
      second: { kind: 'box', id: 'second', title: 'Second', at: { x: 700, y: 200 } },
      aside: { kind: 'note', id: 'aside', on: 'second', text: 'a note that reaches right past the box edge' },
      prior: { kind: 'box', id: 'prior', title: 'Prior art', shape: 'panel', lines: [{ text: 'the old router', style: 'item' }] },
      w1: { kind: 'wire', id: 'w1', from: 'first', to: 'second', tone: 'fail' },
      w2: { kind: 'wire', id: 'w2', from: 'second', to: 'first', back: true },
    },
  });
  assert.throws(() => Board.parse({ ...styledBoard, elements: { ...styledBoard.elements, first: { ...styledBoard.elements.first, lines: [{ text: 'x', style: 'kv' }] } } }), /a kv line needs a key/);
  const layout = layoutBoard(styledBoard);
  const first = layout.elements.find((element) => element.id === 'first');
  assert.ok(first?.kind === 'box');
  assert.deepEqual(first.bodyLines.map((line) => line.marker), ['1.', '2.', null, '1.', 'timeout', null, null]);
  const panel = layout.elements.find((element) => element.id === 'prior');
  assert.ok(panel?.kind === 'box' && panel.shape === 'panel');
  const besidePanel = layout.elements.filter((element) => (element.kind === 'box' || element.kind === 'note') && element.id !== 'prior');
  assert.ok(besidePanel.every((element) => element.kind !== 'wire' && panel.x > element.x + element.width), `panel at ${panel.x} overlaps a box or note`);
  assert.deepEqual(layout.legend.map((row) => row.label), ['gives up', 'retry', 'merges back']);
  assert.equal(layout.warnings.filter((warning) => warning.includes('prior')).length, 0, layout.warnings.join('\n'));
  const author = { id: 'agent', name: 'agent' };
  const nearStacked = applyOps(styledBoard, [{ op: 'add', element: Board.shape.elements.valueType.parse({ kind: 'box', id: 'beside', title: 'Beside', near: { of: 'prior', side: 'bottom' } }) }], author, 0);
  assert.equal(nearStacked.ok ? '' : nearStacked.error, 'op 1: box beside sits near prior, a panel with no place yet, so give that panel a near or at first');
  const dragged = applyOps(styledBoard, [{ op: 'set', id: 'prior', fields: { at: { x: 40, y: 900 } } }], author, 0);
  assert.ok(dragged.ok, dragged.ok ? '' : dragged.error);
  const droppedPanel = layoutBoard(dragged.board).elements.find((element) => element.id === 'prior');
  assert.ok(droppedPanel?.kind === 'box');
  assert.deepEqual([droppedPanel.x, droppedPanel.y], [40, 900]);
  const withBoxNearPanel = applyOps(dragged.board, [{ op: 'add', element: Board.shape.elements.valueType.parse({ kind: 'box', id: 'beside', title: 'Beside', near: { of: 'prior', side: 'bottom' } }) }], author, 0);
  assert.ok(withBoxNearPanel.ok, withBoxNearPanel.ok ? '' : withBoxNearPanel.error);
  const restacked = applyOps(withBoxNearPanel.board, [{ op: 'set', id: 'prior', fields: { at: null } }], author, 0);
  assert.equal(restacked.ok ? '' : restacked.error, 'op 1: box beside sits near prior, so prior cannot go back to the panel stack with no place: keep a near or at on it, or move box beside first');
  assert.throws(() => Board.shape.elements.valueType.parse({ kind: 'panel', id: 'old', title: 'Old' }), /an element kind is box, frame, wire or note/);
});

test('a dashboard applying an edit diff reaches the server board exactly, and undoing it restores the board it started from, note authors and cascades included, while agents cannot forge a note author, and the history keeps only the newest entries', () => {
  const author = { id: 'operator', name: 'operator' };
  const decision = { kind: 'box', id: 'gate', title: 'gate', at: { x: 1200, y: 40 }, shape: 'decision', outputs: [{ id: 'ok', label: 'ok' }] };
  const before = applyOps(crowdedBoard, [
    { op: 'add', element: Board.shape.elements.valueType.parse(decision) },
    { op: 'add', element: Board.shape.elements.valueType.parse({ kind: 'wire', id: 'w1', from: 'gate', to: 'c1', fromOutput: 'ok' }) },
    { op: 'set', id: 'n1', fields: { author: 'agent-c' } },
    { op: 'set', id: 'n2', fields: { author: 'agent-c' } },
    { op: 'resolve', id: 'n2' },
  ], author, 1);
  assert.ok(before.ok);
  const agentNote = Board.shape.elements.valueType.parse({ kind: 'note', id: 'n3', on: 'gate', text: 'agent finding', author: 'forged' });
  const noted = applyOps(before.board, [{ op: 'add', element: agentNote }], { id: 'session-uuid', name: 'agent-a' }, 1);
  assert.ok(noted.ok);
  assert.equal(noted.board.elements.n3?.kind === 'note' && noted.board.elements.n3.author, 'agent-a');
  const forged = applyOps(noted.board, [{ op: 'set', id: 'n3', fields: { author: 'operator', resolvedBy: 'operator' } }], { id: 'session-uuid', name: 'agent-a' }, 1);
  assert.equal(forged.ok, false);
  const resolved = applyOps(noted.board, [{ op: 'resolve', id: 'n3' }], { id: 'other-uuid', name: 'agent-b' }, 1);
  assert.ok(resolved.ok);
  const start = resolved.board;
  const edits: Op[] = [
    { op: 'set', id: 'n3', fields: { text: 'rewritten by the operator' } },
    { op: 'remove', id: 'b1' },
    { op: 'set', id: 'gate', fields: { outputs: [], shape: 'box', title: 'renamed' } },
    { op: 'set', id: 'c2', fields: { near: null, at: { x: 1500, y: 600 } } },
    { op: 'board', title: 'renamed board', legend: [{ tone: 'fail', dashed: false, back: false, label: 'gives up' }], codeSessionId: 'builder-session' },
  ];
  const edited = applyOps(start, [{ op: 'remove', id: 'w1' }, ...edits], author, 2);
  assert.ok(edited.ok);
  assert.equal(JSON.stringify(applyBoardDiff(start, edited.diff, edited.board.version, edited.board.updatedAt)), JSON.stringify(edited.board));
  const undone = applyOps(edited.board, undoOpsOf(edited.before, edited.diff), author, 3);
  assert.ok(undone.ok, undone.ok ? '' : undone.error);
  const comparable = (board: Board) => ({ title: board.title, legend: board.legend, codeSessionId: board.codeSessionId, elements: board.elements });
  assert.deepEqual(comparable(undone.board), comparable(start));

  let history = EMPTY_HISTORY;
  for (let index = 0; index <= UNDO_LIMIT; index += 1) history = recordEdit(history, [{ op: 'remove', id: `edit-${index}` }]);
  assert.equal(history.undo.length, UNDO_LIMIT);
  assert.deepEqual(takeStep(history, 'undo')?.entry, [{ op: 'remove', id: `edit-${UNDO_LIMIT}` }]);
});

test('a dashboard keeps the server element order when an edit removes and re-adds ids', () => {
  const placedBox = (id: string) => ({ ...box(id), at: { x: 40, y: 40 } });
  const orderedBoard = (ids: string[]) => Board.parse({
    id: 'reorder', title: 'reorder', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: Object.fromEntries(ids.map((id) => [id, placedBox(id)])),
  });
  const readdingEdits: [string[], Op[]][] = [
    [['a', 'b', 'c'], [{ op: 'remove', id: 'a' }, { op: 'remove', id: 'c' }, { op: 'add', element: Board.shape.elements.valueType.parse(placedBox('a')) }, { op: 'add', element: Board.shape.elements.valueType.parse(placedBox('c')) }]],
    [['a', 'b'], [{ op: 'add', element: Board.shape.elements.valueType.parse(placedBox('n')) }, { op: 'remove', id: 'b' }, { op: 'add', element: Board.shape.elements.valueType.parse(placedBox('b')) }]],
  ];
  for (const [ids, edits] of readdingEdits) {
    const start = orderedBoard(ids);
    const edited = applyOps(start, edits, { id: 'operator', name: 'operator' }, 1);
    assert.ok(edited.ok, edited.ok ? '' : edited.error);
    assert.deepEqual(Object.keys(applyBoardDiff(start, edited.diff, edited.board.version, edited.board.updatedAt)?.elements ?? {}), Object.keys(edited.board.elements));
  }
});

test('a board with plan steps keys their statuses in the legend, and a board without them keeps the legend free of statuses', () => {
  const planBoard = Board.parse({
    id: 'plan', title: 'plan', version: 1, caption: null, createdAt: 0, updatedAt: 0, legend: [],
    elements: { step: { kind: 'box', id: 'step', title: 'Index the diffs', step: { status: 'building' } } },
  });
  const layout = layoutBoard(planBoard);
  assert.deepEqual(layout.legend.map((row) => row.label), ['plan step planned', 'plan step building', 'plan step landed']);
  const svg = boardSvgDocument(layout);
  for (const status of ['planned', 'building', 'landed']) assert.match(svg, new RegExp(`class="wb-legend-swatch wb-step-swatch wb-step-${status}"`));
  for (const status of ['planned', 'building', 'landed']) assert.match(svg, new RegExp(`\\.wb-step-${status} \\{ fill: #`), `the export colors the ${status} swatch`);
  const plainBoard = Board.parse({ ...planBoard, elements: { only: { kind: 'box', id: 'only', title: 'Only' } } });
  assert.deepEqual(layoutBoard(plainBoard).legend, []);
});

test('a box width rewraps its text and grows its picture, while an unsized box keeps the default and an out of range width is refused', () => {
  const picture = { kind: 'image' as const, asset: 'a'.repeat(64), mime: 'image/webp', width: 800, height: 400 };
  const sizedBoard = Board.parse({
    id: 'sized', title: 'sized', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      wide: { ...box('wide'), at: { x: 40, y: 40 }, width: 440, media: picture },
      narrow: { ...box('narrow'), near: { of: 'wide', side: 'bottom', gap: 30 } },
      next: { ...box('next'), near: { of: 'wide', side: 'right', gap: 90 } },
      free: { kind: 'box', id: 'free', title: 'Free', at: { x: 900, y: 400 }, width: 160, media: picture },
    },
  });
  const boxById = new Map(layoutBoard(sizedBoard).elements.flatMap((element) => (element.kind === 'box' ? [[element.id, element] as const] : [])));
  const wide = boxById.get('wide');
  const narrow = boxById.get('narrow');
  const next = boxById.get('next');
  const free = boxById.get('free');
  assert.ok(wide && narrow && next && free);
  assert.equal(narrow.width, 220, 'a box with no width keeps the default');
  assert.equal(wide.width, 440);
  assert.equal(wide.titleLines.length, 1, 'a wider box wraps its title to its width');
  assert.equal(narrow.titleLines.length, 2);
  assert.deepEqual([wide.media?.width, wide.media?.height], [416, 208], 'the picture fills the wider inner width');
  assert.deepEqual([free.media?.width, free.media?.height], [136, 68]);
  assert.equal(next.x, wide.x + wide.width + 90, 'a box beside the widened one clears its new width');
  const refused = applyOps(sizedBoard, [{ op: 'set', id: 'narrow', fields: { width: 2000 } }], { id: 'agent', name: 'agent' }, 0);
  assert.equal(refused.ok ? '' : refused.error, 'op 1: narrow: a box width is 160 to 960');
});

test('a layout world kept across puts places what a fresh layout places, and its patched tile index paints what a fresh index paints', () => {
  let { board } = generateBoardRecord({ elementCount: 400, seed: 7, boardId: 'kept', title: 'kept', createdAt: 0 });
  const author = { id: 'operator', name: 'operator' };
  let world = createLayoutWorld(board, null, 0);
  const tileIndex = tileIndexOf(layoutOf(world), board.version, board);
  const pinnedBoxes = Object.values(board.elements).flatMap((element) => (element.kind === 'box' && element.at ? [element] : []));
  const [moved, noted, framed, removed, wired] = pinnedBoxes;
  const anyNote = Object.values(board.elements).find((element) => element.kind === 'note');
  assert.ok(moved?.at && noted && framed && removed && wired && anyNote);
  const puts = [
    [{ op: 'set', id: moved.id, fields: { at: { x: moved.at.x + 180, y: moved.at.y + 60 } } }],
    [{ op: 'add', element: { kind: 'note', id: 'kept-note', on: noted.id, text: 'a note added after the first layout' } }],
    [{ op: 'add', element: { kind: 'note', id: '5', on: noted.id, text: 'a note whose id the board object lists first' } }],
    [{ op: 'remove', id: anyNote.id }],
    [{ op: 'add', element: { kind: 'box', id: 'kept-near', title: 'beside', near: { of: noted.id, side: 'right' } } }],
    [{ op: 'add', element: { kind: 'frame', id: 'kept-frame', title: 'kept frame', contains: [framed.id, moved.id] } }],
    [{ op: 'add', element: { kind: 'wire', id: 'kept-wire', from: wired.id, to: noted.id, label: 'kept' } }],
    [{ op: 'set', id: noted.id, fields: { title: 'a much longer title that wraps over several lines of the box' } }],
    [{ op: 'remove', id: removed.id }],
  ];
  for (const ops of puts) {
    const staged = stageOps(board, ops.map((op) => Op.parse(op)), author, 0, null);
    assert.ok(staged.ok, staged.ok ? '' : staged.error);
    const changes = new Map(Object.entries(staged.diff.elements).map(([id, change]) => [id, { before: board.elements[id], after: staged.afterById.get(id) ?? null, isAppended: change[0] === 'put' }]));
    staged.commit();
    board = staged.board;
    const applied = applyLayoutDelta(world, board, changes);
    assert.equal(applied.delta.isRebuilt, false);
    world = applied.world;
    patchTileIndex(tileIndex, board, { version: board.version, chrome: world.chrome, changed: applied.delta.changed, removedIds: applied.delta.removedIds, recordChangedIds: [...changes.keys()] });
  }
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

test('removing a box on a small remembered board pins the boxes placed near it where they were drawn', () => {
  const board = Board.parse({
    id: 'small-pin', title: 'small pin', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    elements: {
      anchor: { kind: 'box', id: 'anchor', title: 'Anchor', at: { x: 40, y: 40 } },
      follower: { kind: 'box', id: 'follower', title: 'Follower', near: { of: 'anchor', side: 'right' } },
    },
  });
  const drawnFollower = layoutBoardRemembered(board).elements.find((element) => element.id === 'follower');
  assert.ok(drawnFollower?.kind === 'box');
  const staged = stageOps(board, [Op.parse({ op: 'remove', id: 'anchor' })], { id: 'operator', name: 'operator' }, 0, pinPositionsOfBoard(board));
  assert.ok(staged.ok);
  const follower = staged.afterById.get('follower');
  assert.ok(follower?.kind === 'box');
  assert.equal(follower.near, null);
  assert.deepEqual(follower.at, { x: drawnFollower.x, y: drawnFollower.y });
});
