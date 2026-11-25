import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage } from '../shared/contracts/control-messages.ts';
import type { TraceRecord } from '../shared/contracts/trace.ts';
import type { ChatPart } from '../public/chat/chat-part.ts';
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

function createFeedOver(pages: ReturnType<typeof createDeferredPages>) {
  return createChatFeed({
    sessionId: 'session',
    workingDirectory: null,
    requestPage: pages.requestPage,
    onPartsChanged: () => {},
    onBeats: () => {},
    isTurnOver: () => true,
    onReset: () => {},
    onRebuilt: () => {},
    onFailure: () => {},
  });
}

test('a caught-up callback waits until a forward read reaches the end of the trace, past a full page of backlog', async () => {
  const pages = createDeferredPages();
  const feed = createFeedOver(pages);
  feed.refresh();
  await pages.settleNext(traceReply(0, 500));
  let caughtUpCount = 0;
  feed.whenCaughtUp(() => { caughtUpCount += 1; });
  feed.refresh();
  await pages.settleNext(traceReply(500, 900));

  assert.equal(caughtUpCount, 0);
  assert.deepEqual(pages.requests.map((request) => request.payload), [{ id: 'session', after: 900 }]);
  await pages.settleNext(traceReply(900, 900));
  assert.equal(caughtUpCount, 1);
});

test('a near-top request that arrives while a live refresh is in flight loads the earlier page once that refresh settles', async () => {
  const pages = createDeferredPages();
  const feed = createFeedOver(pages);
  feed.refresh();
  await pages.settleNext(traceReply(500, 900));
  feed.refresh();
  feed.loadEarlier();
  await pages.settleNext(traceReply(900, 900));

  assert.deepEqual(pages.requests.map((request) => request.payload), [{ id: 'session', endingAt: 500 }]);
});

function promptRecord(text: string, ts: number): TraceRecord {
  return { ts, uuid: null, parentUuid: null, vendorSessionId: 'vendor', kind: 'prompt', text };
}

function restartRecord(startsNewConversation: boolean, ts: number): TraceRecord {
  return { ts, uuid: null, parentUuid: null, vendorSessionId: 'vendor', kind: 'restart', startsNewConversation };
}

function pageOf(records: TraceRecord[], start: number, next: number): ServerMessage {
  return { type: 'session-trace-response', id: 'session', requestId: 'request', records, start, next, reset: false, path: '' };
}

function promptTextsOf(parts: Map<string, ChatPart>): string[] {
  return [...parts.values()].flatMap((part) => (part.kind === 'prompt' ? [part.text] : []));
}

test('a restart into a new conversation leaves only that conversation in the chat and loads nothing earlier', async () => {
  const pages = createDeferredPages();
  const shownParts = new Map<string, ChatPart>();
  let resetCount = 0;
  const feed = createChatFeed({
    sessionId: 'session',
    workingDirectory: null,
    requestPage: pages.requestPage,
    onPartsChanged: (changedParts, droppedPartIds) => {
      for (const part of changedParts) shownParts.set(part.id, part);
      for (const partId of droppedPartIds) shownParts.delete(partId);
    },
    onBeats: () => {},
    isTurnOver: () => true,
    onReset: () => { resetCount += 1; shownParts.clear(); },
    onRebuilt: () => {},
    onFailure: () => {},
  });
  feed.refresh();
  await pages.settleNext(pageOf([promptRecord('old conversation', 1), restartRecord(false, 2), promptRecord('same conversation', 3)], 400, 500));
  assert.deepEqual(promptTextsOf(shownParts), ['old conversation', 'same conversation']);

  feed.refresh();
  await pages.settleNext(pageOf([restartRecord(true, 4), promptRecord('new conversation', 5)], 500, 600));
  assert.equal(resetCount, 1);
  assert.deepEqual(pages.requests.map((request) => request.payload), [{ id: 'session', endingAt: 'tail' }]);
  await pages.settleNext(pageOf([promptRecord('old conversation', 1), restartRecord(false, 2), promptRecord('same conversation', 3), restartRecord(true, 4), promptRecord('new conversation', 5)], 400, 600));
  assert.deepEqual(promptTextsOf(shownParts), ['new conversation']);

  feed.loadEarlier();
  assert.equal(pages.requests.length, 0);
});
