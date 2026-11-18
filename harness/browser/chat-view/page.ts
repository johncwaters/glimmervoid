import type { TraceRecord } from '../../../shared/contracts/trace.ts';
import type { ChatPart } from '../../../public/chat/chat-part.ts';
import { appendChatRecords, createChatPartsState, endChatTurn } from '../../../public/chat/chat-parts-core.ts';
import { createChatFeed } from '../../../public/chat/chat-feed.ts';
import { createChatView } from '../../../public/chat/chat-view.ts';

const EXAMPLE_CARD_PARTS: ChatPart[] = [
  { kind: 'card', id: 'example-notice', card: { cardType: 'notice', cardId: 'example-notice', data: { text: 'Context compacted' }, resolution: null } },
  { kind: 'card', id: 'example-permission', card: { cardType: 'permission', cardId: 'example-permission', data: { title: 'Run Bash', detail: 'npm run typecheck' }, resolution: null } },
  { kind: 'card', id: 'example-permission-allowed', card: { cardType: 'permission', cardId: 'example-permission-allowed', data: { title: 'Edit public/chat/chat.css', detail: '' }, resolution: { decision: 'allow' } } },
  { kind: 'card', id: 'example-permission-denied', card: { cardType: 'permission', cardId: 'example-permission-denied', data: { title: 'Run Bash', detail: 'rm -rf build' }, resolution: { decision: 'deny', message: 'Run npm run clean instead' } } },
  {
    kind: 'card',
    id: 'example-question',
    card: {
      cardType: 'question',
      cardId: 'example-question',
      data: { question: 'Which layout should the composer use?', detail: 'Both keep the Stop control beside the input.', options: [{ label: 'Docked', note: 'pinned to the bottom' }, { label: 'Inline', note: 'follows the last reply' }] },
      resolution: null,
    },
  },
  { kind: 'card', id: 'example-question-answered', card: { cardType: 'question', cardId: 'example-question-answered', data: { question: 'Land now?', detail: '', options: [] }, resolution: { answer: 'Yes' } } },
];

const chatHost = document.getElementById('chat-host');
const traceResponse = await fetch('/trace-records.json');
const { records: traceRecords }: { records: TraceRecord[] } = await traceResponse.json();
const chatView = createChatView((fileName) => (fileName.endsWith('.png') ? new URL('../../../public/animals/sprite-cow.png', import.meta.url).href : `/missing-upload/${encodeURIComponent(fileName)}`));
chatHost?.appendChild(chatView.element);
chatView.setTurnRunning(true);
const LIVE_PAGE_RECORDS = 25;
const LIVE_PAGE_INTERVAL_MS = 20;

async function playLive(): Promise<void> {
  let servedCount = Math.min(LIVE_PAGE_RECORDS, traceRecords.length);
  const feed = createChatFeed({
    sessionId: 'harness',
    requestPage: async (payload) => {
      const start = 'after' in payload ? payload.after : 0;
      return { type: 'session-trace-response', id: 'harness', requestId: 'harness', records: traceRecords.slice(start, servedCount), start, next: servedCount, reset: false, path: '' };
    },
    onPartsChanged: (changedParts, droppedPartIds) => {
      chatView.upsert(changedParts);
      chatView.remove(droppedPartIds);
    },
    onTurnMarks: (marks) => chatView.markTurn(marks),
    isTurnOver: () => false,
    onBeats: (beats) => {
      document.body.dataset.beatCount = String(Number(document.body.dataset.beatCount ?? 0) + beats.length);
      chatView.beat(beats);
    },
    onReset: () => {},
    onFailure: (failureText) => { if (failureText) document.body.dataset.feedFailure = failureText; },
  });
  feed.refresh();
  while (servedCount < traceRecords.length) {
    await new Promise((resolve) => setTimeout(resolve, LIVE_PAGE_INTERVAL_MS));
    servedCount = Math.min(servedCount + LIVE_PAGE_RECORDS, traceRecords.length);
    feed.refresh();
  }
  await new Promise((resolve) => setTimeout(resolve, LIVE_PAGE_INTERVAL_MS));
  if (new URLSearchParams(location.search).has('working')) return;
  const partTopsBefore = partTops();
  chatView.setTurnRunning(false);
  feed.endTurn();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const partTopsAfter = partTops();
  const turnEndShiftPx = Math.max(0, ...partTopsBefore.map((top, partIndex) => Math.abs(top - (partTopsAfter[partIndex] ?? top))));
  document.body.dataset.turnEndShiftPx = String(turnEndShiftPx);
}

function partTops(): number[] {
  return Array.from(chatView.element.querySelectorAll('[data-part-id]'), (part) => part.getBoundingClientRect().top);
}

function showRecordsAtRest(): void {
  const partsState = createChatPartsState();
  const appended = appendChatRecords(partsState, traceRecords);
  chatView.upsert(appended.parts);
  chatView.markTurn(appended.marks);
  chatView.markTurn(endChatTurn(partsState));
}

if (new URLSearchParams(location.search).has('live')) await playLive();
if (!new URLSearchParams(location.search).has('live')) showRecordsAtRest();
if (new URLSearchParams(location.search).has('cards')) chatView.upsert(EXAMPLE_CARD_PARTS);
document.addEventListener('chat-card', (event) => {
  if (event instanceof CustomEvent) document.body.dataset.lastCardAction = JSON.stringify(event.detail);
});
for (const eventName of ['chat-send', 'chat-stop']) {
  document.addEventListener(eventName, (event) => {
    document.body.dataset.lastComposerEvent = JSON.stringify({ eventName, detail: event instanceof CustomEvent ? event.detail : null });
  });
}
document.body.dataset.rendered = 'true';
