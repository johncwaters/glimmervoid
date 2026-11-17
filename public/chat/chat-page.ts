import type { ConversationApproval } from '#shared/contracts/session.ts';
import { BETWEEN_TURN_STATES, STATES } from '#shared/states.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { adoptElement, el, releaseElement } from '../dom-helpers.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { sendTerminalInput } from '../session-card/terminal-input.ts';
import { announceSessionPageChange, closeSessionPage, isSessionPageOpen, openSessionPageOnShownSession } from '../session-pages/session-pages.ts';
import type { SessionPage } from '../session-pages/session-pages.ts';
import { settingsPayloadSnapshot, subscribeSettings } from '../settings/settings-store.ts';
import { CHAT_ICON_PATH } from '../svg-dom.ts';
import { getSessionView, setSessionView } from '../ui-prefs.ts';
import { createChatFeed } from './chat-feed.ts';
import type { ChatFeed } from './chat-feed.ts';
import type { ChatCard, ChatPart } from './chat-part.ts';
import { createChatView } from './chat-view.ts';

const CHAT_PAGE_ID = 'chat';
const TRACE_PAGE_TIMEOUT_MS = 10000;
const BETWEEN_TURN_STATE_SET: ReadonlySet<string> = new Set(BETWEEN_TURN_STATES);
const ESCAPE_KEY = String.fromCharCode(27);
const NOT_SENT_TEXT = 'Not connected to the server, so the message was not sent.';
const LIVE_TERMINAL_HEADING = 'The agent is waiting on its terminal';

type TerminalCardState = 'hidden' | 'borrowed' | 'released';

interface ShownApproval {
  approval: ConversationApproval;
  cards: ChatCard[];
  answers: Map<string, string>;
}

interface MountedChat {
  sessionId: string;
  root: HTMLElement;
  feed: ChatFeed;
  wasSessionWorking: boolean;
  setTurnRunning(isTurnRunning: boolean): void;
  syncWaitingCards(): void;
  close(): void;
}

const approvalBySessionId = new Map<string, ConversationApproval | null>();
let mountedChat: MountedChat | null = null;
let wasChatEnabled = false;

function isChatEnabled(): boolean {
  const sessionChat = settingsPayloadSnapshot().sessionChat;
  return typeof sessionChat === 'object' && sessionChat !== null && 'enabled' in sessionChat && sessionChat.enabled === true;
}

function isSessionWorking(sessionId: string): boolean {
  const state = sessionUIs.get(sessionId)?.currentState;
  if (state === undefined) return false;
  return !BETWEEN_TURN_STATE_SET.has(state);
}

function approvalCardsOf(approval: ConversationApproval): ChatCard[] {
  const requestKey = `approval-${approval.requestId}`;
  if (approval.kind === 'permission') {
    const title = approval.toolName ? `Allow ${approval.toolName}?` : 'Allow this tool?';
    return [{ cardType: 'permission', cardId: requestKey, data: { title, detail: approval.summary }, resolution: null }];
  }
  return (approval.questions ?? []).map((question, index) => ({
    cardType: 'question',
    cardId: `${requestKey}-${index}`,
    data: { question: question.question, detail: question.header, options: question.options.map((option) => ({ label: option.label, note: option.description })) },
    resolution: null,
  }));
}

function cardPartOf(card: ChatCard): ChatPart {
  return { kind: 'card', id: card.cardId, card };
}

function cardDetailOf(event: Event): { cardId: string; action: string; value: string } | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (typeof detail !== 'object' || detail === null) return null;
  if (!('cardId' in detail) || !('action' in detail) || !('value' in detail)) return null;
  const { cardId, action, value } = detail;
  if (typeof cardId !== 'string' || typeof action !== 'string' || typeof value !== 'string') return null;
  return { cardId, action, value };
}

function sendTextOf(event: Event): string | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (typeof detail !== 'object' || detail === null || !('text' in detail) || typeof detail.text !== 'string') return null;
  return detail.text;
}

