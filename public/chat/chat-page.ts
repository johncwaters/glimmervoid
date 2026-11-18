import { CHAT_SEND_MAX_ATTACHMENTS, type ChatOutboxEntry, type ConversationApproval } from '#shared/contracts/session.ts';
import { STATES } from '#shared/states.ts';
import { errorMessage } from '#shared/text.ts';
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
import { storeFilesForChat } from '../session-upload.ts';
import { sessionAccountIdOf, sessionModelSelectionOf } from '../session-card/card-model.ts';
import { clock } from '#shared/clock.ts';
import { planLimitsOf, sessionCostOf, sessionMeterOf, subscribeUsage } from '../usage/usage-store.ts';
import { planVendorOfAgent, railFieldsOf } from './status-rail-core.ts';
import type { RunningSubagent } from './status-rail-core.ts';

const CHAT_PAGE_ID = 'chat';
const TRACE_PAGE_TIMEOUT_MS = 10000;
const CHAT_SEND_TIMEOUT_MS = 10000;
const MID_TURN_STATES: ReadonlySet<string> = new Set([STATES.RUNNING, STATES.WAITING]);
const RAIL_TICK_MS = 30_000;
const ESCAPE_KEY = String.fromCharCode(27);
const NOT_SENT_TEXT = 'Not connected to the server, so the message was not sent.';
const TOO_MANY_ATTACHMENTS_TEXT = `A Chat message carries up to ${CHAT_SEND_MAX_ATTACHMENTS} files, so the rest were not attached.`;
const TOO_MANY_TO_SEND_TEXT = `A Chat message carries up to ${CHAT_SEND_MAX_ATTACHMENTS} files. Remove some and send again.`;
const uploadingCountBySessionId = new Map<string, number>();
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
  showOutbox(): void;
  restoreText(text: string): void;
  restoreAttachments(fileNames: readonly string[]): void;
  showFailure(failureText: string | null): void;
  syncWaitingCards(): void;
  showRail(): void;
  resumeRail(): void;
  park(): void;
  close(): void;
}

const approvalBySessionId = new Map<string, ConversationApproval | null>();
const draftBySessionId = new Map<string, string>();
const draftAttachmentsBySessionId = new Map<string, string[]>();
const outboxBySessionId = new Map<string, ChatOutboxEntry[]>();
let mountedChat: MountedChat | null = null;
const keptChatBySessionId = new Map<string, MountedChat>();
let wasChatEnabled = false;

function isChatEnabled(): boolean {
  const sessionChat = settingsPayloadSnapshot().sessionChat;
  return typeof sessionChat === 'object' && sessionChat !== null && 'enabled' in sessionChat && sessionChat.enabled === true;
}

function draftWithRestoredText(restoredText: string, draft: string): string {
  if (draft.trim().length === 0) return restoredText;
  return `${restoredText}\n\n${draft}`;
}

function isSessionWorking(sessionId: string): boolean {
  const state = sessionUIs.get(sessionId)?.currentState;
  if (state === undefined) return false;
  return MID_TURN_STATES.has(state);
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

function attachedFilesOf(event: Event): File[] {
  if (!(event instanceof CustomEvent)) return [];
  const detail: unknown = event.detail;
  if (typeof detail !== 'object' || detail === null || !('files' in detail) || !Array.isArray(detail.files)) return [];
  return detail.files.filter((file): file is File => file instanceof File);
}

function cancelledEntryIdOf(event: Event): string | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (typeof detail !== 'object' || detail === null || !('entryId' in detail) || typeof detail.entryId !== 'string') return null;
  return detail.entryId;
}

function builtChatOf(sessionId: string): MountedChat | null {
  if (mountedChat?.sessionId === sessionId) return mountedChat;
  return keptChatBySessionId.get(sessionId) ?? null;
}

function restoreAttachmentsToSession(sessionId: string, fileNames: readonly string[]): void {
  if (fileNames.length === 0) return;
  const builtChat = builtChatOf(sessionId);
  if (builtChat) {
    builtChat.restoreAttachments(fileNames);
    return;
  }
  draftAttachmentsBySessionId.set(sessionId, [...(draftAttachmentsBySessionId.get(sessionId) ?? []), ...fileNames]);
}

function restoreTextToSession(sessionId: string, text: string): void {
  if (text.length === 0) return;
  const builtChat = builtChatOf(sessionId);
  if (builtChat) {
    builtChat.restoreText(text);
    return;
  }
  draftBySessionId.set(sessionId, draftWithRestoredText(text, draftBySessionId.get(sessionId) ?? ''));
}

