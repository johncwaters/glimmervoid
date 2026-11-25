import type { TraceRecord } from '#shared/contracts/trace.ts';
import { CHAT_SEND_MAX_ATTACHMENTS, type AgentDoneLine, type ChatOutboxEntry, type ConversationApproval } from '#shared/contracts/session.ts';
import type { PlanGate } from '#shared/contracts/plan-gate.ts';
import { errorMessage } from '#shared/text.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { announceSessionPageChange, closeSessionPage, isSessionPageOpen, openSessionPageOnShownSession } from '../page-registry.ts';
import type { SessionPage } from '../page-registry.ts';
import { settingsPayloadSnapshot, subscribeSettings } from '../settings/settings-store.ts';
import { CHAT_ICON_PATH } from '../svg-dom.ts';
import { getSessionView, setSessionView } from '../ui-prefs.ts';
import { refreshLimitCountdowns } from './chat-cards.ts';
import { createChatFeed } from './chat-feed.ts';
import type { ChatFeed } from './chat-feed.ts';
import type { ChatCard, ChatPart } from './chat-part.ts';
import { CHAT_NEAR_TOP_EVENT, createChatView, NO_ARRIVING_PARTS } from './chat-view.ts';
import { type ChatPhase, chatPhaseOf, shownChatPhaseOf } from './chat-activity-core.ts';
import { storeFilesForChat } from '../session-upload.ts';
import { canSwitchSessionModel, sessionAccountIdOf, sessionModelSelectionOf, sessionWorkingDirectoryOf } from '../session-card/card-model.ts';
import { clock } from '#shared/clock.ts';
import { accountPlanLimitsOf, planLimitsOf, sessionCostOf, sessionMeterOf, subscribeUsage } from '../usage/usage-store.ts';
import { planVendorOfAgent, railFieldsOf } from './status-rail-core.ts';
import type { RailField } from './status-rail-core.ts';
import { listenForModelChange } from './model-picker.ts';
import { onReviewChange, reviewOf } from '../review/review-store.ts';
import { createDonePanel } from './done-panel.ts';
import { refreshChatFileRefs } from './chat-parts.ts';
import { changedCardsOf, markAgentChangeShown, onAgentChange } from '../whiteboard/board-tile-store.ts';
import type { AgentChip } from '../whiteboard/board-tile-store.ts';
import { boardSummariesOf } from '../whiteboard/board-store.ts';
import { openBoardAtAgentChange } from '../whiteboard/board-chips.ts';
import { donePanelModelOf } from './done-panel-core.ts';
import { chatDraftOf, chatSessionStateOf, clearChatSnapshotState, noteChatOutboxEntries, pruneChatDraftsForSessions, saveChatDraft, scheduleChatDraftSave } from './chat-session-state.ts';
import { createOutboxEchoState, isOutboxAwaitingTurn, newestCancellableOutboxEntryOf, queuedOutboxEntriesOf, reconcileOutboxEcho, takeStandInsForPrompts } from './outbox-echo-core.ts';
import { cardPartOf, createChatWaits } from './chat-waits.ts';

const CHAT_PAGE_ID = 'chat';
const TRACE_PAGE_TIMEOUT_MS = 10000;
const CHAT_SEND_TIMEOUT_MS = 10000;
const RAIL_TICK_MS = 30_000;
const RUN_TIME_TICK_MS = 1000;
const NOT_SENT_TEXT = 'Not connected to the server, so the message was not sent.';
const TOO_MANY_ATTACHMENTS_TEXT = `A Chat message carries up to ${CHAT_SEND_MAX_ATTACHMENTS} files, so the rest were not attached.`;
const TOO_MANY_TO_SEND_TEXT = `A Chat message carries up to ${CHAT_SEND_MAX_ATTACHMENTS} files. Remove some and send again.`;