function buildChat(sessionId: string): MountedChat {
  const root = el('div', 'session-chat');
  const failureLine = el('div', 'session-chat-failure');
  failureLine.hidden = true;
  let chatView = createChatView();
  root.append(failureLine, chatView.element);
  chatView.setTurnRunning(isSessionWorking(sessionId));
  let shownApproval: ShownApproval | null = null;
  let terminalCardState: TerminalCardState = 'hidden';
  let terminalCardSerial = 0;
  let terminalCardId: string | null = null;
  let terminalHome: HTMLElement | null = null;
  let strayChildWatcher: MutationObserver | null = null;

  const showFailure = (failureText: string | null) => {
    failureLine.hidden = failureText === null;
    failureLine.textContent = failureText ?? '';
  };

  const releaseTerminal = () => {
    if (terminalCardState !== 'borrowed') return;
    terminalCardState = 'released';
    strayChildWatcher?.disconnect();
    strayChildWatcher = null;
    const ui = sessionUIs.get(sessionId);
    if (ui) releaseElement(ui.termWrap, ui.card);
    terminalHome?.remove();
    terminalHome = null;
    if (terminalCardId) chatView.remove([terminalCardId]);
    terminalCardId = null;
  };

  const sendStrayChildrenHome = (slot: HTMLElement, termWrap: HTMLElement) => {
    for (const child of [...slot.children]) {
      if (child !== termWrap) terminalHome?.before(child);
    }
  };

  const borrowTerminal = () => {
    if (terminalCardState === 'borrowed') return;
    const ui = sessionUIs.get(sessionId);
    if (!ui) return;
    terminalCardSerial += 1;
    const card: ChatCard = { cardType: 'live-terminal', cardId: `live-terminal-${terminalCardSerial}`, data: { heading: LIVE_TERMINAL_HEADING }, resolution: null };
    chatView.upsert([cardPartOf(card)]);
    const slot = chatView.element.querySelector<HTMLElement>(`[data-card-type="live-terminal"] .chat-terminal-slot`);
    if (!slot) return;
    terminalCardId = card.cardId;
    terminalCardState = 'borrowed';
    terminalHome = el('div', 'terminal-wrap-home');
    terminalHome.hidden = true;
    ui.termWrap.before(terminalHome);
    adoptElement(ui.termWrap, slot);
    strayChildWatcher = new MutationObserver(() => sendStrayChildrenHome(slot, ui.termWrap));
    strayChildWatcher.observe(slot, { childList: true });
    ui._ensureTerminalReady?.();
  };

  const settleShownApproval = () => {
    if (!shownApproval) return;
    const unanswered = shownApproval.cards.filter((card) => card.resolution === null).map((card) => card.cardId);
    chatView.remove(unanswered);
    shownApproval = null;
  };

  const syncWaitingCards = () => {
    const approval = approvalBySessionId.get(sessionId) ?? null;
    if (shownApproval && shownApproval.approval.requestId !== approval?.requestId) settleShownApproval();
    if (approval && !shownApproval) {
      shownApproval = { approval, cards: approvalCardsOf(approval), answers: new Map() };
      chatView.upsert(shownApproval.cards.map(cardPartOf));
    }
    const isAnswerableFromChat = shownApproval !== null && shownApproval.cards.length > 0;
    const isWaitingOnTerminal = sessionUIs.get(sessionId)?.currentState === STATES.WAITING && !isAnswerableFromChat;
    if (isWaitingOnTerminal) {
      borrowTerminal();
      return;
    }
    releaseTerminal();
  };

  const resolveCard = (card: ChatCard) => {
    if (!shownApproval) return;
    shownApproval.cards = shownApproval.cards.map((shownCard) => (shownCard.cardId === card.cardId ? card : shownCard));
    chatView.upsert([cardPartOf(card)]);
  };

  const answerCard = (cardId: string, action: string, value: string) => {
    const shown = shownApproval;
    const card = shown?.cards.find((shownCard) => shownCard.cardId === cardId);
    if (!shown || !card || card.resolution !== null) return;
    const { requestId } = shown.approval;
    if (card.cardType === 'permission' && action === 'decide' && (value === 'allow' || value === 'deny')) {
      if (!sendControlMsg({ type: 'decide-approval', id: sessionId, requestId, decision: value })) {
        showFailure(NOT_SENT_TEXT);
        return;
      }
      resolveCard({ ...card, resolution: { decision: value } });
      return;
    }
    if (card.cardType !== 'question' || action !== 'answer') return;
    shown.answers.set(card.data.question, value);
    if (shown.answers.size < shown.cards.length) {
      resolveCard({ ...card, resolution: { answer: value } });
      return;
    }
    if (!sendControlMsg({ type: 'answer-approval', id: sessionId, requestId, answers: Object.fromEntries(shown.answers) })) {
      shown.answers.delete(card.data.question);
      showFailure(NOT_SENT_TEXT);
      return;
    }
    resolveCard({ ...card, resolution: { answer: value } });
  };

  root.addEventListener('chat-send', (event) => {
    const text = sendTextOf(event);
    if (text === null) return;
    if (!sendControlMsg({ type: 'chat-send', id: sessionId, text })) showFailure(NOT_SENT_TEXT);
  });
  root.addEventListener('chat-stop', () => {
    sendTerminalInput(sessionUIs.get(sessionId), ESCAPE_KEY);
  });
  root.addEventListener('chat-card', (event) => {
    const detail = cardDetailOf(event);
    if (detail) answerCard(detail.cardId, detail.action, detail.value);
  });

  const feed = createChatFeed({
    sessionId,
    pathContext: { cwd: sessionUIs.get(sessionId)?.path ?? null, home: null },
    requestPage: (payload) => sendControlRequest('session-trace', payload, { timeoutMs: TRACE_PAGE_TIMEOUT_MS }),
    isSessionWorking: () => isSessionWorking(sessionId),
    onPartsChanged: (changedParts, droppedPartIds) => {
      chatView.upsert(changedParts);
      chatView.remove(droppedPartIds);
    },
    onReset: () => {
      releaseTerminal();
      shownApproval = null;
      const freshView = createChatView();
      freshView.setTurnRunning(isSessionWorking(sessionId));
      chatView.element.replaceWith(freshView.element);
      chatView = freshView;
      syncWaitingCards();
    },
    onFailure: showFailure,
  });
  return {
    sessionId,
    root,
    feed,
    wasSessionWorking: isSessionWorking(sessionId),
    setTurnRunning: (isTurnRunning) => chatView.setTurnRunning(isTurnRunning),
    syncWaitingCards,
    close: () => {
      releaseTerminal();
      feed.close();
    },
  };
}

