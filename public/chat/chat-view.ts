import type { ChatOutboxEntry } from '#shared/contracts/session.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import type { ActivityBeat, ChatPhase } from './chat-activity-core.ts';
import { createChatActivity } from './chat-activity.ts';
import type { ChatPart } from './chat-part.ts';
import { createChatLog, renderPromptBubble } from './chat-parts.ts';
import { createComposer } from './composer.ts';
import { stickToBottom } from './stick-to-bottom.ts';
import { isChatBriefOff, setChatBriefOff } from '../ui-prefs.ts';
import type { RailField } from './status-rail-core.ts';

interface ChatView {
  element: HTMLElement;
  upsert(parts: readonly ChatPart[], arrivingPartIds: ReadonlySet<string>): void;
  remove(partIds: readonly string[]): void;
  toggleTurn(turnElement: HTMLElement): void;
  keepLast(partIds: readonly string[]): void;
  keepLogInPlace(change: () => void): void;
  replaceLogParts(replacedPartIds: readonly string[], parts: readonly ChatPart[]): void;
  setPhase(phase: ChatPhase): void;
  beat(beats: readonly ActivityBeat[]): void;
  readDraft(): string;
  restoreDraft(text: string): void;
  readAttachments(): string[];
  showQueued(entries: readonly ChatOutboxEntry[]): void;
  showAttachment(fileName: string): void;
  showRail(fields: readonly RailField[]): void;
  mountAfterActivity(element: HTMLElement): void;
  showAgentBoardChange(text: string | null): void;
}

const QUEUED_STATUS_TEXT: Record<Exclude<ChatOutboxEntry['state'], 'failed'>, string> = {
  held: 'Queued until the turn ends',
  sending: 'Sending',
  submitted: 'Sent',
};

const HELD_WHILE_STARTING_TEXT = 'Sends when the agent is ready';

const DOCK_CLEARANCE_PX = 20;
const BRIEF_OFF_ATTRIBUTE = 'data-chat-brief-off';
const TURN_STEP_BY_KEY: ReadonlyMap<string, number> = new Map([['[', -1], [']', 1]]);

interface KeyedChat {
  element: HTMLElement;
  logElement: HTMLElement;
  toggleTurn(turnElement: HTMLElement): void;
}

let keyedChat: KeyedChat | null = null;
const keyedChatByElement = new WeakMap<Element, KeyedChat>();
let isChatKeyListenerInstalled = false;

export const CHAT_NEAR_TOP_EVENT = 'chat-near-top';

export const NO_ARRIVING_PARTS: ReadonlySet<string> = new Set();

export function applyChatBriefOff(isBriefOff: boolean): void {
  document.documentElement.toggleAttribute(BRIEF_OFF_ATTRIBUTE, isBriefOff);
}

function toggleBrief(): void {
  const isBriefOff = !document.documentElement.hasAttribute(BRIEF_OFF_ATTRIBUTE);
  setChatBriefOff(isBriefOff);
  applyChatBriefOff(isBriefOff);
}

function isEditableFocused(): boolean {
  const focused = document.activeElement;
  return focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || (focused instanceof HTMLElement && focused.isContentEditable);
}

function isShown(chat: KeyedChat): boolean {
  return chat.element.isConnected && chat.element.offsetParent !== null;
}

function shownKeyedChat(): KeyedChat | null {
  if (keyedChat !== null && isShown(keyedChat)) return keyedChat;
  const shownChats = [...document.querySelectorAll('.chat-view')].flatMap((chatElement) => {
    const chat = keyedChatByElement.get(chatElement);
    return chat !== undefined && isShown(chat) ? [chat] : [];
  });
  keyedChat = shownChats[0] ?? null;
  return keyedChat;
}

function stepTurnFocus(chat: KeyedChat, step: number): void {
  const turnElements = [...chat.logElement.querySelectorAll<HTMLElement>('.chat-turn')];
  const focusedIndex = turnElements.findIndex((turnElement) => turnElement === document.activeElement);
  const targetIndex = focusedIndex < 0 ? turnElements.length - 1 : Math.min(turnElements.length - 1, Math.max(0, focusedIndex + step));
  const targetTurn = turnElements[targetIndex];
  if (!targetTurn) return;
  targetTurn.focus({ preventScroll: true });
  targetTurn.scrollIntoView({ block: 'nearest' });
}

function focusedTurnOf(chat: KeyedChat): HTMLElement | null {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !focused.classList.contains('chat-turn') || !chat.logElement.contains(focused)) return null;
  return focused;
}

function handleChatKey(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || isEditableFocused()) return;
  const chat = shownKeyedChat();
  if (chat === null) return;
  if (event.code === 'KeyB' && !event.shiftKey) {
    event.preventDefault();
    toggleBrief();
    return;
  }
  const step = TURN_STEP_BY_KEY.get(event.key);
  if (step !== undefined) {
    event.preventDefault();
    stepTurnFocus(chat, step);
    return;
  }
  const focusedTurn = event.key === ' ' ? focusedTurnOf(chat) : null;
  if (focusedTurn === null) return;
  event.preventDefault();
  chat.toggleTurn(focusedTurn);
}

function keepChatKeyed(chat: KeyedChat): void {
  const markKeyed = () => {
    keyedChat = chat;
  };
  chat.element.addEventListener('pointerdown', markKeyed);
  chat.element.addEventListener('focusin', markKeyed);
  keyedChatByElement.set(chat.element, chat);
  keyedChat = chat;
  if (isChatKeyListenerInstalled) return;
  isChatKeyListenerInstalled = true;
  document.addEventListener('keydown', handleChatKey);
  window.addEventListener('storage', () => applyChatBriefOff(isChatBriefOff()));
}

