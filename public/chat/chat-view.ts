import type { ChatOutboxEntry } from '#shared/contracts/session.ts';
import { isOptimisticOutboxEntryId } from '../state/chat-outbox-core.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { paintStatusIcon } from '../status-icon.ts';
import type { ActivityBeat, ChatPhase } from './chat-activity-core.ts';
import { createChatActivity } from './chat-activity.ts';
import { attachChatLinkPopup } from './chat-link-popup.ts';
import type { ChatPart, TurnPart } from './chat-part.ts';
import { createChatLog, renderPromptBubble } from './chat-parts.ts';
import type { TurnEnd } from './chat-parts.ts';
import { mountComposerIsland } from './Composer.tsx';
import type { ComposerModelPickerConfig } from './Composer.tsx';
import { stickToBottom } from './stick-to-bottom.ts';
import { currentCallOf, interimReplyText } from './turn-digest-core.ts';
import { isChatBriefOff, setChatBriefOff } from '../ui-prefs.ts';
import { applyChatBriefOff, BRIEF_OFF_ATTRIBUTE } from '../theme.ts';
import type { RailField } from './status-rail-core.ts';

interface ChatView {
  element: HTMLElement;
  pauseActivityStats(): void;
  resumeActivityStats(): void;
  stopActivityStats(): void;
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
  closeModelPicker(): void;
  showTurnEnd(turnEnd: TurnEnd | null): void;
  tickRunTimes(): boolean;
  showLoaded(): void;
  dispose(): void;
}

const QUEUED_STATUS_TEXT: Record<Exclude<ChatOutboxEntry['state'], 'failed'>, string> = {
  held: 'Queued',
  next: 'Next step',
  sending: 'Sending',
  submitted: 'Sent',
};

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

const STUDIO_OUTBOX_FAILED_TEXT = 'The message was not sent. Cancel to get the text back.';

function queuedStatusOf(entry: ChatOutboxEntry): string {
  if (entry.state === 'failed') return entry.failure ?? 'Not sent.';
  return QUEUED_STATUS_TEXT[entry.state];
}

export function studioQueuedStatusOf(entry: ChatOutboxEntry): string {
  if (entry.state === 'failed' && entry.shouldOpenTerminal) return STUDIO_OUTBOX_FAILED_TEXT;
  return queuedStatusOf(entry);
}

function sendNowButtonOf(entry: ChatOutboxEntry): HTMLButtonElement {
  const sendNowButton = button({ variant: 'quiet', size: 'small', textCase: 'inline', label: 'Send now' });
  sendNowButton.addEventListener('click', () => {
    sendNowButton.disabled = true;
    sendNowButton.dispatchEvent(new CustomEvent('chat-send-now', { bubbles: true, composed: true, detail: { entryId: entry.entryId } }));
  });
  return sendNowButton;
}

function openTerminalButtonOf(): HTMLButtonElement {
  const openTerminalButton = button({ variant: 'quiet', size: 'small', textCase: 'inline', label: 'Open Terminal' });
  openTerminalButton.addEventListener('click', () => {
    openTerminalButton.dispatchEvent(new CustomEvent('chat-open-terminal', { bubbles: true, composed: true }));
  });
  return openTerminalButton;
}

