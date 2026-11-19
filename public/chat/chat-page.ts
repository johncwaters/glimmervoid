import { CHAT_SEND_MAX_ATTACHMENTS, type AgentDoneLine, type ChatOutboxEntry, type ConversationApproval } from '#shared/contracts/session.ts';
import { CHAT_SEND_MAX_CHARS } from '#shared/contracts/control/session-messages.ts';
import { API_KEY_PROMPT_KIND, LOGIN_PROMPT_KINDS, STATES } from '#shared/states.ts';
import { errorMessage } from '#shared/text.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { adoptElement, el, isRealInputOwningKey, releaseElement } from '../dom-helpers.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { sendTerminalInput } from '../session-card/terminal-input.ts';
import { announceSessionPageChange, closeSessionPage, isSessionPageOpen, openSessionPageOnShownSession } from '../session-pages/session-pages.ts';
import type { SessionPage } from '../session-pages/session-pages.ts';
import { settingsPayloadSnapshot, subscribeSettings } from '../settings/settings-store.ts';
import { CHAT_ICON_PATH } from '../svg-dom.ts';
import { getSessionView, setSessionView } from '../ui-prefs.ts';
import { holdCardKeys, keyTargetOf } from './chat-cards.ts';
import { createChatFeed } from './chat-feed.ts';
import type { ChatFeed } from './chat-feed.ts';
import type { ChatCard, ChatPart, SignInStage } from './chat-part.ts';
import { agentLabel } from '../arena/lineup-core.ts';
import { createChatView } from './chat-view.ts';
import { type ChatPhase, chatPhaseOf } from './chat-activity-core.ts';
import { storeFilesForChat } from '../session-upload.ts';
import { sessionAccountIdOf, sessionModelSelectionOf, sessionWorkingDirectoryOf } from '../session-card/card-model.ts';
import { clock } from '#shared/clock.ts';
import { planLimitsOf, sessionCostOf, sessionMeterOf, subscribeUsage } from '../usage/usage-store.ts';
import { planVendorOfAgent, railFieldsOf } from './status-rail-core.ts';
import type { RunningSubagent } from './status-rail-core.ts';
import { onReviewChange, reviewOf } from '../review/review-store.ts';
import { createDonePanel } from './done-panel.ts';
import { ACCEPT_MESSAGE, donePanelModelOf, sendBackMessageOf } from './done-panel-core.ts';

const CHAT_PAGE_ID = 'chat';
const TRACE_PAGE_TIMEOUT_MS = 10000;
const CHAT_SEND_TIMEOUT_MS = 10000;
const RAIL_TICK_MS = 30_000;
const ESCAPE_KEY = String.fromCharCode(27);
const NOT_SENT_TEXT = 'Not connected to the server, so the message was not sent.';
const TOO_MANY_ATTACHMENTS_TEXT = `A Chat message carries up to ${CHAT_SEND_MAX_ATTACHMENTS} files, so the rest were not attached.`;
const TOO_MANY_TO_SEND_TEXT = `A Chat message carries up to ${CHAT_SEND_MAX_ATTACHMENTS} files. Remove some and send again.`;
const uploadingCountBySessionId = new Map<string, number>();
const STAND_IN_UNRECORDED_MAX_MS = 5000;
const SENT_OUTBOX_STATES: ReadonlySet<ChatOutboxEntry['state']> = new Set(['sending', 'submitted']);

const LIVE_TERMINAL_HEADING = 'The agent is waiting on its terminal';
const LOGIN_COMMAND_BY_AGENT: Readonly<Record<string, string>> = { 'claude-code': '/login' };
const LOGIN_SUBMIT_DELAY_MS = 300;
const SIGNED_IN_STATES: ReadonlySet<string> = new Set([STATES.COMPLETE, STATES.IDLE]);

type SignInCard = Extract<ChatCard, { cardType: 'sign-in' }>;

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
  shownPhase: ChatPhase;
  setPhase(phase: ChatPhase): void;
  showOutbox(): void;
  restoreText(text: string): void;
  restoreAttachments(fileNames: readonly string[]): void;
  showFailure(failureText: string | null): void;
  syncWaitingCards(): void;
  showRail(): void;
  showDone(): void;
  resumeRail(): void;
  park(): void;
  close(): void;
}

const approvalBySessionId = new Map<string, ConversationApproval | null>();
const draftBySessionId = new Map<string, string>();
const draftAttachmentsBySessionId = new Map<string, string[]>();
const outboxBySessionId = new Map<string, ChatOutboxEntry[]>();
const doneMeansBySessionId = new Map<string, readonly string[]>();
const agentDoneLinesBySessionId = new Map<string, readonly AgentDoneLine[]>();
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

