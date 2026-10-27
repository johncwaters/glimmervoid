import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DataClientMessage,
  PtySizeFrame,
  VIEWER_MAX_COLS,
  VIEWER_MAX_ROWS,
  VIEWER_MIN_COLS,
  VIEWER_MIN_ROWS,
  parseDataAttach,
  parseDataServerFrame,
} from '../shared/contracts/data-messages.ts';
import { isApplicableViewerSize } from '../server/core/viewer-size-core.ts';

test('the claim bounds are one definition, shared with the size core', () => {
  assert.equal(isApplicableViewerSize(VIEWER_MIN_COLS, VIEWER_MIN_ROWS), true);
  assert.equal(isApplicableViewerSize(VIEWER_MAX_COLS, VIEWER_MAX_ROWS), true);
  assert.equal(isApplicableViewerSize(VIEWER_MAX_COLS + 1, VIEWER_MAX_ROWS), false);
  assert.equal(isApplicableViewerSize(VIEWER_MAX_COLS, VIEWER_MAX_ROWS + 1), false);
  assert.equal(DataClientMessage.safeParse({ type: 'claim', cols: VIEWER_MAX_COLS, rows: VIEWER_MAX_ROWS }).success, true);
  assert.equal(DataClientMessage.safeParse({ type: 'claim', cols: VIEWER_MAX_COLS + 1, rows: 24 }).success, false);
  assert.equal(DataClientMessage.safeParse({ type: 'claim', cols: 80, rows: VIEWER_MAX_ROWS + 1 }).success, false);
});

test('input carries no length cap, so the operator-facing paste error still speaks', () => {
  const parsed = DataClientMessage.safeParse({ type: 'input', data: 'x'.repeat(65536) });
  assert.equal(parsed.success, true);
});

test('the pty-size and output-beat frames are the only structured server-to-client shapes', () => {
  assert.equal(PtySizeFrame.safeParse({ type: 'pty-size', cols: 80, rows: 24, seq: 0 }).success, true);
  assert.equal(PtySizeFrame.safeParse({ type: 'pty-size', cols: 80, rows: 24, seq: -1 }).success, false);
  assert.equal(PtySizeFrame.safeParse({ type: 'pty-size', cols: 80, rows: 24 }).success, false);
  assert.equal(PtySizeFrame.safeParse({ type: 'size', cols: 80, rows: 24, seq: 1 }).success, false);
});

test('parseDataServerFrame decodes both directions of the wire contract the same way', () => {
  assert.equal(parseDataServerFrame('{ not json'), null);
  assert.equal(parseDataServerFrame(''), null);
  assert.equal(parseDataServerFrame('{"type":"pty-size","cols":80,"rows":24}'), null);
  assert.equal(parseDataServerFrame(`{"type":"pty-size","cols":${VIEWER_MAX_COLS + 1},"rows":24,"seq":1}`), null);
  assert.deepEqual(
    parseDataServerFrame('{"type":"pty-size","cols":80,"rows":24,"seq":3}'),
    { type: 'pty-size', cols: 80, rows: 24, seq: 3 },
  );
  assert.deepEqual(parseDataServerFrame('{"type":"output-beat"}'), { type: 'output-beat' });
});

test('only explicit flags on the attach URL ask for deep history or paused output', () => {
  assert.equal(parseDataAttach('/terminals/abc?history=deep&token=t').history, 'deep');
  assert.equal(parseDataAttach('/terminals/abc?token=t&history=deep').history, 'deep');
  assert.equal(parseDataAttach('/terminals/abc?token=t').history, 'screen');
  assert.equal(parseDataAttach('/terminals/abc?history=everything').history, 'screen');
  assert.deepEqual(parseDataAttach(undefined), { history: 'screen', isOutputPaused: false });
  assert.equal(parseDataAttach('/terminals/abc?output=paused&token=t').isOutputPaused, true);
  assert.equal(parseDataAttach('/terminals/abc?output=live').isOutputPaused, false);
});
