import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage } from '../shared/contracts/control-messages.ts';
import { createChatFeed } from '../public/chat/chat-feed.ts';

type PagePayload = { id: string; after: number } | { id: string; endingAt: number | 'tail' };

function traceReply(start: number, next: number): ServerMessage {
  return { type: 'session-trace-response', id: 'session', requestId: 'request', records: [], start, next, reset: false, path: '' };
}

function createDeferredPages() {
  const requests: { payload: PagePayload; settle: (reply: ServerMessage) => void }[] = [];
  const requestPage = (payload: PagePayload) => new Promise<ServerMessage>((resolve) => { requests.push({ payload, settle: resolve }); });
  const settleNext = async (reply: ServerMessage) => {
    const request = requests.shift();
    assert.ok(request, 'a page request is in flight');
    request.settle(reply);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { requests, requestPage, settleNext };
}

test('a near-top request that arrives while a live refresh is in flight loads the earlier page once that refresh settles', async () => {
  const pages = createDeferredPages();
  const feed = createChatFeed({
    sessionId: 'session',
    workingDirectory: null,
    requestPage: pages.requestPage,
    onPartsChanged: () => {},
    onBeats: () => {},
    onSubagents: () => {},
    isTurnOver: () => true,
    onReset: () => {},
    onRebuilt: () => {},
    onFailure: () => {},
  });
  feed.refresh();
  await pages.settleNext(traceReply(500, 900));
  feed.refresh();
  feed.loadEarlier();
  await pages.settleNext(traceReply(900, 900));

  assert.deepEqual(pages.requests.map((request) => request.payload), [{ id: 'session', endingAt: 500 }]);
});