function sessionPhaseOf(sessionId: string): ChatPhase {
  return chatPhaseOf(sessionUIs.get(sessionId)?.currentState);
}

function isSessionWorking(sessionId: string): boolean {
  return sessionPhaseOf(sessionId) === 'working';
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

const ANSWERABLE_CARD_TYPES = ['question', 'permission', 'sign-in'] as const;
const ANSWERABLE_CARD_TYPE_MATCH = `:is(${ANSWERABLE_CARD_TYPES.map((cardType) => `[data-card-type="${cardType}"]`).join(', ')})`;
const OPEN_ANSWERABLE_CARD_SELECTOR = `.chat-card[data-resolved="false"][data-keys-ready]${ANSWERABLE_CARD_TYPE_MATCH}`;
const UNANSWERED_CARD_SELECTOR = `.chat-card[data-resolved="false"]${ANSWERABLE_CARD_TYPE_MATCH}`;
const READY_DONE_PANEL_SELECTOR = '.chat-done:not([hidden])[data-keys-ready]';
const DONE_PANEL_COMPOSER_KEY = 'Enter';

function isComposerFocused(root: HTMLElement): boolean {
  const focused = document.activeElement;
  return focused instanceof HTMLTextAreaElement && root.contains(focused);
}

const FOCUSABLE_CONTROL_SELECTOR = 'button, a[href], input, select, textarea, summary, [contenteditable="true"], [role="button"], [tabindex]:not([tabindex="-1"])';

function isFocusOnOtherControl(): boolean {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement)) return false;
  if (focused.classList.contains('chat-composer-input')) return false;
  return focused.closest(FOCUSABLE_CONTROL_SELECTOR) !== null;
}

function isCardPickKeydown(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (isFocusOnOtherControl()) return false;
  return !isRealInputOwningKey(event);
}

