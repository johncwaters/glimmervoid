import type { ChatOutboxEntry } from '#shared/contracts/session.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import type { ActivityBeat } from './chat-activity-core.ts';
import { createChatActivity } from './chat-activity.ts';
import type { ChatPart } from './chat-part.ts';
import type { TurnMarks } from './chat-parts-core.ts';
import { createChatLog, renderPromptBubble } from './chat-parts.ts';
import { createComposer } from './composer.ts';
import { stickToBottom } from './stick-to-bottom.ts';
import type { RailField } from './status-rail-core.ts';

interface ChatView {
  element: HTMLElement;
  upsert(parts: readonly ChatPart[]): void;
  remove(partIds: readonly string[]): void;
  markTurn(marks: TurnMarks): void;
  setTurnRunning(isTurnRunning: boolean): void;
  beat(beats: readonly ActivityBeat[]): void;
  readDraft(): string;
  restoreDraft(text: string): void;
  readAttachments(): string[];
  showQueued(entries: readonly ChatOutboxEntry[]): void;
  showAttachment(fileName: string): void;
  showRail(fields: readonly RailField[]): void;
}

const QUEUED_STATUS_TEXT: Record<Exclude<ChatOutboxEntry['state'], 'failed'>, string> = {
  held: 'Queued until the turn ends',
  sending: 'Sending',
};

const DOCK_CLEARANCE_PX = 4;

function queuedStatusOf(entry: ChatOutboxEntry): string {
  if (entry.state === 'failed') return entry.failure ?? 'Not sent.';
  return QUEUED_STATUS_TEXT[entry.state];
}

function queuedRowOf(entry: ChatOutboxEntry, uploadUrlOf: (fileName: string) => string): HTMLElement {
  const row = el('div', 'chat-queued-row');
  row.dataset.state = entry.state;
  const status = el('span', 'chat-queued-status', queuedStatusOf(entry));
  const cancelButton = button({ variant: 'quiet', size: 'small', textCase: 'sentence', label: 'Cancel', disabled: entry.state === 'sending' });
  cancelButton.addEventListener('click', () => {
    row.dispatchEvent(new CustomEvent('chat-cancel', { bubbles: true, composed: true, detail: { entryId: entry.entryId } }));
  });
  const meta = el('div', 'chat-queued-meta');
  meta.append(status, cancelButton);
  const queuedPrompt = renderPromptBubble(entry.text, entry.attachments, uploadUrlOf);
  queuedPrompt.classList.add('chat-prompt-queued');
  row.append(queuedPrompt, meta);
  return row;
}

export function createChatView(uploadUrlOf: (fileName: string) => string): ChatView {
  const element = el('section', 'chat-view');
  const scroller = el('div', 'chat-scroller');
  const chatLog = createChatLog(uploadUrlOf);
  const composer = createComposer(uploadUrlOf);
  const activity = createChatActivity();
  const queuedList = el('div', 'chat-queued-list');
  const scrollContent = el('div', 'chat-scroll-content');
  scrollContent.append(chatLog.element, queuedList, activity.element);
  scroller.append(scrollContent);
  const showQueued = (entries: readonly ChatOutboxEntry[]) => {
    queuedList.replaceChildren(...entries.map((entry) => queuedRowOf(entry, uploadUrlOf)));
  };
  const { jumpButton, followLatest } = stickToBottom(scroller, scrollContent);
  composer.element.addEventListener('chat-send', followLatest);
  const jumpSlot = el('div', 'chat-jump-slot');
  jumpSlot.appendChild(jumpButton);
  const jumpBar = el('div', 'chat-jump-bar');
  jumpBar.appendChild(jumpSlot);
  const dock = el('div', 'chat-dock');
  dock.append(jumpBar, composer.element);
  element.append(scroller, dock);
  new ResizeObserver(() => {
    scrollContent.style.paddingBottom = `${dock.offsetHeight + DOCK_CLEARANCE_PX}px`;
  }).observe(dock, { box: 'border-box' });
  const setTurnRunning = (isTurnRunning: boolean) => {
    composer.setTurnRunning(isTurnRunning);
    activity.setRunning(isTurnRunning);
  };
  return { element, upsert: chatLog.upsert, remove: chatLog.remove, markTurn: chatLog.markTurn, setTurnRunning, beat: activity.beat, readDraft: composer.readDraft, restoreDraft: composer.restoreDraft, readAttachments: composer.readAttachments, showQueued, showAttachment: composer.showAttachment, showRail: composer.showRail };
}