function showSessionFailure(sessionId: string, failureText: string): void {
  builtChatOf(sessionId)?.showFailure(failureText);
}

function cancelOutboxEntry(sessionId: string, entryId: string): void {
  sendControlRequest('chat-cancel', { id: sessionId, entryId }, { timeoutMs: CHAT_SEND_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type !== 'chat-cancel-result') return;
      restoreTextToSession(sessionId, reply.cancelledTexts.join('\n\n'));
      restoreAttachmentsToSession(sessionId, reply.cancelledAttachments);
    })
    .catch((reason: unknown) => showSessionFailure(sessionId, `Could not cancel the message: ${errorMessage(reason)}`));
}

function uploadUrlFor(sessionId: string): (fileName: string) => string {
  return (fileName) => `/upload/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileName)}`;
}

function sendChatText(sessionId: string, text: string, attachments: readonly string[]): void {
  const failSend = (failureText: string) => {
    restoreTextToSession(sessionId, text);
    restoreAttachmentsToSession(sessionId, attachments);
    showSessionFailure(sessionId, failureText);
  };
  if (attachments.length > CHAT_SEND_MAX_ATTACHMENTS) {
    failSend(TOO_MANY_TO_SEND_TEXT);
    return;
  }
  sendControlRequest('chat-send', { id: sessionId, text, attachments: [...attachments] }, { timeoutMs: CHAT_SEND_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type !== 'chat-send-result' || reply.ok) return;
      failSend(reply.error ?? NOT_SENT_TEXT);
    })
    .catch((reason: unknown) => failSend(`Could not confirm the message was queued: ${errorMessage(reason)}`));
}

function chatSendOf(event: Event): { text: string; attachments: string[] } | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (typeof detail !== 'object' || detail === null || !('text' in detail) || typeof detail.text !== 'string') return null;
  const attachments = 'attachments' in detail && Array.isArray(detail.attachments) ? detail.attachments.filter((fileName): fileName is string => typeof fileName === 'string') : [];
  return { text: detail.text, attachments };
}

