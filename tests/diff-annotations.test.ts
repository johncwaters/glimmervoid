import test from 'node:test';
import assert from 'node:assert/strict';

import type { DiffAnnotation } from '../shared/contracts/control-messages.ts';
import { DIFF_ANNOTATION_NOTE_MAX_CHARS } from '../shared/contracts/control-messages.ts';
import { formatDiffAnnotationMessage, sortAnnotations } from '../server/core/diff-annotations-core.ts';

const ESCAPE_CHARACTER = String.fromCharCode(27);

function annotation(
  path: string,
  line: number,
  note: string,
  side: DiffAnnotation['side'] = 'new',
  section: DiffAnnotation['section'] = 'uncommitted',
): DiffAnnotation {
  return { section, path, line, side, note };
}

test('formatDiffAnnotationMessage writes the header, one sorted entry per note, and the closing line', () => {
  const message = formatDiffAnnotationMessage([
    annotation('server/index.ts', 12, 'this leaks the timer'),
    annotation('public/app.ts', 40, 'name this after the domain'),
    annotation('public/app.ts', 7, 'drop the dead branch', 'old'),
  ]);

  assert.equal(message, [
    'Operator review notes on the current worktree diff:',
    '- public/app.ts:7 (uncommitted) (removed line) drop the dead branch',
    '- public/app.ts:40 (uncommitted) name this after the domain',
    '- server/index.ts:12 (uncommitted) this leaks the timer',
    'Address each note, then reply with what changed.',
  ].join('\n'));
});

test('formatDiffAnnotationMessage keeps the two sides of one line apart in the rendered entries', () => {
  const message = formatDiffAnnotationMessage([
    annotation('a.ts', 3, 'about the new line'),
    annotation('a.ts', 3, 'about the removed line', 'old'),
  ]);

  assert.equal(message.split('\n')[1], '- a.ts:3 (uncommitted) about the new line');
  assert.equal(message.split('\n')[2], '- a.ts:3 (uncommitted) (removed line) about the removed line');
});

test('formatDiffAnnotationMessage names the diff section each note was drafted against', () => {
  const message = formatDiffAnnotationMessage([
    annotation('a.ts', 3, 'against base..HEAD', 'new', 'committed'),
    annotation('a.ts', 3, 'against the worktree', 'new', 'uncommitted'),
  ]);

  assert.deepEqual(message.split('\n').slice(1, 3), [
    '- a.ts:3 (committed) against base..HEAD',
    '- a.ts:3 (uncommitted) against the worktree',
  ]);
});

test('formatDiffAnnotationMessage returns an empty message for no notes', () => {
  assert.equal(formatDiffAnnotationMessage([]), '');
});

test('formatDiffAnnotationMessage strips the bracketed paste terminator from the path and the note', () => {
  const message = formatDiffAnnotationMessage([
    annotation(`a${ESCAPE_CHARACTER}[201~.ts`, 5, `note${ESCAPE_CHARACTER}[201~ text`),
  ]);

  assert.equal(message.includes(ESCAPE_CHARACTER), false);
  assert.equal(message.split('\n')[1], '- a [201~.ts:5 (uncommitted) note [201~ text');
});

test('formatDiffAnnotationMessage caps a note at the contract note limit', () => {
  const message = formatDiffAnnotationMessage([
    annotation('a.ts', 1, 'x'.repeat(DIFF_ANNOTATION_NOTE_MAX_CHARS + 50)),
  ]);
  const note = message.split('\n')[1].split(' (uncommitted) ')[1];

  assert.equal(note.length, DIFF_ANNOTATION_NOTE_MAX_CHARS);
  assert.equal(note.endsWith('...'), true);
});

test('formatDiffAnnotationMessage drops a note that scrubs down to nothing', () => {
  assert.equal(formatDiffAnnotationMessage([annotation('a.ts', 1, ESCAPE_CHARACTER)]), '');
});

test('sortAnnotations orders by path, then line, then side', () => {
  const sorted = sortAnnotations([
    annotation('b.ts', 2, 'four'),
    annotation('a.ts', 10, 'three'),
    annotation('a.ts', 2, 'two', 'old'),
    annotation('a.ts', 2, 'one'),
  ]);

  assert.deepEqual(sorted.map((entry) => [entry.path, entry.line, entry.side]), [
    ['a.ts', 2, 'new'],
    ['a.ts', 2, 'old'],
    ['a.ts', 10, 'new'],
    ['b.ts', 2, 'new'],
  ]);
});
