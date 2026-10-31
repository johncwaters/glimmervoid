import test from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../shared/contracts/whiteboard.ts';
import { layoutBoard } from '../shared/whiteboard-layout-core.ts';
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
