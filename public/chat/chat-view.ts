import { el } from '../dom-helpers.ts';
import type { ChatPart } from './chat-part.ts';
import { createChatLog } from './chat-parts.ts';
import { createComposer } from './composer.ts';
import { stickToBottom } from './stick-to-bottom.ts';

interface ChatView {
  element: HTMLElement;
  upsert(parts: readonly ChatPart[]): void;
  remove(partIds: readonly string[]): void;
  setTurnRunning(isTurnRunning: boolean): void;
}

export function createChatView(): ChatView {
  const element = el('section', 'chat-view');
  const scroller = el('div', 'chat-scroller');
  const chatLog = createChatLog();
  const composer = createComposer();
  scroller.appendChild(chatLog.element);
  const { jumpButton } = stickToBottom(scroller, chatLog.element);
  const jumpSlot = el('div', 'chat-jump-slot');
  jumpSlot.appendChild(jumpButton);
  const jumpBar = el('div', 'chat-jump-bar');
  jumpBar.appendChild(jumpSlot);
  element.append(scroller, jumpBar, composer.element);
  return { element, upsert: chatLog.upsert, remove: chatLog.remove, setTurnRunning: composer.setTurnRunning };
}
