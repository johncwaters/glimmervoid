import type { ChatOutboxEntry } from '#shared/contracts/session.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { keycap } from '../ui/keycap.ts';
import { paintStatusIcon } from '../status-icon.ts';
import type { ActivityBeat, ChatPhase } from './chat-activity-core.ts';
import { createChatActivity } from './chat-activity.ts';
import type { ChatPart, TurnPart } from './chat-part.ts';
import { createChatLog, renderPromptBubble } from './chat-parts.ts';
import type { TurnEnd } from './chat-parts.ts';
import { createComposer } from './composer.ts';
import { stickToBottom } from './stick-to-bottom.ts';
import { currentCallOf, interimReplyText } from './turn-digest-core.ts';
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
  setPhase(phase: ChatPhase, isTurnRunning: boolean): void;
  beat(beats: readonly ActivityBeat[]): void;
  readDraft(): string;
  restoreDraft(text: string): void;
  readAttachments(): string[];
  showQueued(entries: readonly ChatOutboxEntry[]): void;
  showAttachment(fileName: string): void;
  showRail(fields: readonly RailField[]): void;
  showTurnEnd(turnEnd: TurnEnd | null): void;
  tickRunTimes(): boolean;
  showLoaded(): void;
}

const QUEUED_STATUS_TEXT: Record<Exclude<ChatOutboxEntry['state'], 'failed'>, string> = {
  held: 'Queued until the turn ends',
  sending: 'Sending',
  submitted: 'Sent',
};

const DOCK_CLEARANCE_PX = 20;
const BRIEF_OFF_ATTRIBUTE = 'data-chat-brief-off';
const TURN_STEP_BY_KEY: ReadonlyMap<string, number> = new Map([['[', -1], [']', 1]]);
const PROMPT_STEP_BY_KEY: ReadonlyMap<string, number> = new Map([['{', -1], ['}', 1]]);
const PROMPT_SELECTOR = ':scope > :is(.chat-prompt, .chat-prompt-with-attachments)';
const LOADING_SKELETON_LINE_COUNT = 3;

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

function stepFocusWithin(steppedElements: readonly HTMLElement[], step: number): void {
  const focusedIndex = document.activeElement instanceof HTMLElement ? steppedElements.indexOf(document.activeElement) : -1;
  const targetIndex = focusedIndex < 0 ? steppedElements.length - 1 : Math.min(steppedElements.length - 1, Math.max(0, focusedIndex + step));
  const target = steppedElements[targetIndex];
  if (!target) return;
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest' });
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
  const turnStep = TURN_STEP_BY_KEY.get(event.key);
  if (turnStep !== undefined) {
    event.preventDefault();
    stepFocusWithin([...chat.logElement.querySelectorAll<HTMLElement>('.chat-turn')], turnStep);
    return;
  }
  const promptStep = PROMPT_STEP_BY_KEY.get(event.key);
  if (promptStep !== undefined) {
    event.preventDefault();
    stepFocusWithin([...chat.logElement.querySelectorAll<HTMLElement>(PROMPT_SELECTOR)], promptStep);
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

function keyHintOf(keys: readonly string[], meaning: string): HTMLElement {
  const hint = el('span', 'chat-empty-hint');
  hint.append(...keys.map((key) => keycap(key)), el('span', 'chat-empty-hint-meaning', meaning));
  return hint;
}

function renderEmptyState(): HTMLElement {
  const empty = el('div', 'chat-empty');
  const hints = el('div', 'chat-empty-hints');
  hints.append(keyHintOf(['[', ']'], 'turns'), keyHintOf(['{', '}'], 'prompts'), keyHintOf(['B'], 'brief'));
  empty.append(el('p', 'chat-empty-title', 'No messages yet'), hints);
  return empty;
}

function renderLoadingState(): HTMLElement {
  const loading = el('div', 'chat-loading');
  loading.setAttribute('aria-hidden', 'true');
  const spinner = el('span', 'chat-loading-spinner');
  paintStatusIcon(spinner, 'working');
  loading.append(...Array.from({ length: LOADING_SKELETON_LINE_COUNT }, () => el('span', 'chat-loading-line')), spinner);
  return loading;
}

function interimReplyOf(turn: TurnPart): string | null {
  const latestSegment = turn.segments.findLast((segment) => segment.kind === 'text');
  if (latestSegment?.kind !== 'text') return null;
  return interimReplyText(latestSegment.text);
}

function runningCallLabelOf(turn: TurnPart): string | null {
  if (turn.segments.at(-1)?.kind !== 'tools') return null;
  return currentCallOf(turn.segments);
}

export function createChatView(uploadUrlOf: (fileName: string) => string): ChatView {
  const element = el('section', 'chat-view');
  const scroller = el('div', 'chat-scroller');

  applyChatBriefOff(isChatBriefOff());
  const composer = createComposer(uploadUrlOf);
  const activity = createChatActivity();
  const queuedList = el('div', 'chat-queued-list');
  const turnEndRow = el('div', 'chat-turn-end-row');
  const scrollContent = el('div', 'chat-scroll-content');
  const { jumpButton, followLatest, keepInPlace } = stickToBottom(scroller, scrollContent);
  const chatLog = createChatLog(uploadUrlOf, keepInPlace);
  element.toggleAttribute('data-loading', true);
  element.setAttribute('aria-busy', 'true');
  scrollContent.append(renderLoadingState(), renderEmptyState(), chatLog.element, turnEndRow, activity.element, queuedList);
  const showLoaded = () => {
    element.toggleAttribute('data-loading', false);
    element.removeAttribute('aria-busy');
  };
  scroller.append(scrollContent);
  const showQueued = (entries: readonly ChatOutboxEntry[]) => {
    queuedList.replaceChildren(...entries.map((entry) => queuedRowOf(entry, uploadUrlOf)));
  };
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
  const upsert = (parts: readonly ChatPart[], arrivingPartIds: ReadonlySet<string>) => {
    chatLog.upsert(parts, arrivingPartIds);
    announceNearTop();
    const runningTurn = parts.findLast((part): part is TurnPart => part.kind === 'turn' && !part.isOver);
    if (runningTurn !== undefined) activity.narrate(interimReplyOf(runningTurn), runningCallLabelOf(runningTurn));
  };
  keepChatKeyed({ element, logElement: chatLog.element, toggleTurn: chatLog.toggleTurn });
  const setPhase = (phase: ChatPhase, isTurnRunning: boolean) => {
    composer.setTurnRunning(isTurnRunning);
    activity.setPhase(phase);
  };
  const showTurnEnd = (turnEnd: TurnEnd | null) => {
    const isInTurnRow = chatLog.showTurnEnd(turnEnd);
    if (turnEnd === null || isInTurnRow || turnEnd.pill.parentElement === turnEndRow) return;
    turnEndRow.replaceChildren(turnEnd.pill, turnEnd.list);
  };
  return { element, upsert, remove: chatLog.remove, toggleTurn: chatLog.toggleTurn, keepLast: chatLog.keepLast, keepLogInPlace: (change) => keepInPlace(chatLog.element, change), replaceLogParts, setPhase, beat: activity.beat, readDraft: composer.readDraft, restoreDraft: composer.restoreDraft, readAttachments: composer.readAttachments, showQueued, showAttachment: composer.showAttachment, showRail: composer.showRail, showTurnEnd, tickRunTimes: chatLog.tickRunTimes, showLoaded };
}
