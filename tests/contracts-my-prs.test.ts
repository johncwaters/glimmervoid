import test from 'node:test';
import assert from 'node:assert/strict';
import { MyPr, MyPrSearchNode, MyPrSearchResponse, MyPrsStatus } from '../shared/contracts/my-prs.ts';
import { ServerMessage, SERVER_MESSAGE_TYPES } from '../shared/contracts/control-messages.ts';

test('my PR contracts reject malformed reports and register the control message', () => {
  const status = { type: 'my-prs-status', ts: 1, configured: false, viewer: null, prs: [], error: null };
  assert.deepEqual(MyPrsStatus.parse(status), status);
  assert.equal(ServerMessage.safeParse(status).success, true);
  assert.equal(SERVER_MESSAGE_TYPES.includes('my-prs-status'), true);
  assert.equal(MyPrsStatus.safeParse({ ...status, prs: [{}] }).success, false);
  assert.equal(MyPrSearchResponse.safeParse({ data: { open: { nodes: [] }, merged: { nodes: [] } } }).success, true);
  assert.equal(MyPrSearchNode.safeParse({ number: 1 }).success, false);
  assert.equal(MyPr.safeParse({ key: 'wrong' }).success, false);
});