function queuedStatusOf(entry: ChatOutboxEntry, phase: ChatPhase): string {
  if (entry.state === 'failed') return entry.failure ?? 'Not sent.';
  if (entry.state === 'held' && phase === 'starting') return HELD_WHILE_STARTING_TEXT;
  return QUEUED_STATUS_TEXT[entry.state];
}

function queuedRowOf(entry: ChatOutboxEntry, phase: ChatPhase, uploadUrlOf: (fileName: string) => string): HTMLElement {
  const row = el('div', 'chat-queued-row');
  row.dataset.state = entry.state;
  const status = el('span', 'chat-queued-status', queuedStatusOf(entry, phase));
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

function createAgentBoardChangeToast(): { element: HTMLElement; show(text: string | null): void } {
  const element = el('div', 'chat-agent-board-change');
  element.setAttribute('role', 'status');
  element.hidden = true;
  const text = el('span', 'chat-agent-board-change-text');
  const focusButton = button({ variant: 'primary', size: 'small', textCase: 'sentence', label: 'Focus this' });
  focusButton.addEventListener('click', () => {
    element.dispatchEvent(new CustomEvent('chat-focus-board-change', { bubbles: true, composed: true }));
  });
  const dismissButton = button({ variant: 'icon', size: 'small', label: 'Dismiss', icon: createLineIcon(CLOSE_ICON_PATH) });
  dismissButton.addEventListener('click', () => {
    element.dispatchEvent(new CustomEvent('chat-dismiss-board-change', { bubbles: true, composed: true }));
  });
  element.append(el('span', 'chat-agent-board-change-dot'), text, focusButton, dismissButton);
  const show = (shownText: string | null) => {
    element.hidden = shownText === null;
    text.textContent = shownText ?? '';
  };
  return { element, show };
}

export function createChatView(uploadUrlOf: (fileName: string) => string): ChatView {
  const element = el('section', 'chat-view');
  const scroller = el('div', 'chat-scroller');

  applyChatBriefOff(isChatBriefOff());
  const composer = createComposer(uploadUrlOf);
  const activity = createChatActivity();
  const queuedList = el('div', 'chat-queued-list');
  const scrollContent = el('div', 'chat-scroll-content');
  const { jumpButton, followLatest, keepInPlace } = stickToBottom(scroller, scrollContent);
  const chatLog = createChatLog(uploadUrlOf, keepInPlace);
  scrollContent.append(chatLog.element, activity.element, queuedList);
  scroller.append(scrollContent);
  let shownPhase: ChatPhase = 'quiet';
  let queuedEntries: readonly ChatOutboxEntry[] = [];
  const showQueued = (entries: readonly ChatOutboxEntry[]) => {
    queuedEntries = entries;
    queuedList.replaceChildren(...entries.map((entry) => queuedRowOf(entry, shownPhase, uploadUrlOf)));
  };
  composer.element.addEventListener('chat-send', followLatest);
  const jumpSlot = el('div', 'chat-jump-slot');
  jumpSlot.appendChild(jumpButton);
  const agentBoardChange = createAgentBoardChangeToast();
  const floatStack = el('div', 'chat-float-stack');
  floatStack.append(jumpSlot, agentBoardChange.element);
  const jumpBar = el('div', 'chat-jump-bar');
  jumpBar.appendChild(floatStack);
  const dock = el('div', 'chat-dock');
  dock.append(jumpBar, composer.element);
  element.append(scroller, dock);
  new ResizeObserver(() => {
    scrollContent.style.paddingBottom = `${dock.offsetHeight + DOCK_CLEARANCE_PX}px`;
  }).observe(dock, { box: 'border-box' });
  const announceNearTop = () => {
    if (scroller.scrollTop >= scroller.clientHeight) return;
    element.dispatchEvent(new CustomEvent(CHAT_NEAR_TOP_EVENT, { bubbles: true }));
  };
  scroller.addEventListener('scroll', announceNearTop, { passive: true });
  new ResizeObserver(announceNearTop).observe(scrollContent);
  const replaceLogParts = (replacedPartIds: readonly string[], parts: readonly ChatPart[]) => {
    keepInPlace(activity.element, () => chatLog.replaceParts(replacedPartIds, parts));
    announceNearTop();
  };
  keepChatKeyed({ element, logElement: chatLog.element, toggleTurn: chatLog.toggleTurn });
  const setPhase = (phase: ChatPhase) => {
    const wasStarting = shownPhase === 'starting';
    shownPhase = phase;
    composer.setTurnRunning(phase === 'working');
    activity.setPhase(phase);
    if (wasStarting !== (phase === 'starting')) showQueued(queuedEntries);
  };
  return { element, upsert: chatLog.upsert, remove: chatLog.remove, toggleTurn: chatLog.toggleTurn, keepLast: chatLog.keepLast, keepLogInPlace: (change) => keepInPlace(chatLog.element, change), replaceLogParts, setPhase, beat: activity.beat, readDraft: composer.readDraft, restoreDraft: composer.restoreDraft, readAttachments: composer.readAttachments, showQueued, showAttachment: composer.showAttachment, showRail: composer.showRail, mountAfterActivity: (afterActivity: HTMLElement) => scrollContent.insertBefore(afterActivity, queuedList), showAgentBoardChange: agentBoardChange.show };
}