function queuedRowOf(entry: ChatOutboxEntry, uploadUrlOf: (fileName: string) => string, canSendNow: boolean): HTMLElement {
  const row = el('div', 'chat-queued-row');
  row.dataset.state = entry.state;
  const status = el('span', 'chat-queued-status', queuedStatusOf(entry));
  const cancelButton = button({
    variant: 'quiet',
    size: 'small',
    textCase: 'inline',
    label: 'Cancel',
    disabled: entry.state === 'sending' || isOptimisticOutboxEntryId(entry.entryId),
  });
  cancelButton.addEventListener('click', () => {
    row.dispatchEvent(new CustomEvent('chat-cancel', { bubbles: true, composed: true, detail: { entryId: entry.entryId } }));
  });
  const meta = el('div', 'chat-queued-meta');
  if (canSendNow && entry.state === 'held' && !isOptimisticOutboxEntryId(entry.entryId)) meta.append(sendNowButtonOf(entry));
  if (entry.state === 'failed' && entry.shouldOpenTerminal) meta.append(openTerminalButtonOf());
  meta.append(cancelButton);
  const queuedPrompt = renderPromptBubble(entry.text, entry.attachments, uploadUrlOf);
  queuedPrompt.classList.add('chat-prompt-queued');
  row.append(status, queuedPrompt, meta);
  return row;
}

function renderEmptyState(): HTMLElement {
  const empty = el('div', 'chat-empty');
  empty.append(el('p', 'chat-empty-title', 'No messages yet'));
  return empty;
}

