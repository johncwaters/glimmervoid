import test from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../shared/contracts/whiteboard.ts';
import { layoutBoard } from '../public/whiteboard/board-layout-core.ts';
import type { LaidOutElement, Rect } from '../public/whiteboard/board-layout-core.ts';

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