interface MountedChat {
  sessionId: string;
  root: HTMLElement;
  feed: ChatFeed;
  shownPhase: ChatPhase;
  isShownTurnRunning: boolean;
  phaseToShow(): ChatPhase;
  setPhase(phase: ChatPhase, isTurnRunning: boolean): void;
  showOutbox(): void;
  restoreText(text: string): void;
  restoreAttachments(fileNames: readonly string[]): void;
  showFailure(failureText: string | null): void;
  syncWaitingCards(): void;
  showRail(): void;
  showDone(): void;
  showBoardChanges(): void;
  catchUp(): void;
  resumeRail(): void;
  park(): void;
  close(): void;
}

let mountedChat: MountedChat | null = null;
const keptChatBySessionId = new Map<string, MountedChat>();
let wasChatEnabled = false;

function isChatEnabled(): boolean {
  const sessionChat = settingsPayloadSnapshot().sessionChat;
  return typeof sessionChat === 'object' && sessionChat !== null && 'enabled' in sessionChat && sessionChat.enabled === true;
}

export function draftWithRestoredText(restoredText: string, draft: string): string {
  if (draft.trim().length === 0) return restoredText;
  return `${restoredText}\n\n${draft}`;
}

function sessionPhaseOf(sessionId: string): ChatPhase {
  return chatPhaseOf(sessionUIs.get(sessionId)?.currentState);
}

function isSessionWorking(sessionId: string): boolean {
  return sessionPhaseOf(sessionId) === 'working';
}

function detailFieldOf(event: Event, key: string): unknown {
  if (!(event instanceof CustomEvent) || typeof event.detail !== 'object' || event.detail === null) return undefined;
  return Reflect.get(event.detail, key);
}

export function stringDetailOf(event: Event, key: string): string | null {
  const value = detailFieldOf(event, key);
  return typeof value === 'string' ? value : null;
}

interface ChatListenerTargets {
  sessionId: string;
  root: HTMLElement;
  readAttachmentCount: () => number;
  showFailure: (failureText: string | null) => void;
  newestCancellableEntryId: () => string | null;
  answerCard: (cardId: string, action: string, value: string) => void;
  handleKeydown: (event: KeyboardEvent) => void;
}

function attachChatListeners(targets: ChatListenerTargets): void {
  const { sessionId, root, readAttachmentCount, showFailure, newestCancellableEntryId, answerCard, handleKeydown } = targets;
  const sessionState = chatSessionStateOf(sessionId);
  root.addEventListener('chat-attach', (event) => {
    const rawFiles = detailFieldOf(event, 'files');
    const files = Array.isArray(rawFiles) ? rawFiles.filter((file): file is File => file instanceof File) : [];
    const openSlots = Math.max(0, CHAT_SEND_MAX_ATTACHMENTS - readAttachmentCount() - sessionState.uploadingCount);
    if (files.length > openSlots) showFailure(TOO_MANY_ATTACHMENTS_TEXT);
    const filesToStore = files.slice(0, openSlots);
    if (filesToStore.length === 0) return;
    sessionState.uploadingCount += filesToStore.length;
    const releaseSlots = () => {
      sessionState.uploadingCount = Math.max(0, sessionState.uploadingCount - filesToStore.length);
    };
    void storeFilesForChat(sessionId, filesToStore).then(
      (storedFileNames) => {
        releaseSlots();
        restoreAttachmentsToSession(sessionId, storedFileNames);
      },
      releaseSlots,
    );
  });
  root.addEventListener('chat-draft', (event) => {
    const text = stringDetailOf(event, 'text');
    if (text === null) return;
    if (detailFieldOf(event, 'isImmediate') === true) {
      saveChatDraft(sessionId, text);
      return;
    }
    scheduleChatDraftSave(sessionId, text);
  });
  root.addEventListener('chat-send', (event) => {
    const text = stringDetailOf(event, 'text');
    if (text === null) return;
    const rawAttachments = detailFieldOf(event, 'attachments');
    const attachments = Array.isArray(rawAttachments) ? rawAttachments.filter((fileName): fileName is string => typeof fileName === 'string') : [];
    showFailure(null);
    sendChatText(sessionId, text, attachments);
  });
  root.addEventListener('chat-cancel', (event) => {
    const entryId = stringDetailOf(event, 'entryId');
    if (entryId !== null) cancelOutboxEntry(sessionId, entryId);
  });
  root.addEventListener('chat-escape', (event) => {
    const entryId = newestCancellableEntryId();
    if (entryId === null) return;
    event.preventDefault();
    cancelOutboxEntry(sessionId, entryId);
  });
  root.addEventListener('chat-open-terminal', () => {
    setSessionView('terminal');
    closeSessionPage();
  });
  root.addEventListener('chat-stop', () => {
    sendControlMsg({ type: 'chat-stop', id: sessionId });
  });
  root.addEventListener('chat-send-now', (event) => {
    const entryId = stringDetailOf(event, 'entryId');
    if (entryId !== null) sendControlMsg({ type: 'chat-stop', id: sessionId, entryId });
  });
  root.addEventListener('chat-card', (event) => {
    const cardId = stringDetailOf(event, 'cardId');
    const action = stringDetailOf(event, 'action');
    const value = stringDetailOf(event, 'value');
    if (cardId !== null && action !== null && value !== null) answerCard(cardId, action, value);
  });
  root.addEventListener('keydown', handleKeydown, { capture: true });
}