function renderLoadingState(): HTMLElement {
  const loading = el('div', 'chat-loading');
  loading.setAttribute('role', 'status');
  const lines = Array.from({ length: LOADING_SKELETON_LINE_COUNT }, () => {
    const line = el('span', 'chat-loading-line');
    line.setAttribute('aria-hidden', 'true');
    return line;
  });
  const spinner = el('span', 'chat-loading-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  paintStatusIcon(spinner, 'starting');
  const statusRow = el('div', 'chat-loading-status');
  statusRow.append(spinner, el('span', 'chat-loading-label', 'Loading conversation'));
  loading.append(...lines, statusRow);
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

export function createChatView(
  uploadUrlOf: (fileName: string) => string,
  modelPicker?: ComposerModelPickerConfig,
): ChatView {
  const element = el('section', 'chat-view');
  const scroller = el('div', 'chat-scroller');

  applyChatBriefOff(isChatBriefOff());
  const composerHost = el('div', 'chat-composer-host');
  const composer = mountComposerIsland(composerHost, { uploadUrlOf, modelPicker });
  const activity = createChatActivity();
  const queuedList = el('div', 'chat-queued-list');
  const turnEndRow = el('div', 'chat-turn-end-row');
  const scrollContent = el('div', 'chat-scroll-content');
  const { jumpButton, followLatest, keepInPlace, keepPlaceWhileLoading } = stickToBottom(scroller, scrollContent);
  const chatLog = createChatLog(uploadUrlOf, keepInPlace);
  element.toggleAttribute('data-loading', true);
  element.setAttribute('aria-busy', 'true');
  scrollContent.append(renderLoadingState(), renderEmptyState(), chatLog.element, turnEndRow, activity.element, queuedList);
  const showLoaded = () => {
    element.toggleAttribute('data-loading', false);
    element.removeAttribute('aria-busy');
  };
  scroller.append(scrollContent);
  let shownQueuedEntries: readonly ChatOutboxEntry[] = [];
  let isQueueBehindRunningTurn = false;
  const showQueued = (entries: readonly ChatOutboxEntry[]) => {
    shownQueuedEntries = entries;
    const canSendNow = isQueueBehindRunningTurn && !entries.some((entry) => entry.state === 'failed');
    queuedList.replaceChildren(...entries.map((entry) => queuedRowOf(entry, uploadUrlOf, canSendNow)));
  };
  composer.element.addEventListener('chat-send', followLatest);
  const jumpSlot = el('div', 'chat-jump-slot');
  jumpSlot.appendChild(jumpButton);
  const jumpBar = el('div', 'chat-jump-bar');
  jumpBar.appendChild(jumpSlot);
  const dock = el('div', 'chat-dock');
  dock.append(jumpBar, composerHost);
  element.append(scroller, dock);
  attachChatLinkPopup(element, scroller, dock);
  const composerParts = composer.element;
  const draftGrowthPx = () => {
    const attachments = composerParts.querySelector<HTMLElement>('.chat-composer-attachments');
    const inputRow = composerParts.querySelector<HTMLElement>('.chat-composer-row');
    const attachButton = composerParts.querySelector<HTMLElement>('.chat-composer-attach');
    const sendStopSlot = composerParts.querySelector<HTMLElement>('.chat-composer-slot');
    const rowGapPx = Number.parseFloat(getComputedStyle(composerParts).rowGap) || 0;
    const attachmentsGrowthPx = attachments && attachments.childElementCount > 0 ? attachments.offsetHeight + rowGapPx : 0;
    const restingRowHeightPx = Math.max(attachButton?.offsetHeight ?? 0, sendStopSlot?.offsetHeight ?? 0);
    const inputGrowthPx = Math.max(0, (inputRow?.offsetHeight ?? 0) - restingRowHeightPx);
    return attachmentsGrowthPx + inputGrowthPx;
  };
  new ResizeObserver(() => {
    const growthPx = Math.min(draftGrowthPx(), dock.offsetHeight);
    scroller.style.marginBottom = `${dock.offsetHeight - growthPx}px`;
    scrollContent.style.paddingBottom = `${growthPx}px`;
  }).observe(dock, { box: 'border-box' });
  const announceNearTop = () => {
    if (scroller.scrollTop >= scroller.clientHeight) return;
    element.dispatchEvent(new CustomEvent(CHAT_NEAR_TOP_EVENT, { bubbles: true }));
  };
  scroller.addEventListener('scroll', announceNearTop, { passive: true });
  new ResizeObserver(announceNearTop).observe(scrollContent);
  const replaceLogParts = (replacedPartIds: readonly string[], parts: readonly ChatPart[]) => {
    keepPlaceWhileLoading(activity.element, () => chatLog.replaceParts(replacedPartIds, parts));
    announceNearTop();
  };
  const upsert = (parts: readonly ChatPart[], arrivingPartIds: ReadonlySet<string>) => {
    chatLog.upsert(parts, arrivingPartIds);
    announceNearTop();
    const runningTurn = parts.findLast((part): part is TurnPart => part.kind === 'turn' && !part.isOver);
    if (runningTurn !== undefined) activity.narrate(interimReplyOf(runningTurn), runningCallLabelOf(runningTurn));
    if (runningTurn !== undefined) activity.showStats(runningTurn.openedAt, runningTurn.outputTokens);
  };
  keepChatKeyed({ element, logElement: chatLog.element, toggleTurn: chatLog.toggleTurn });
  const setPhase = (phase: ChatPhase, isTurnRunning: boolean) => {
    composer.setTurnRunning(isTurnRunning);
    if (isTurnRunning !== isQueueBehindRunningTurn) {
      isQueueBehindRunningTurn = isTurnRunning;
      showQueued(shownQueuedEntries);
    }
    activity.setPhase(phase);
  };
  const showTurnEnd = (turnEnd: TurnEnd | null) => {
    const isInTurnRow = chatLog.showTurnEnd(turnEnd);
    if (turnEnd === null || isInTurnRow || turnEnd.pill.parentElement === turnEndRow) return;
    turnEndRow.replaceChildren(turnEnd.pill, turnEnd.list);
  };
  return { element, pauseActivityStats: activity.pauseStats, resumeActivityStats: activity.resumeStats, stopActivityStats: activity.stopStats, upsert, remove: chatLog.remove, toggleTurn: chatLog.toggleTurn, keepLast: chatLog.keepLast, keepLogInPlace: (change) => keepInPlace(chatLog.element, change), replaceLogParts, setPhase, beat: activity.beat, readDraft: composer.readDraft, restoreDraft: composer.restoreDraft, readAttachments: composer.readAttachments, showQueued, showAttachment: composer.showAttachment, showRail: composer.showRail, closeModelPicker: composer.closeModelPicker, showTurnEnd, tickRunTimes: chatLog.tickRunTimes, showLoaded, dispose: composer.dispose };
}
