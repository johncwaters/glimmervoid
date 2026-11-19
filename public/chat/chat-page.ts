import type { ChatOutboxEntry, ConversationApproval } from '#shared/contracts/session.ts';
import { STATES } from '#shared/states.ts';
import { describeFailure } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { announceSessionPageChange, closeSessionPage, isSessionPageOpen, openSessionPageOnShownSession } from '../session-pages/session-pages.ts';
import type { SessionPage } from '../session-pages/session-pages.ts';
import { settingsPayloadSnapshot, subscribeSettings } from '../settings/settings-store.ts';
import { CHAT_ICON_PATH } from '../svg-dom.ts';
import { getSessionView, setSessionView } from '../ui-prefs.ts';
import { subscribeUsage } from '../usage/usage-store.ts';
import type { ChatPageState, MountedChat } from './chat-build.ts';

const CHAT_PAGE_ID = 'chat';
const MID_TURN_STATES: ReadonlySet<string> = new Set([STATES.RUNNING, STATES.WAITING]);

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

const chatPageState: ChatPageState = {
  approvalBySessionId,
  outboxBySessionId,
  draftBySessionId,
  draftAttachmentsBySessionId,
  isSessionWorking,
  draftWithRestoredText,
  restoreTextToSession,
  restoreAttachmentsToSession,
  showSessionFailure,
};

let chatBuildModule: Promise<typeof import('./chat-build.ts')> | null = null;
let chatMountSerial = 0;
let chatPageSessionId: string | null = null;

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
  if (!isEnabled && chatPageSessionId !== null && isSessionPageOpen(CHAT_PAGE_ID, chatPageSessionId)) closeSessionPage();
  if (!isEnabled) dropAllKeptChats();
  announceSessionPageChange(CHAT_PAGE_ID, null);
  if (hasJustEnabled && getSessionView() === 'chat') openSessionPageOnShownSession(CHAT_PAGE_ID);
});

function showChat(host: HTMLElement, sessionId: string, buildChat: typeof import('./chat-build.ts').buildChat): void {
  const keptChat = keptChatBySessionId.get(sessionId);
  keptChatBySessionId.delete(sessionId);
  mountedChat = keptChat ?? buildChat(sessionId, chatPageState);
  host.append(mountedChat.root);
  mountedChat.showOutbox();
  mountedChat.resumeRail();
  applyChatSessionStatus(sessionId);
  mountedChat.feed.refresh();
}

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
    chatMountSerial += 1;
    chatPageSessionId = sessionId;
    const thisMountSerial = chatMountSerial;
    chatBuildModule ??= import('./chat-build.ts');
    chatBuildModule.then(({ buildChat }) => {
      if (thisMountSerial !== chatMountSerial) return;
      showChat(host, sessionId, buildChat);
    }).catch((error: unknown) => {
      chatBuildModule = null;
      reportToServerLog('chat', `Chat failed to load: ${describeFailure(error)}`);
    });
  },
  unmount: () => {
    chatMountSerial += 1;
    chatPageSessionId = null;
    unmountChat();
  },
  didCloseByOperator: () => setSessionView('terminal'),
  canStepBack: () => false,
  stepBack: () => {},
};
