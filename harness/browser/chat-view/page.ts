import type { TraceRecord } from '../../../shared/contracts/trace.ts';
import type { ChatPart } from '../../../public/chat/chat-part.ts';
import { appendChatRecords, createChatPartsState } from '../../../public/chat/chat-parts-core.ts';
import { createChatLog } from '../../../public/chat/chat-parts.ts';
import { createComposer } from '../../../public/chat/composer.ts';

const EXAMPLE_CARD_PARTS: ChatPart[] = [
  { kind: 'card', id: 'example-notice', card: { cardType: 'notice', cardId: 'example-notice', data: { text: 'Context compacted' }, resolution: null } },
  { kind: 'card', id: 'example-permission', card: { cardType: 'permission', cardId: 'example-permission', data: { title: 'Run Bash', detail: 'npm run typecheck' }, resolution: null } },
  { kind: 'card', id: 'example-permission-allowed', card: { cardType: 'permission', cardId: 'example-permission-allowed', data: { title: 'Edit public/chat/chat.css', detail: '' }, resolution: { decision: 'allow' } } },
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
const traceRecords: TraceRecord[] = await traceResponse.json();
const chatLog = createChatLog();
const composer = createComposer();
chatHost?.append(chatLog.element, composer.element);
composer.setTurnRunning(true);
chatLog.upsert(appendChatRecords(createChatPartsState(), traceRecords, new Map()));
if (new URLSearchParams(location.search).has('cards')) chatLog.upsert(EXAMPLE_CARD_PARTS);
document.addEventListener('chat-card', (event) => {
  if (event instanceof CustomEvent) document.body.dataset.lastCardAction = JSON.stringify(event.detail);
});
for (const eventName of ['chat-send', 'chat-stop']) {
  document.addEventListener(eventName, (event) => {
    document.body.dataset.lastComposerEvent = JSON.stringify({ eventName, detail: event instanceof CustomEvent ? event.detail : null });
  });
}
document.body.dataset.rendered = 'true';
