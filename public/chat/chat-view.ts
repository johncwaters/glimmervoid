import { el } from '../dom-helpers.ts';
import type { ActivityBeat } from './chat-activity-core.ts';
import { createChatActivity } from './chat-activity.ts';
import type { ChatPart } from './chat-part.ts';
import { createChatLog } from './chat-parts.ts';
import { createComposer } from './composer.ts';
import { stickToBottom } from './stick-to-bottom.ts';

interface ChatView {
  element: HTMLElement;
  upsert(parts: readonly ChatPart[]): void;
  remove(partIds: readonly string[]): void;
  setTurnRunning(isTurnRunning: boolean): void;
  beat(beats: readonly ActivityBeat[]): void;
  readDraft(): string;
  restoreDraft(text: string): void;
  showQueued(texts: readonly string[]): void;
}

export function createChatView(): ChatView {
  const element = el('section', 'chat-view');
  const scroller = el('div', 'chat-scroller');
  const chatLog = createChatLog();
  const composer = createComposer();
  const activity = createChatActivity();
  const queuedList = el('div', 'chat-queued-list');
  const scrollContent = el('div', 'chat-scroll-content');
  scrollContent.append(chatLog.element, queuedList, activity.element);
  scroller.append(scrollContent);
  const showQueued = (texts: readonly string[]) => {
    queuedList.replaceChildren(...texts.map((text) => {
      const queued = el('div', 'chat-prompt chat-prompt-queued');
      queued.append(el('span', 'chat-prompt-queued-label', 'Queued'), el('span', null, text));
      return queued;
    }));
  };
  const { jumpButton, followLatest } = stickToBottom(scroller, scrollContent);
  composer.element.addEventListener('chat-send', followLatest);
  const jumpSlot = el('div', 'chat-jump-slot');
  jumpSlot.appendChild(jumpButton);
  const jumpBar = el('div', 'chat-jump-bar');
  jumpBar.appendChild(jumpSlot);
  element.append(scroller, jumpBar, composer.element);
  const setTurnRunning = (isTurnRunning: boolean) => {
    composer.setTurnRunning(isTurnRunning);
    activity.setRunning(isTurnRunning);
  };
  return { element, upsert: chatLog.upsert, remove: chatLog.remove, setTurnRunning, beat: activity.beat, readDraft: composer.readDraft, restoreDraft: composer.restoreDraft, showQueued };
}
