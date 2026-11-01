import test from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../shared/contracts/whiteboard.ts';
import { reviewBoard } from '../shared/whiteboard-anchor-core.ts';
import { layoutBoard } from '../shared/whiteboard-layout-core.ts';
import { applyOps } from '../shared/whiteboard-ops-core.ts';
import { EMPTY_HISTORY, UNDO_LIMIT, inverseOps, recordEdit, takeStep } from '../shared/whiteboard-undo-core.ts';
import type { Op } from '../shared/contracts/whiteboard.ts';
import type { LaidOutElement, Rect } from '../shared/whiteboard-layout-core.ts';

function box(id: string, column: string, order: number) {
  return { kind: 'box', id, title: `step ${id} with a longer title`, lines: [{ text: 'a body line long enough to wrap twice over' }], column, order };
}

const crowdedBoard = Board.parse({
  id: 'crowded', title: 'crowded', version: 1, caption: null, createdAt: 0, updatedAt: 0, lanes: [],
  columns: [{ id: 'a', title: 'Triggers' }, { id: 'b', title: 'Adapters plus merge check, no agent' }, { id: 'c', title: 'Intake, one request shape for all' }],
  elements: {
    a1: box('a1', 'a', 0), a2: box('a2', 'a', 1),
    b1: box('b1', 'b', 0), b2: box('b2', 'b', 1),
    c1: box('c1', 'c', 0), c2: box('c2', 'c', 1), c3: box('c3', 'c', 2),
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

test('notes, frames and wrapped column titles never draw over boxes they do not belong to', () => {
  const layout = layoutBoard(crowdedBoard);
  const placed = layout.elements.filter((element) => element.kind !== 'wire');
  for (const [index, first] of placed.entries()) {
    for (const second of placed.slice(index + 1)) {
      if (!overlaps(first, second)) continue;
      assert.ok(isAllowedToTouch(first, second), `${first.id} overlaps ${second.id}`);
    }
  }
  const headerBottom = Math.max(...layout.columns.map((column) => column.ruleY));
  for (const element of placed) assert.ok(element.y > headerBottom, `${element.id} starts inside the column header`);
  for (const column of layout.columns) {
    const nextColumn = layout.columns[layout.columns.indexOf(column) + 1];
    if (!nextColumn) continue;
    for (const line of column.titleLines) assert.ok(column.x + line.length * 9 < nextColumn.x, `"${line}" runs into the next column`);
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

function unit(id: string, title: string, after: string[] = [], linkedBoardId: string | null = null) {
  return { kind: 'unit', id, title, after, linkedBoardId };
}

test('units draw as a plan band above the freeform columns, one level per column with an arrow per dependency', () => {
  const plannedBoard = Board.parse({
    ...wiredBoard,
    elements: {
      ...wiredBoard.elements,
      diff: unit('diff', 'Diff index'), endpoint: unit('endpoint', 'Search endpoint', ['diff']),
      backfill: unit('backfill', 'Index backfill', ['diff'], 'backfill-board'), searchbox: unit('searchbox', 'Search box', ['endpoint', 'diff']),
      pinned: { ...box('pinned', 'a', 9), at: { x: 40, y: 90 } },
    },
  });
  const layout = layoutBoard(plannedBoard);
  const units = layout.elements.flatMap((element) => (element.kind === 'unit' ? [element] : []));
  const unitById = new Map(units.map((laidOut) => [laidOut.id, laidOut]));
  assert.deepEqual(units.map((laidOut) => laidOut.label).sort(), ['1', '2a', '2b', '3']);
  const [diff, endpoint, backfill, searchbox] = ['diff', 'endpoint', 'backfill', 'searchbox'].map((id) => unitById.get(id));
  assert.ok(diff && endpoint && backfill && searchbox);
  assert.ok(diff.x < endpoint.x && endpoint.x === backfill.x && endpoint.x < searchbox.x, 'each level is its own column, left to right');
  assert.equal(backfill.linkedBoardId, 'backfill-board');
  assert.equal(layout.plan?.arrowPaths.length, 4);
  const bandBottom = Math.max(...units.map((laidOut) => laidOut.y + laidOut.height));
  for (const column of layout.columns) assert.ok(column.titleBaselineY > bandBottom, `column ${column.id} starts inside the plan band`);
  const placed = layout.elements.filter((element) => element.kind !== 'wire');
  for (const laidOut of units) {
    for (const other of placed) {
      if (other.id !== laidOut.id) assert.ok(!overlaps(laidOut, other), `${laidOut.id} overlaps ${other.id}`);
    }
  }
  assert.equal(layoutBoard(wiredBoard).plan, null);
});

test('a unit status that disagrees with the code session changes warns, changed files no ref covers come back as uncovered, and an unread code session says it was not checked', () => {
  const reviewedBoard = Board.parse({
    id: 'reviewed', title: 'reviewed', version: 1, caption: null, createdAt: 0, updatedAt: 0, lanes: [], columns: [], codeSessionId: 'builder',
    elements: {
      early: { kind: 'unit', id: 'early', title: 'Started too soon', status: 'planned', refs: ['src/parse.ts#L4'] },
      shipped: { kind: 'unit', id: 'shipped', title: 'Shipped', status: 'landed', refs: ['./src/save.ts', 'src//index.ts'] },
      quiet: { kind: 'unit', id: 'quiet', title: 'Not started', status: 'landed', refs: ['src/later.ts'] },
      parse: { kind: 'box', id: 'parse', title: 'Parse', column: 'intake', refs: ['src/parse.ts'] },
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
    unitWarnings: [
      'unit early is planned but src/parse.ts already changed',
      'unit shipped is landed but src/index.ts has uncommitted changes',
      'unit quiet is landed but src/later.ts is unchanged',
    ],
    uncoveredPaths: ['src/stray.ts'],
    worthALookPaths: ['src/parse.ts'],
    flaggedUnitIds: ['early', 'shipped', 'quiet'],
    notChecked: null,
  });
  assert.equal(reviewBoard(reviewedBoard, { fileFactByPath, changes: { ...changes, error: 'git diff failed' } }).notChecked, 'the code session changes could not be read: git diff failed');
  assert.equal(reviewBoard(reviewedBoard, null).notChecked, 'code session builder is not running');

  const manyStrayChanges = { ...changes, changedPaths: Array.from({ length: 25 }, (_, index) => ({ path: `src/stray-${index}.ts`, isCommitted: true })) };
  const { uncoveredPaths } = reviewBoard(reviewedBoard, { fileFactByPath, changes: manyStrayChanges });
  assert.equal(uncoveredPaths.length, 20);
  assert.ok(uncoveredPaths.every((uncoveredPath) => uncoveredPath.startsWith('src/stray-')), uncoveredPaths.join(', '));
});

test('laned boxes stack in their own labeled row band and a near box sits beside its target', () => {
  const lanedBoard = Board.parse({
    id: 'laned', title: 'laned', version: 1, caption: null, createdAt: 0, updatedAt: 0,
    columns: [{ id: 'a', title: 'Intake' }, { id: 'b', title: 'Apply' }],
    lanes: [{ id: 'main', label: 'Main', color: 'blue' }, { id: 'exits', label: 'Exits', color: 'orange' }],
    elements: {
      plain: box('plain', 'a', 0),
      parse: { ...box('parse', 'a', 1), lane: 'main' }, apply: { ...box('apply', 'b', 1), lane: 'main' },
      stop: { ...box('stop', 'b', 2), lane: 'exits' },
      aside: { kind: 'box', id: 'aside', title: 'Prior art', near: { of: 'stop', side: 'right' } },
      stray: { kind: 'box', id: 'stray', title: 'Stray', near: { of: 'gone', side: 'left' } },
      w1: wire('w1', 'parse', 'stop'),
    },
  });
  const layout = layoutBoard(lanedBoard);
  const boxById = new Map(layout.elements.flatMap((element) => (element.kind === 'box' ? [[element.id, element] as const] : [])));
  assert.deepEqual(layout.bands.map((band) => band.label), ['', 'Main', 'Exits']);
  const [unlaned, main, exits] = layout.bands;
  assert.ok(unlaned && main && exits);
  const plain = boxById.get('plain');
  const parse = boxById.get('parse');
  const stop = boxById.get('stop');
  const aside = boxById.get('aside');
  assert.ok(plain && parse && stop && aside);
  assert.ok(plain.y + plain.height <= main.y && parse.y > main.y && parse.y + parse.height <= exits.y && stop.y > exits.y, 'each lane is its own row band, top to bottom');
  assert.equal(aside.x, stop.x + stop.width + 60);
  assert.equal(aside.y + aside.height / 2, stop.y + stop.height / 2);
  assert.ok(layout.warnings.includes('box stray sits near gone, which is not placed on the board'));
  assert.deepEqual(layout.warnings.filter((warning) => warning.includes('runs through')), []);
});

test('wires keep their named sides, a back wire returns around the outside of the flow, and overlaps and crowding warn by name', () => {
  const loopBoard = Board.parse({
    id: 'loop', title: 'loop', version: 1, caption: null, createdAt: 0, updatedAt: 0, lanes: [],
    columns: [{ id: 'a', title: 'Read' }, { id: 'b', title: 'Check' }, { id: 'c', title: 'Write' }],
    elements: {
      read: box('read', 'a', 0), check: box('check', 'b', 0), write: box('write', 'c', 0),
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

test('a board with more wires than one routing pass can place draws the rest as dog-legs and says so', () => {
  const columns = Array.from({ length: 12 }, (_, index) => ({ id: `c${index}`, title: `column ${index}` }));
  const elements: Record<string, unknown> = {};
  for (let index = 0; index < 170; index += 1) elements[`b${index}`] = { kind: 'box', id: `b${index}`, title: `box ${index}`, lines: [], column: `c${index % 12}`, order: Math.floor(index / 12) };
  for (let index = 0; index < 600; index += 1) elements[`w${index}`] = { kind: 'wire', id: `w${index}`, from: `b${(index * 7) % 170}`, to: `b${(index * 13 + 5) % 170}` };
  const layout = layoutBoard(Board.parse({ id: 'dense', title: 'dense', version: 1, caption: null, createdAt: 0, updatedAt: 0, lanes: [], columns, elements }));
  assert.ok(layout.warnings.some((warning) => warning.includes('more wires than fit in one routing pass')), layout.warnings.join('\n'));
  assert.equal(layout.elements.filter((element) => element.kind === 'wire').length, 600);
});

test('a decision draws its outputs as rows in order and each output wire leaves from its own row, while a stray output is refused', () => {
  const decisionBoard = Board.parse({
    id: 'decide', title: 'decide', version: 1, caption: null, createdAt: 0, updatedAt: 0, lanes: [],
    columns: [{ id: 'a', title: 'In' }, { id: 'b', title: 'Out' }],
    elements: {
      classify: { kind: 'box', id: 'classify', title: 'Classify', column: 'a', shape: 'decision', outputs: [{ id: 'failed', label: 'failed' }, { id: 'clean', label: 'clean' }] },
      stop: { kind: 'box', id: 'stop', title: 'Stop', column: 'b', order: 0 },
      go: { kind: 'box', id: 'go', title: 'Continue', column: 'b', order: 1 },
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
  assert.equal(plainWithOutputs.ok ? '' : plainWithOutputs.error, 'op 1: box stop has outputs, which only a decision has, so set shape to decision');
});

test('styled lines carry their markers, a panel sits clear right of every box, and the legend names the wire styles in use with custom labels winning', () => {
  const styledBoard = Board.parse({
    id: 'styled', title: 'styled', version: 1, caption: null, createdAt: 0, updatedAt: 0, lanes: [],
    columns: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    legend: [{ tone: 'fail', label: 'gives up' }, { tone: 'plain', back: true, label: 'retry' }, { tone: 'join', label: 'merges back' }],
    elements: {
      first: { kind: 'box', id: 'first', title: 'First', column: 'a', lines: [
        { text: 'parse', style: 'numbered' }, { text: 'store', style: 'numbered' }, { text: 'a break' }, { text: 'again', style: 'numbered' },
        { text: '30s', style: 'kv', key: 'timeout' }, { text: 'npm test', style: 'code' }, { text: 'one point', style: 'item' },
      ] },
      second: { kind: 'box', id: 'second', title: 'Second', column: 'b', at: { x: 700, y: 200 } },
      aside: { kind: 'note', id: 'aside', on: 'second', text: 'a note that reaches right past the box edge' },
      prior: { kind: 'panel', id: 'prior', title: 'Prior art', lines: [{ text: 'the old router', style: 'item' }] },
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
  assert.ok(panel?.kind === 'panel');
  const besidePanel = layout.elements.filter((element) => element.kind === 'box' || element.kind === 'note');
  assert.ok(besidePanel.every((element) => panel.x > element.x + element.width), `panel at ${panel.x} overlaps a box or note`);
  assert.deepEqual(layout.legend.map((row) => row.label), ['gives up', 'retry', 'merges back']);
  assert.equal(layout.warnings.filter((warning) => warning.includes('panel')).length, 0, layout.warnings.join('\n'));
});

test('undoing an operator edit restores the board it started from, note authors, cascades and column moves included, while agents cannot forge a note author, and the history keeps only the newest entries', () => {
  const author = { id: 'operator', name: 'operator' };
  const decision = { kind: 'box', id: 'gate', title: 'gate', column: 'c', shape: 'decision', outputs: [{ id: 'ok', label: 'ok' }] };
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
    { op: 'columns', columns: [{ id: 'a', title: 'Triggers' }, { id: 'z', title: 'merged' }], move: { b: 'z', c: 'z' } },
    { op: 'board', title: 'renamed board', legend: [{ tone: 'fail', dashed: false, back: false, label: 'gives up' }], codeSessionId: 'builder-session' },
  ];
  const edited = applyOps(start, [{ op: 'remove', id: 'w1' }, ...edits], author, 2);
  assert.ok(edited.ok);
  const undone = applyOps(edited.board, inverseOps(start, [{ op: 'remove', id: 'w1' }, ...edits]), author, 3);
  assert.ok(undone.ok, undone.ok ? '' : undone.error);
  const comparable = (board: Board) => ({ title: board.title, columns: board.columns, legend: board.legend, codeSessionId: board.codeSessionId, elements: board.elements });
  assert.deepEqual(comparable(undone.board), comparable(start));

  let history = EMPTY_HISTORY;
  for (let index = 0; index <= UNDO_LIMIT; index += 1) history = recordEdit(history, [{ op: 'remove', id: `edit-${index}` }]);
  assert.equal(history.undo.length, UNDO_LIMIT);
  assert.deepEqual(takeStep(history, 'undo')?.entry, [{ op: 'remove', id: `edit-${UNDO_LIMIT}` }]);
});