const TYPING_CONTROL_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

function isOperatorTypingOutside(chatRoot: HTMLElement): boolean {
  if (document.querySelector('.session-row[data-state="CONFIRM_REMOVE"]') !== null) return true;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || chatRoot.contains(focused)) return false;
  if (focused.closest('.session-row-confirm') !== null) return true;
  return focused.matches(TYPING_CONTROL_SELECTOR) && focused.closest('.xterm') === null;
}

function focusMountedComposer(): void {
  if (isPhoneLayout()) return;
  mountedChat?.root.querySelector<HTMLElement>('.chat-composer-input')?.focus({ preventScroll: true });
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
  const sessionState = chatSessionStateOf(sessionId);
  sessionState.draftAttachments = [...sessionState.draftAttachments, ...fileNames];
}

function restoreTextToSession(sessionId: string, text: string): void {
  if (text.length === 0) return;
  const builtChat = builtChatOf(sessionId);
  if (builtChat) {
    builtChat.restoreText(text);
    return;
  }
  if (!sessionUIs.has(sessionId)) return;
  saveChatDraft(sessionId, draftWithRestoredText(text, chatDraftOf(sessionId)));
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

interface RememberedBoardChange {
  serial: number;
  boardChange: AgentChip;
}

interface BoardChangeGroup {
  cardId: string;
  boardChange: AgentChip;
}

const REMEMBERED_BOARD_CHANGES_MAX = 200;
const rememberedBoardChangesBySessionId = new Map<string, RememberedBoardChange[]>();
let rememberedBoardChangeSerial = 0;

function rememberBoardChange(sessionId: string, boardChange: AgentChip): void {
  const rememberedChanges = rememberedBoardChangesBySessionId.get(sessionId) ?? [];
  rememberedBoardChangeSerial += 1;
  rememberedChanges.push({ serial: rememberedBoardChangeSerial, boardChange });
  rememberedBoardChangesBySessionId.set(sessionId, rememberedChanges.slice(-REMEMBERED_BOARD_CHANGES_MAX));
}

function boardChangeGroupsOf(sessionId: string, promptTimes: readonly number[]): BoardChangeGroup[] {
  const groups: BoardChangeGroup[] = [];
  let previousAt: number | null = null;
  for (const { serial, boardChange } of rememberedBoardChangesBySessionId.get(sessionId) ?? []) {
    const lastGroup = groups.at(-1);
    const startAfter = previousAt;
    const isPromptBetween = startAfter === null || promptTimes.some((promptAt) => promptAt > startAfter && promptAt <= boardChange.at);
    previousAt = boardChange.at;
    if (lastGroup && !isPromptBetween) {
      lastGroup.boardChange = boardChange;
      continue;
    }
    groups.push({ cardId: `board-change-${serial}`, boardChange });
  }
  return groups;
}

function boardChangeCardOf(cardId: string, boardChange: AgentChip): ChatCard {
  const boardTitle = boardSummariesOf().find((summary) => summary.id === boardChange.boardId)?.title ?? null;
  return { cardType: 'board-change', cardId, data: { changed: changedCardsOf(boardChange.change), boardTitle }, resolution: null };
}

function buildChat(sessionId: string): MountedChat {
  const sessionState = chatSessionStateOf(sessionId);
  const root = el('div', 'session-chat');
  const failureLine = el('div', 'session-chat-failure');
  failureLine.hidden = true;
  const createSeededView = (draft: string, attachments: readonly string[]) => {
    const view = createChatView(uploadUrlFor(sessionId));
    view.restoreDraft(draft);
    for (const fileName of attachments) view.showAttachment(fileName);
    return view;
  };
  let chatView = createSeededView(chatDraftOf(sessionId), sessionState.draftAttachments);
  sessionState.draftAttachments = [];
  const outboxEcho = createOutboxEchoState();
  const entryIdsAwaitingPrompt = new Set<string>();
  const shownPromptPartIds = new Set<string>();
  const removeStandIns = (entryIds: readonly string[]) => {
    for (const entryId of entryIds) {
      const standIn = outboxEcho.standInByEntryId.get(entryId);
      if (standIn) chatView.remove([standIn.id]);
      outboxEcho.standInByEntryId.delete(entryId);
      entryIdsAwaitingPrompt.delete(entryId);
    }
  };
  const awaitPromptFor = (entryId: string) => {
    if (entryIdsAwaitingPrompt.has(entryId)) return;
    entryIdsAwaitingPrompt.add(entryId);
    feed.whenCaughtUp(() => removeStandIns([entryId]));
  };
  const takeNewPromptParts = (changedParts: readonly ChatPart[], droppedPartIds: readonly string[]) => {
    for (const droppedPartId of droppedPartIds) shownPromptPartIds.delete(droppedPartId);
    const newPromptParts = changedParts.filter((part) => part.kind === 'prompt' && !shownPromptPartIds.has(part.id));
    for (const promptPart of newPromptParts) shownPromptPartIds.add(promptPart.id);
    return newPromptParts;
  };
  let feedPosition: 'unseeded' | 'catching-up' | 'following' = 'unseeded';
  const isOperatorWatching = () => feedPosition === 'following' && mountedChat?.sessionId === sessionId && document.visibilityState === 'visible';
  const catchUp = () => {
    if (feedPosition === 'following') feedPosition = 'catching-up';
    feed.whenCaughtUp(() => {
      if (feedPosition === 'catching-up') feedPosition = 'following';
    });
    feed.refresh();
  };
  const arrivingPartIdsOf = (changedParts: readonly ChatPart[], newPromptParts: readonly ChatPart[]): ReadonlySet<string> => {
    if (!isOperatorWatching()) return NO_ARRIVING_PARTS;
    const promptIdsTakingStandIns = new Set(newPromptParts.slice(0, outboxEcho.standInByEntryId.size).map((part) => part.id));
    return new Set(changedParts.map((part) => part.id).filter((partId) => !promptIdsTakingStandIns.has(partId)));
  };
  const swapStandInsForPrompts = (newPromptCount: number) => {
    removeStandIns(takeStandInsForPrompts(outboxEcho, newPromptCount));
  };
  const showFailure = (failureText: string | null) => {
    failureLine.hidden = failureText === null;
    failureLine.textContent = failureText ?? '';
  };
  const sendOrFail = (message: Parameters<typeof sendControlMsg>[0]): boolean => {
    if (sendControlMsg(message)) return true;
    showFailure(NOT_SENT_TEXT);
    return false;
  };
  const waits = createChatWaits({
    sessionId,
    root,
    view: () => chatView,
    getApproval: () => sessionState.approval,
    getPlanGate: () => sessionState.planGate,
    showFailure,
    sendOrFail,
  });
  const phaseToShow = () => {
    if (waits.isTerminalBorrowed()) return 'quiet';
    const phase = sessionPhaseOf(sessionId);
    const isSentMessageAwaitingTurn = isOutboxAwaitingTurn(outboxEcho, sessionState.outbox, phase === 'working');
    return shownChatPhaseOf(phase, isSentMessageAwaitingTurn, sessionUIs.get(sessionId)?.awaitingBackgroundTasks === true);
  };
  const showOutbox = () => {
    const update = reconcileOutboxEcho(outboxEcho, sessionState.outbox, isSessionWorking(sessionId), clock.nowMs());
    if (update.addedStandIns.length > 0) chatView.upsert(update.addedStandIns, new Set(update.addedStandIns.map((standIn) => standIn.id)));
    removeStandIns(update.removedStandInEntryIds);
    chatView.showQueued(update.queuedEntries);
    if (mountedChat?.sessionId === sessionId) applyShownPhase(mountedChat);
    if (update.clearedStandInEntryIds.length === 0) return;
    for (const entryId of update.clearedStandInEntryIds) awaitPromptFor(entryId);
    feed.refresh();
  };
  const donePanel = createDonePanel(chatView.showTurnEnd);
  const showDone = () => donePanel.show(donePanelModelOf({ run: reviewOf(sessionId)?.verification ?? null, agentDoneLines: sessionState.agentDoneLines, phase: sessionPhaseOf(sessionId) }));
  sendControlMsg({ type: 'request-verification', id: sessionId });
  root.append(failureLine, chatView.element);
  const modelPicker = listenForModelChange({ root, sessionId, canOpen: () => !isSessionWorking(sessionId), showFailure: (failureText) => showSessionFailure(sessionId, failureText) });
  const showRail = () => {
    const canChangeModel = canSwitchSessionModel(sessionId) && !isSessionWorking(sessionId);
    if (!canChangeModel) modelPicker.close();
    refreshLimitCountdowns(root, clock.nowMs());
    chatView.showRail(sessionRailFieldsOf(sessionId, canChangeModel));
  };
  showRail();
  let railTimer: ReturnType<typeof setInterval> | null = setInterval(showRail, RAIL_TICK_MS);
  let runTimeTimer: ReturnType<typeof setInterval> | null = null;
  const stopRunTimes = () => {
    if (runTimeTimer !== null) clearInterval(runTimeTimer);
    runTimeTimer = null;
  };
  const tickRunTimes = () => {
    if (chatView.tickRunTimes()) return;
    stopRunTimes();
  };
  const keepRunTimesTicking = () => {
    if (runTimeTimer === null) runTimeTimer = setInterval(tickRunTimes, RUN_TIME_TICK_MS);
  };
  const stopRail = () => {
    modelPicker.close();
    if (railTimer !== null) clearInterval(railTimer);
    railTimer = null;
    stopRunTimes();
  };
  chatView.setPhase(phaseToShow(), isSessionWorking(sessionId));
  const promptAtByPartId = new Map<string, number>();
  let boardChangeByCardId = new Map<string, AgentChip>();

  const notePromptTimes = (changedParts: readonly ChatPart[]) => {
    for (const part of changedParts) {
      if (part.kind === 'prompt') promptAtByPartId.set(part.id, part.at);
    }
  };

  const placeBoardChangeCards = (arrivingAllowed: boolean) => {
    const logElement = chatView.element.querySelector<HTMLElement>('.chat-log');
    if (!logElement) return;
    const promptAtOf = (partElement: HTMLElement) => promptAtByPartId.get(partElement.dataset.partId ?? '');
    const promptElements = [...logElement.querySelectorAll<HTMLElement>(':scope > [data-part-id]')].filter((partElement) => promptAtOf(partElement) !== undefined);
    const promptTimes = promptElements.map((promptElement) => promptAtOf(promptElement) ?? 0);
    const groups = boardChangeGroupsOf(sessionId, promptTimes);
    const staleCardIds = [...boardChangeByCardId.keys()].filter((cardId) => !groups.some((group) => group.cardId === cardId));
    chatView.remove(staleCardIds);
    const shownCardIds = new Set(boardChangeByCardId.keys());
    boardChangeByCardId = new Map(groups.map((group) => [group.cardId, group.boardChange]));
    for (const group of groups) {
      const isArriving = arrivingAllowed && !shownCardIds.has(group.cardId);
      chatView.upsert([cardPartOf(boardChangeCardOf(group.cardId, group.boardChange))], isArriving ? new Set([group.cardId]) : NO_ARRIVING_PARTS);
      const cardElement = logElement.querySelector<HTMLElement>(`:scope > [data-part-id="${group.cardId}"]`);
      if (!cardElement) continue;
      const laterPrompt = promptElements.find((promptElement) => (promptAtOf(promptElement) ?? 0) > group.boardChange.at);
      if (laterPrompt) laterPrompt.before(cardElement);
      if (!laterPrompt) logElement.append(cardElement);
    }
    keepPendingPartsLast();
  };

  const showBoardChanges = () => {
    if (feedPosition !== 'unseeded') placeBoardChangeCards(isOperatorWatching());
  };

  const showBoardChangesOnceCaughtUp = () => {
    feedPosition = 'following';
    chatView.showLoaded();
    placeBoardChangeCards(false);
  };

  const keepPendingPartsLast = () => {
    const standInIds = [...outboxEcho.standInByEntryId.values()].map((standIn) => standIn.id);
    chatView.keepLast([...standInIds, ...waits.pendingCardIds()]);
  };

  const answerCard = (cardId: string, action: string, value: string) => {
    const boardChange = boardChangeByCardId.get(cardId);
    if (boardChange && action === 'focus') {
      markAgentChangeShown(sessionId, boardChange.change);
      openBoardAtAgentChange(boardChange.boardId, sessionId, boardChange.change);
      return;
    }
    waits.answerCard(cardId, action, value);
  };

  attachChatListeners({
    sessionId,
    root,
    readAttachmentCount: () => chatView.readAttachments().length,
    showFailure,
    newestCancellableEntryId: () => newestCancellableOutboxEntryOf(outboxEcho, sessionState.outbox)?.entryId ?? null,
    answerCard,
    handleKeydown: waits.handleKeydown,
  });

  const notePermissionMode = (records: readonly TraceRecord[], isNewer: boolean) => {
    const newestMode = records.findLast((record) => record.kind === 'permission-mode' && record.agentId === undefined);
    if (newestMode?.kind !== 'permission-mode') return;
    if (!isNewer && sessionState.permissionMode !== null) return;
    if (newestMode.modeName === sessionState.permissionMode?.modeName) return;
    sessionState.permissionMode = { mode: newestMode.mode, modeName: newestMode.modeName };
    showRail();
  };
  const feed = createChatFeed({
    sessionId,
    workingDirectory: sessionWorkingDirectoryOf(sessionId) ?? sessionUIs.get(sessionId)?.path ?? null,
    requestPage: (payload) => sendControlRequest('session-trace', payload, { timeoutMs: TRACE_PAGE_TIMEOUT_MS }),
    onRecords: (records) => notePermissionMode(records, true),
    onEarlierRecords: (records) => notePermissionMode(records, false),
    onPartsChanged: (changedParts, droppedPartIds, isLive) => {
      const newPromptParts = takeNewPromptParts(changedParts, droppedPartIds);
      chatView.upsert(changedParts, isLive ? arrivingPartIdsOf(changedParts, newPromptParts) : NO_ARRIVING_PARTS);
      chatView.remove(droppedPartIds);
      if (isLive) swapStandInsForPrompts(newPromptParts.length);
      notePromptTimes(changedParts);
      if (feedPosition !== 'unseeded' && changedParts.some((part) => part.kind === 'prompt')) placeBoardChangeCards(false);
      keepPendingPartsLast();
      keepRunTimesTicking();
    },
    onRebuilt: (rebuiltParts, replacedPartIds) => {
      shownPromptPartIds.clear();
      for (const part of rebuiltParts) {
        if (part.kind === 'prompt') shownPromptPartIds.add(part.id);
      }
      chatView.replaceLogParts(replacedPartIds, rebuiltParts);
      notePromptTimes(rebuiltParts);
      if (feedPosition !== 'unseeded') placeBoardChangeCards(false);
      keepPendingPartsLast();
      keepRunTimesTicking();
    },
    isTurnOver: () => !isSessionWorking(sessionId),
    onBeats: (beats) => chatView.beat(beats),
    onReset: () => {
      waits.releaseTerminal();
      waits.clearApproval();
      const freshView = createSeededView(chatView.readDraft(), chatView.readAttachments());
      freshView.showQueued(queuedOutboxEntriesOf(outboxEcho, sessionState.outbox));
      shownPromptPartIds.clear();
      freshView.upsert([...outboxEcho.standInByEntryId.values()], NO_ARRIVING_PARTS);
      chatView.element.replaceWith(freshView.element);
      chatView = freshView;
      boardChangeByCardId = new Map();
      feedPosition = 'unseeded';
      feed.whenCaughtUp(showBoardChangesOnceCaughtUp);
      waits.restoreCards();
      showRail();
      waits.sync();
      chatView.setPhase(phaseToShow(), isSessionWorking(sessionId));
    },
    onFailure: (failureText) => {
      if (failureText !== null) chatView.showLoaded();
      showFailure(failureText);
    },
  });
  root.addEventListener(CHAT_NEAR_TOP_EVENT, () => feed.loadEarlier());
  showOutbox();
  feed.whenCaughtUp(showBoardChangesOnceCaughtUp);
  return {
    sessionId,
    root,
    feed,
    shownPhase: phaseToShow(),
    isShownTurnRunning: isSessionWorking(sessionId),
    phaseToShow,
    setPhase: (phase, isTurnRunning) => {
      chatView.setPhase(phase, isTurnRunning);
      showDone();
      showRail();
    },
    showOutbox,
    restoreText: (text) => chatView.restoreDraft(draftWithRestoredText(text, chatView.readDraft())),
    restoreAttachments: (fileNames) => {
      for (const fileName of fileNames) chatView.showAttachment(fileName);
    },
    showFailure,
    syncWaitingCards: waits.sync,
    showRail,
    showDone,
    showBoardChanges,
    catchUp,
    resumeRail: () => {
      showRail();
      if (railTimer === null) railTimer = setInterval(showRail, RAIL_TICK_MS);
      keepRunTimesTicking();
    },
    park: () => {
      stopRail();
      chatView.stopActivityStats();
      if (sessionUIs.has(sessionId)) saveChatDraft(sessionId, chatView.readDraft());
      waits.releaseTerminal();
    },
    close: () => {
      stopRail();
      chatView.stopActivityStats();
      if (sessionUIs.has(sessionId)) saveChatDraft(sessionId, chatView.readDraft());
      sessionState.draftAttachments = chatView.readAttachments();
      waits.releaseTerminal();
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

export function sessionRailFieldsOf(sessionId: string, canChangeModel: boolean): RailField[] {
  const accountId = sessionAccountIdOf(sessionId);
  const agent = sessionUIs.get(sessionId)?.agent ?? null;
  const vendor = planVendorOfAgent(agent);
  const planLimits = vendor === null
    ? null
    : (accountId !== null ? accountPlanLimitsOf(vendor, accountId) : (accountPlanLimitsOf(vendor, null) ?? planLimitsOf(vendor)));
  return railFieldsOf({
    meter: sessionMeterOf(sessionId),
    selection: sessionModelSelectionOf(sessionId),
    planLimits,
    sessionCostUSD: sessionCostOf(sessionId),
    nowMs: clock.nowMs(),
    canChangeModel,
    agent,
    permissionMode: chatSessionStateOf(sessionId).permissionMode,
  });
}

export function chatApprovalOf(sessionId: string): ConversationApproval | null {
  return chatSessionStateOf(sessionId).approval;
}

export function noteChatApproval(sessionId: string, approval: ConversationApproval | null): void {
  chatSessionStateOf(sessionId).approval = approval;
}

export function chatPlanGateOf(sessionId: string): PlanGate | null {
  return chatSessionStateOf(sessionId).planGate;
}

export function noteChatPlanGate(sessionId: string, planGate: PlanGate | null): void {
  chatSessionStateOf(sessionId).planGate = planGate;
  applyChatSessionStatus(sessionId);
}

export function noteChatAgentDoneLines(sessionId: string, agentDoneLines: readonly AgentDoneLine[]): void {
  chatSessionStateOf(sessionId).agentDoneLines = agentDoneLines;
  if (mountedChat?.sessionId === sessionId) mountedChat.showDone();
}

export function noteChatOutbox(sessionId: string, entries: ChatOutboxEntry[]): void {
  noteChatOutboxEntries(sessionId, entries);
  if (mountedChat?.sessionId === sessionId) mountedChat.showOutbox();
}

export function applyChatTraceChanged(sessionId: string): void {
  if (mountedChat?.sessionId !== sessionId) return;
  mountedChat.feed.refresh();
}

export function applyChatSnapshot(rows: readonly { id: string; conversationApproval?: ConversationApproval | null; chatOutbox?: ChatOutboxEntry[]; agentDoneLines?: readonly AgentDoneLine[] }[]): void {
  clearChatSnapshotState();
  pruneChatDraftsForSessions(new Set(rows.map((row) => row.id)));
  for (const row of rows) {
    noteChatApproval(row.id, row.conversationApproval ?? null);
    noteChatOutbox(row.id, row.chatOutbox ?? []);
    noteChatAgentDoneLines(row.id, row.agentDoneLines ?? []);
  }
  if (!mountedChat) return;
  mountedChat.catchUp();
  applyChatSessionStatus(mountedChat.sessionId);
}

export function applyChatSessionStatus(sessionId: string): void {
  if (mountedChat?.sessionId !== sessionId) return;
  mountedChat.syncWaitingCards();
  applyShownPhase(mountedChat);
}

function applyShownPhase(chat: MountedChat): void {
  const phase = chat.phaseToShow();
  const isTurnRunning = isSessionWorking(chat.sessionId);
  if (phase === chat.shownPhase && isTurnRunning === chat.isShownTurnRunning) return;
  const wasTurnRunning = chat.isShownTurnRunning;
  chat.shownPhase = phase;
  chat.isShownTurnRunning = isTurnRunning;
  chat.setPhase(phase, isTurnRunning);
  if (wasTurnRunning && !isTurnRunning) chat.feed.endTurn();
}

onAgentChange((sessionId, boardChange) => {
  rememberBoardChange(sessionId, boardChange);
  if (mountedChat?.sessionId === sessionId) mountedChat.showBoardChanges();
});

onReviewChange((sessionId) => {
  if (mountedChat?.sessionId !== sessionId) return;
  mountedChat.showDone();
  refreshChatFileRefs(mountedChat.root);
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
    mountedChat.catchUp();
    applyChatSessionStatus(sessionId);
    mountedChat.showBoardChanges();
    if (!isOperatorTypingOutside(mountedChat.root)) focusMountedComposer();
  },
  focusInput: focusMountedComposer,
  unmount: unmountChat,
  didCloseByOperator: () => setSessionView('terminal'),
  canStepBack: () => false,
  stepBack: () => {},
};