function unmountChat(): void {
  if (!mountedChat) return;
  mountedChat.close();
  mountedChat.root.remove();
  mountedChat = null;
}

export function noteChatApproval(sessionId: string, approval: ConversationApproval | null): void {
  approvalBySessionId.set(sessionId, approval);
}

export function applyChatTraceChanged(sessionId: string): void {
  if (mountedChat?.sessionId !== sessionId) return;
  mountedChat.feed.refresh();
}

export function applyChatSnapshot(rows: readonly { id: string; conversationApproval?: ConversationApproval | null }[]): void {
  approvalBySessionId.clear();
  for (const row of rows) noteChatApproval(row.id, row.conversationApproval ?? null);
  if (!mountedChat) return;
  applyChatSessionStatus(mountedChat.sessionId);
  mountedChat.feed.refresh();
}

export function applyChatSessionStatus(sessionId: string): void {
  if (mountedChat?.sessionId !== sessionId) return;
  mountedChat.syncWaitingCards();
  const isWorking = isSessionWorking(sessionId);
  if (isWorking === mountedChat.wasSessionWorking) return;
  mountedChat.wasSessionWorking = isWorking;
  mountedChat.setTurnRunning(isWorking);
  mountedChat.feed.noteSessionWorkingChanged();
}

subscribeSettings((change) => {
  if (change.kind !== 'broadcast') return;
  const isEnabled = isChatEnabled();
  const hasJustEnabled = isEnabled && !wasChatEnabled;
  wasChatEnabled = isEnabled;
  if (!isEnabled && mountedChat && isSessionPageOpen(CHAT_PAGE_ID, mountedChat.sessionId)) closeSessionPage();
  announceSessionPageChange(CHAT_PAGE_ID, null);
  if (hasJustEnabled && getSessionView() === 'chat') openSessionPageOnShownSession(CHAT_PAGE_ID);
});

export const chatPage: SessionPage = {
  id: CHAT_PAGE_ID,
  label: 'Chat',
  iconPath: CHAT_ICON_PATH,
  isAvailableFor: (sessionId) => isChatEnabled() && sessionUIs.has(sessionId),
  hasUnreadFor: () => false,
  mount(host, sessionId) {
    unmountChat();
    setSessionView('chat');
    mountedChat = buildChat(sessionId);
    host.append(mountedChat.root);
    mountedChat.syncWaitingCards();
    mountedChat.feed.refresh();
  },
  unmount: unmountChat,
  didCloseByOperator: () => setSessionView('terminal'),
  canStepBack: () => false,
  stepBack: () => {},
};