function buildChat(sessionId: string): MountedChat {
  const root = el('div', 'session-chat');
  const failureLine = el('div', 'session-chat-failure');
  failureLine.hidden = true;
  let chatView = createChatView(uploadUrlFor(sessionId));
  chatView.restoreDraft(draftBySessionId.get(sessionId) ?? '');
  for (const fileName of draftAttachmentsBySessionId.get(sessionId) ?? []) chatView.showAttachment(fileName);
  draftAttachmentsBySessionId.delete(sessionId);
  const standInByEntryId = new Map<string, ChatPart>();
  const entryIdsAwaitingFeed = new Set<string>();
  const removeStandIns = (entryIds: readonly string[]) => {
    for (const entryId of entryIds) {
      const standIn = standInByEntryId.get(entryId);
      if (standIn) chatView.remove([standIn.id]);
      standInByEntryId.delete(entryId);
      entryIdsAwaitingFeed.delete(entryId);
    }
  };
  const showOutbox = () => {
    const entries = outboxBySessionId.get(sessionId) ?? [];
    const submittedEntries = entries.filter((entry) => entry.state === 'submitted');
    for (const entry of submittedEntries) {
      if (standInByEntryId.has(entry.entryId)) continue;
      const standIn: ChatPart = { kind: 'prompt', id: `sent-${entry.entryId}`, text: entry.text, at: clock.nowMs(), attachments: [...entry.attachments] };
      standInByEntryId.set(entry.entryId, standIn);
      chatView.upsert([standIn]);
    }
    const recordedEntryIds = [...standInByEntryId.keys()].filter((entryId) => !entryIdsAwaitingFeed.has(entryId) && !submittedEntries.some((entry) => entry.entryId === entryId));
    chatView.showQueued(entries.filter((entry) => entry.state !== 'submitted'));
    if (recordedEntryIds.length === 0) return;
    for (const entryId of recordedEntryIds) entryIdsAwaitingFeed.add(entryId);
    feed.whenCaughtUp(() => removeStandIns(recordedEntryIds));
    feed.refresh();
  };
  const showFailure = (failureText: string | null) => {
    failureLine.hidden = failureText === null;
    failureLine.textContent = failureText ?? '';
  };
  root.append(failureLine, chatView.element);
  let runningSubagents: readonly RunningSubagent[] = [];
  const showRail = () => {
    const isMachineLogin = sessionAccountIdOf(sessionId) === null;
    const vendor = isMachineLogin ? planVendorOfAgent(sessionUIs.get(sessionId)?.agent) : null;
    chatView.showRail(railFieldsOf({
      meter: sessionMeterOf(sessionId),
      selection: sessionModelSelectionOf(sessionId),
      planLimits: vendor === null ? null : planLimitsOf(vendor),
      sessionCostUSD: sessionCostOf(sessionId),
      subagents: runningSubagents,
      nowMs: clock.nowMs(),
    }));
  };
  showRail();
  let railTimer: ReturnType<typeof setInterval> | null = setInterval(showRail, RAIL_TICK_MS);
  const stopRail = () => {
    if (railTimer !== null) clearInterval(railTimer);
    railTimer = null;
  };
  chatView.setTurnRunning(isSessionWorking(sessionId));
  let shownApproval: ShownApproval | null = null;
  let terminalCardState: TerminalCardState = 'hidden';
  let terminalCardSerial = 0;
  let terminalCardId: string | null = null;
  let terminalHome: HTMLElement | null = null;
  let strayChildWatcher: MutationObserver | null = null;

  const keepPendingPartsLast = () => {
    const openCardIds = shownApproval?.cards.filter((card) => card.resolution === null).map((card) => card.cardId) ?? [];
    const terminalCardIds = terminalCardId === null ? [] : [terminalCardId];
    const standInIds = [...standInByEntryId.values()].map((standIn) => standIn.id);
    chatView.keepLast([...openCardIds, ...terminalCardIds, ...standInIds]);
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
    if (card.cardType === 'permission' && action === 'deny-with-message') {
      if (!sendControlMsg({ type: 'decide-approval', id: sessionId, requestId, decision: 'deny', message: value })) {
        showFailure(NOT_SENT_TEXT);
        return;
      }
      resolveCard({ ...card, resolution: { decision: 'deny', message: value } });
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

  root.addEventListener('chat-attach', (event) => {
    const files = attachedFilesOf(event);
    const uploadingCount = uploadingCountBySessionId.get(sessionId) ?? 0;
    const openSlots = Math.max(0, CHAT_SEND_MAX_ATTACHMENTS - chatView.readAttachments().length - uploadingCount);
    if (files.length > openSlots) showFailure(TOO_MANY_ATTACHMENTS_TEXT);
    const filesToStore = files.slice(0, openSlots);
    if (filesToStore.length === 0) return;
    uploadingCountBySessionId.set(sessionId, uploadingCount + filesToStore.length);
    const releaseSlots = () => uploadingCountBySessionId.set(sessionId, Math.max(0, (uploadingCountBySessionId.get(sessionId) ?? 0) - filesToStore.length));
    void storeFilesForChat(sessionId, filesToStore).then(
      (storedFileNames) => {
        releaseSlots();
        restoreAttachmentsToSession(sessionId, storedFileNames);
      },
      releaseSlots,
    );
  });

  root.addEventListener('chat-send', (event) => {
    const chatSend = chatSendOf(event);
    if (chatSend === null) return;
    showFailure(null);
    sendChatText(sessionId, chatSend.text, chatSend.attachments);
  });
  root.addEventListener('chat-cancel', (event) => {
    const entryId = cancelledEntryIdOf(event);
    if (entryId !== null) cancelOutboxEntry(sessionId, entryId);
  });
  root.addEventListener('chat-escape', (event) => {
    const newestCancellable = (outboxBySessionId.get(sessionId) ?? []).findLast((entry) => entry.state === 'held' || entry.state === 'failed');
    if (!newestCancellable) return;
    event.preventDefault();
    cancelOutboxEntry(sessionId, newestCancellable.entryId);
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
    requestPage: (payload) => sendControlRequest('session-trace', payload, { timeoutMs: TRACE_PAGE_TIMEOUT_MS }),
    onPartsChanged: (changedParts, droppedPartIds) => {
      chatView.upsert(changedParts);
      chatView.remove(droppedPartIds);
      keepPendingPartsLast();
    },
    onTurnMarks: (marks) => chatView.markTurn(marks),
    onSubagents: (subagents) => {
      runningSubagents = subagents;
      showRail();
    },
    isTurnOver: () => !isSessionWorking(sessionId),
    onBeats: (beats) => chatView.beat(beats),
    onReset: () => {
      releaseTerminal();
      shownApproval = null;
      const freshView = createChatView(uploadUrlFor(sessionId));
      freshView.restoreDraft(chatView.readDraft());
      for (const fileName of chatView.readAttachments()) freshView.showAttachment(fileName);
      freshView.showQueued((outboxBySessionId.get(sessionId) ?? []).filter((entry) => entry.state !== 'submitted'));
      freshView.upsert([...standInByEntryId.values()]);
      freshView.setTurnRunning(isSessionWorking(sessionId));
      chatView.element.replaceWith(freshView.element);
      chatView = freshView;
      runningSubagents = [];
      showRail();
      syncWaitingCards();
    },
    onFailure: showFailure,
  });
  showOutbox();
  return {
    sessionId,
    root,
    feed,
    wasSessionWorking: isSessionWorking(sessionId),
    setTurnRunning: (isTurnRunning) => chatView.setTurnRunning(isTurnRunning),
    showOutbox,
    restoreText: (text) => chatView.restoreDraft(draftWithRestoredText(text, chatView.readDraft())),
    restoreAttachments: (fileNames) => {
      for (const fileName of fileNames) chatView.showAttachment(fileName);
    },
    showFailure,
    syncWaitingCards,
    showRail,
    resumeRail: () => {
      showRail();
      if (railTimer === null) railTimer = setInterval(showRail, RAIL_TICK_MS);
    },
    park: () => {
      stopRail();
      draftBySessionId.set(sessionId, chatView.readDraft());
      releaseTerminal();
    },
    close: () => {
      stopRail();
      draftBySessionId.set(sessionId, chatView.readDraft());
      draftAttachmentsBySessionId.set(sessionId, chatView.readAttachments());
      releaseTerminal();
      feed.close();
    },
  };
}

function isReaderAwayFromLatest(chat: MountedChat): boolean {
  return chat.root.querySelector<HTMLButtonElement>('.chat-jump-slot button')?.hidden === false;
}

function unmountChat(): void {
  if (!mountedChat) return;
  const shownChat = mountedChat;
  mountedChat = null;
  const shouldKeepPlace = isReaderAwayFromLatest(shownChat);
  shownChat.root.remove();
  if (!shouldKeepPlace) {
    shownChat.close();
    return;
  }
  shownChat.park();
  keptChatBySessionId.set(shownChat.sessionId, shownChat);
}

function dropKeptChatsOfGoneSessions(): void {
  for (const [sessionId, keptChat] of keptChatBySessionId) {
    if (sessionUIs.has(sessionId)) continue;
    keptChat.close();
    keptChatBySessionId.delete(sessionId);
  }
}

function dropAllKeptChats(): void {
  for (const keptChat of keptChatBySessionId.values()) keptChat.close();
  keptChatBySessionId.clear();
}

export function noteChatApproval(sessionId: string, approval: ConversationApproval | null): void {
  approvalBySessionId.set(sessionId, approval);
}

export function noteChatOutbox(sessionId: string, entries: ChatOutboxEntry[]): void {
  outboxBySessionId.set(sessionId, entries);
  if (mountedChat?.sessionId === sessionId) mountedChat.showOutbox();
}

export function applyChatTraceChanged(sessionId: string): void {
  if (mountedChat?.sessionId !== sessionId) return;
  mountedChat.feed.refresh();
}

export function applyChatSnapshot(rows: readonly { id: string; conversationApproval?: ConversationApproval | null; chatOutbox?: ChatOutboxEntry[] }[]): void {
  approvalBySessionId.clear();
  outboxBySessionId.clear();
  for (const row of rows) {
    noteChatApproval(row.id, row.conversationApproval ?? null);
    noteChatOutbox(row.id, row.chatOutbox ?? []);
  }
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
  if (!isWorking) mountedChat.feed.endTurn();
}

subscribeUsage((change) => {
  if (change === 'refresh-status' || change === 'report') return;
  mountedChat?.showRail();
});

subscribeSettings((change) => {
  if (change.kind !== 'broadcast') return;
  const isEnabled = isChatEnabled();
  const hasJustEnabled = isEnabled && !wasChatEnabled;
  wasChatEnabled = isEnabled;
  if (!isEnabled && mountedChat && isSessionPageOpen(CHAT_PAGE_ID, mountedChat.sessionId)) closeSessionPage();
  if (!isEnabled) dropAllKeptChats();
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
    dropKeptChatsOfGoneSessions();
    setSessionView('chat');
    const keptChat = keptChatBySessionId.get(sessionId);
    keptChatBySessionId.delete(sessionId);
    mountedChat = keptChat ?? buildChat(sessionId);
    host.append(mountedChat.root);
    mountedChat.showOutbox();
    mountedChat.resumeRail();
    applyChatSessionStatus(sessionId);
    mountedChat.feed.refresh();
  },
  unmount: unmountChat,
  didCloseByOperator: () => setSessionView('terminal'),
  canStepBack: () => false,
  stepBack: () => {},
};