function chatKeyTargetOf(root: HTMLElement, key: string): { target: HTMLElement; heldSelector: string } | null {
  const openCard = root.querySelector<HTMLElement>(OPEN_ANSWERABLE_CARD_SELECTOR);
  if (openCard) {
    const cardTarget = keyTargetOf(openCard, key);
    return cardTarget ? { target: cardTarget, heldSelector: OPEN_ANSWERABLE_CARD_SELECTOR } : null;
  }
  if (root.querySelector(UNANSWERED_CARD_SELECTOR)) return null;
  const donePanel = root.querySelector<HTMLElement>(READY_DONE_PANEL_SELECTOR);
  if (!donePanel?.querySelector('.chat-done-foot')) return null;
  if (key !== DONE_PANEL_COMPOSER_KEY && isComposerFocused(root)) return null;
  const panelTarget = keyTargetOf(donePanel, key);
  if (!panelTarget) return null;
  return { target: panelTarget, heldSelector: READY_DONE_PANEL_SELECTOR };
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
  const entryIdsTakenByPrompt = new Set<string>();
  const unrecordedTimerByEntryId = new Map<string, ReturnType<typeof setTimeout>>();
  const shownPromptPartIds = new Set<string>();
  const removeStandIns = (entryIds: readonly string[]) => {
    for (const entryId of entryIds) {
      const standIn = standInByEntryId.get(entryId);
      if (standIn) chatView.remove([standIn.id]);
      standInByEntryId.delete(entryId);
      clearTimeout(unrecordedTimerByEntryId.get(entryId));
      unrecordedTimerByEntryId.delete(entryId);
    }
  };
  const awaitPromptFor = (entryId: string) => {
    if (unrecordedTimerByEntryId.has(entryId)) return;
    unrecordedTimerByEntryId.set(entryId, setTimeout(() => {
      feed.whenCaughtUp(() => removeStandIns([entryId]));
      feed.refresh();
    }, STAND_IN_UNRECORDED_MAX_MS));
  };
  const countNewPromptParts = (changedParts: readonly ChatPart[], droppedPartIds: readonly string[]) => {
    for (const droppedPartId of droppedPartIds) shownPromptPartIds.delete(droppedPartId);
    const newPromptParts = changedParts.filter((part) => part.kind === 'prompt' && !shownPromptPartIds.has(part.id));
    for (const promptPart of newPromptParts) shownPromptPartIds.add(promptPart.id);
    return newPromptParts.length;
  };
  const swapStandInsForPrompts = (newPromptCount: number) => {
    const takenEntryIds = [...standInByEntryId.keys()].slice(0, newPromptCount);
    for (const entryId of takenEntryIds) entryIdsTakenByPrompt.add(entryId);
    removeStandIns(takenEntryIds);
  };
  const showOutbox = () => {
    const entries = outboxBySessionId.get(sessionId) ?? [];
    const sentEntries = entries.filter((entry) => SENT_OUTBOX_STATES.has(entry.state));
    for (const entryId of entryIdsTakenByPrompt) {
      if (!sentEntries.some((entry) => entry.entryId === entryId)) entryIdsTakenByPrompt.delete(entryId);
    }
    for (const entry of sentEntries) {
      if (standInByEntryId.has(entry.entryId) || entryIdsTakenByPrompt.has(entry.entryId)) continue;
      const standIn: ChatPart = { kind: 'prompt', id: `sent-${entry.entryId}`, text: entry.text, at: clock.nowMs(), attachments: [...entry.attachments] };
      standInByEntryId.set(entry.entryId, standIn);
      chatView.upsert([standIn]);
    }
    const unsentEntryIds = [...standInByEntryId.keys()].filter((entryId) => entries.some((entry) => entry.entryId === entryId && !SENT_OUTBOX_STATES.has(entry.state)));
    removeStandIns(unsentEntryIds);
    chatView.showQueued(entries.filter((entry) => !SENT_OUTBOX_STATES.has(entry.state)));
    const clearedEntryIds = [...standInByEntryId.keys()].filter((entryId) => !entries.some((entry) => entry.entryId === entryId));
    if (clearedEntryIds.length === 0) return;
    for (const entryId of clearedEntryIds) awaitPromptFor(entryId);
    feed.refresh();
  };
  const showFailure = (failureText: string | null) => {
    failureLine.hidden = failureText === null;
    failureLine.textContent = failureText ?? '';
  };
  const doneModelNow = () => donePanelModelOf({ run: reviewOf(sessionId)?.verification ?? null, doneMeans: doneMeansBySessionId.get(sessionId) ?? [], agentDoneLines: agentDoneLinesBySessionId.get(sessionId) ?? [], phase: sessionPhaseOf(sessionId) });
  const donePanel = createDonePanel({
    onSendBack: () => {
      const doneModel = doneModelNow();
      if (doneModel === null) return;
      showFailure(null);
      sendChatText(sessionId, sendBackMessageOf(doneModel, CHAT_SEND_MAX_CHARS), []);
    },
    onAccept: () => {
      showFailure(null);
      sendChatText(sessionId, ACCEPT_MESSAGE, []);
    },
  });
  const showDone = () => donePanel.show(doneModelNow());
  sendControlMsg({ type: 'request-verification', id: sessionId });
  chatView.mountAfterActivity(donePanel.element);
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
  chatView.setPhase(sessionPhaseOf(sessionId));
  let shownApproval: ShownApproval | null = null;
  let terminalCardState: TerminalCardState = 'hidden';
  let terminalCardSerial = 0;
  let terminalCardId: string | null = null;
  let terminalHome: HTMLElement | null = null;
  let strayChildWatcher: MutationObserver | null = null;
  let signInCard: SignInCard | null = null;
  let signInCardSerial = 0;

  const keepPendingPartsLast = () => {
    const openCardIds = shownApproval?.cards.filter((card) => card.resolution === null).map((card) => card.cardId) ?? [];
    const terminalCardIds = [terminalCardId, signInCard?.cardId ?? null].filter((cardId): cardId is string => cardId !== null);
    const standInIds = [...standInByEntryId.values()].map((standIn) => standIn.id);
    chatView.keepLast([...standInIds, ...openCardIds, ...terminalCardIds]);
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

  const lendTerminalToCard = (cardId: string): boolean => {
    const ui = sessionUIs.get(sessionId);
    const slot = [...chatView.element.querySelectorAll<HTMLElement>('.chat-terminal-slot')].find((candidate) => candidate.closest<HTMLElement>('[data-part-id]')?.dataset.partId === cardId);
    if (!ui || !slot) return false;
    terminalCardState = 'borrowed';
    terminalHome = el('div', 'terminal-wrap-home');
    terminalHome.hidden = true;
    ui.termWrap.before(terminalHome);
    adoptElement(ui.termWrap, slot);
    strayChildWatcher = new MutationObserver(() => sendStrayChildrenHome(slot, ui.termWrap));
    strayChildWatcher.observe(slot, { childList: true });
    ui._ensureTerminalReady?.();
    return true;
  };

  const borrowTerminal = () => {
    if (terminalCardState === 'borrowed') return;
    if (!sessionUIs.has(sessionId)) return;
    terminalCardSerial += 1;
    const card: ChatCard = { cardType: 'live-terminal', cardId: `live-terminal-${terminalCardSerial}`, data: { heading: LIVE_TERMINAL_HEADING }, resolution: null };
    chatView.upsert([cardPartOf(card)]);
    if (lendTerminalToCard(card.cardId)) terminalCardId = card.cardId;
  };

  const showSignInCard = (card: SignInCard) => {
    signInCard = card;
    chatView.upsert([cardPartOf(card)]);
  };

  const settleSignInCard = () => {
    const shownCard = signInCard;
    if (!shownCard) return;
    signInCard = null;
    if (shownCard.data.stage === 'signing-in') releaseTerminal();
    const sessionState = sessionUIs.get(sessionId)?.currentState;
    const hasSignedIn = shownCard.data.stage !== 'refused-key' && sessionState !== undefined && SIGNED_IN_STATES.has(sessionState);
    if (!hasSignedIn) {
      chatView.remove([shownCard.cardId]);
      return;
    }
    chatView.upsert([cardPartOf({ ...shownCard, resolution: { isSignedIn: true } })]);
  };

  const relendSignInTerminal = () => {
    if (signInCard?.data.stage !== 'signing-in' || terminalCardState === 'borrowed') return;
    lendTerminalToCard(signInCard.cardId);
  };

  const offerSignInCard = (loginKind: string) => {
    if (signInCard) {
      relendSignInTerminal();
      return;
    }
    const agent = sessionUIs.get(sessionId)?.agent ?? '';
    const stage: SignInStage = loginKind === API_KEY_PROMPT_KIND ? 'refused-key' : 'offered';
    releaseTerminal();
    signInCardSerial += 1;
    showSignInCard({ cardType: 'sign-in', cardId: `sign-in-${signInCardSerial}`, data: { agentName: agentLabel(agent), stage }, resolution: null });
  };

  const startSignIn = () => {
    const ui = sessionUIs.get(sessionId);
    const loginCommand = LOGIN_COMMAND_BY_AGENT[ui?.agent ?? ''];
    if (!signInCard || signInCard.data.stage !== 'offered' || !ui || !loginCommand) return;
    if (!sendTerminalInput(ui, loginCommand)) {
      showFailure(NOT_SENT_TEXT);
      return;
    }
    window.setTimeout(() => sendTerminalInput(ui, '\r'), LOGIN_SUBMIT_DELAY_MS);
    const signingInCard: SignInCard = { ...signInCard, data: { ...signInCard.data, stage: 'signing-in' } };
    chatView.keepLogInPlace(() => {
      showSignInCard(signingInCard);
      lendTerminalToCard(signingInCard.cardId);
    });
  };

  const loginKindOfSession = (): string | null => {
    const ui = sessionUIs.get(sessionId);
    const kind = ui?.pendingPromptKind ?? null;
    if (ui?.currentState !== STATES.WAITING || kind === null || !LOGIN_PROMPT_KINDS.has(kind)) return null;
    if (kind !== API_KEY_PROMPT_KIND && !LOGIN_COMMAND_BY_AGENT[ui.agent ?? '']) return null;
    return kind;
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
    const loginKind = isAnswerableFromChat ? null : loginKindOfSession();
    if (loginKind === null) settleSignInCard();
    if (loginKind !== null) {
      offerSignInCard(loginKind);
      return;
    }
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
    if (signInCard?.cardId === cardId && action === 'sign-in') {
      startSignIn();
      return;
    }
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
  root.addEventListener('keydown', (event) => {
    if (!isCardPickKeydown(event)) return;
    if (chatView.readDraft() !== '' || chatView.readAttachments().length > 0) return;
    const keyTarget = chatKeyTargetOf(root, event.key);
    if (!keyTarget) return;
    event.preventDefault();
    event.stopPropagation();
    if (keyTarget.target instanceof HTMLInputElement) {
      keyTarget.target.focus();
      return;
    }
    keyTarget.target.click();
    root.querySelectorAll<HTMLElement>(keyTarget.heldSelector).forEach(holdCardKeys);
  }, { capture: true });

  const feed = createChatFeed({
    sessionId,
    workingDirectory: sessionWorkingDirectoryOf(sessionId) ?? sessionUIs.get(sessionId)?.path ?? null,
    requestPage: (payload) => sendControlRequest('session-trace', payload, { timeoutMs: TRACE_PAGE_TIMEOUT_MS }),
    onPartsChanged: (changedParts, droppedPartIds, isLive) => {
      chatView.upsert(changedParts);
      chatView.remove(droppedPartIds);
      const newPromptCount = countNewPromptParts(changedParts, droppedPartIds);
      if (isLive) swapStandInsForPrompts(newPromptCount);
      keepPendingPartsLast();
    },
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
      freshView.showQueued((outboxBySessionId.get(sessionId) ?? []).filter((entry) => !SENT_OUTBOX_STATES.has(entry.state)));
      shownPromptPartIds.clear();
      freshView.upsert([...standInByEntryId.values()]);
      freshView.setPhase(sessionPhaseOf(sessionId));
      chatView.element.replaceWith(freshView.element);
      chatView = freshView;
      if (signInCard) showSignInCard(signInCard);
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
    shownPhase: sessionPhaseOf(sessionId),
    setPhase: (phase) => {
      chatView.setPhase(phase);
      showDone();
    },
    showOutbox,
    restoreText: (text) => chatView.restoreDraft(draftWithRestoredText(text, chatView.readDraft())),
    restoreAttachments: (fileNames) => {
      for (const fileName of fileNames) chatView.showAttachment(fileName);
    },
    showFailure,
    syncWaitingCards,
    showRail,
    showDone,
    resumeRail: () => {
      showRail();
      if (railTimer === null) railTimer = setInterval(showRail, RAIL_TICK_MS);
    },
    park: () => {
      stopRail();
      chatView.forgetPaintedTurns();
      draftBySessionId.set(sessionId, chatView.readDraft());
      releaseTerminal();
    },
    close: () => {
      stopRail();
      draftBySessionId.set(sessionId, chatView.readDraft());
      draftAttachmentsBySessionId.set(sessionId, chatView.readAttachments());
      releaseTerminal();
      for (const timer of unrecordedTimerByEntryId.values()) clearTimeout(timer);
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

export function noteChatDoneMeans(sessionId: string, doneMeans: readonly string[], agentDoneLines: readonly AgentDoneLine[]): void {
  doneMeansBySessionId.set(sessionId, doneMeans);
  agentDoneLinesBySessionId.set(sessionId, agentDoneLines);
  if (mountedChat?.sessionId === sessionId) mountedChat.showDone();
}

export function noteChatAgentDoneLines(sessionId: string, agentDoneLines: readonly AgentDoneLine[]): void {
  agentDoneLinesBySessionId.set(sessionId, agentDoneLines);
  if (mountedChat?.sessionId === sessionId) mountedChat.showDone();
}

export function noteChatOutbox(sessionId: string, entries: ChatOutboxEntry[]): void {
  outboxBySessionId.set(sessionId, entries);
  if (mountedChat?.sessionId === sessionId) mountedChat.showOutbox();
}

export function applyChatTraceChanged(sessionId: string): void {
  if (mountedChat?.sessionId !== sessionId) return;
  mountedChat.feed.refresh();
}

export function applyChatSnapshot(rows: readonly { id: string; conversationApproval?: ConversationApproval | null; chatOutbox?: ChatOutboxEntry[]; doneMeans?: readonly string[]; agentDoneLines?: readonly AgentDoneLine[] }[]): void {
  approvalBySessionId.clear();
  outboxBySessionId.clear();
  doneMeansBySessionId.clear();
  agentDoneLinesBySessionId.clear();
  for (const row of rows) {
    noteChatApproval(row.id, row.conversationApproval ?? null);
    noteChatOutbox(row.id, row.chatOutbox ?? []);
    noteChatDoneMeans(row.id, row.doneMeans ?? [], row.agentDoneLines ?? []);
  }
  if (!mountedChat) return;
  applyChatSessionStatus(mountedChat.sessionId);
  mountedChat.feed.refresh();
}

export function applyChatSessionStatus(sessionId: string): void {
  if (mountedChat?.sessionId !== sessionId) return;
  mountedChat.syncWaitingCards();
  const phase = sessionPhaseOf(sessionId);
  if (phase === mountedChat.shownPhase) return;
  const wasWorking = mountedChat.shownPhase === 'working';
  mountedChat.shownPhase = phase;
  mountedChat.setPhase(phase);
  if (wasWorking && phase !== 'working') mountedChat.feed.endTurn();
}

onReviewChange((sessionId) => {
  if (mountedChat?.sessionId === sessionId) mountedChat.showDone();
});

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
    mountedChat.showDone();
    applyChatSessionStatus(sessionId);
    mountedChat.feed.refresh();
  },
  unmount: unmountChat,
  didCloseByOperator: () => setSessionView('terminal'),
  canStepBack: () => false,
  stepBack: () => {},
};
