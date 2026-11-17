import { BETWEEN_TURN_STATES } from '#shared/states.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { announceSessionPageChange, closeSessionPage, isSessionPageOpen } from '../session-pages/session-pages.ts';
import type { SessionPage } from '../session-pages/session-pages.ts';
import { settingsPayloadSnapshot, subscribeSettings } from '../settings/settings-store.ts';
import { CHAT_ICON_PATH } from '../svg-dom.ts';
import { createChatFeed } from './chat-feed.ts';
import type { ChatFeed } from './chat-feed.ts';
import { createChatView } from './chat-view.ts';

const CHAT_PAGE_ID = 'chat';
const TRACE_PAGE_TIMEOUT_MS = 10000;
const BETWEEN_TURN_STATE_SET: ReadonlySet<string> = new Set(BETWEEN_TURN_STATES);

interface MountedChat {
  sessionId: string;
  root: HTMLElement;
  feed: ChatFeed;
  wasSessionWorking: boolean;
  setTurnRunning(isTurnRunning: boolean): void;
}

let mountedChat: MountedChat | null = null;

function isChatEnabled(): boolean {
  const sessionChat = settingsPayloadSnapshot().sessionChat;
  return typeof sessionChat === 'object' && sessionChat !== null && 'enabled' in sessionChat && sessionChat.enabled === true;
}

function isSessionWorking(sessionId: string): boolean {
  const state = sessionUIs.get(sessionId)?.currentState;
  if (state === undefined) return false;
  return !BETWEEN_TURN_STATE_SET.has(state);
}

function buildChat(sessionId: string): MountedChat {
  const root = el('div', 'session-chat');
  const failureLine = el('div', 'session-chat-failure');
  failureLine.hidden = true;
  let chatView = createChatView();
  root.append(failureLine, chatView.element);
  chatView.setTurnRunning(isSessionWorking(sessionId));
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
      const freshView = createChatView();
      freshView.setTurnRunning(isSessionWorking(sessionId));
      chatView.element.replaceWith(freshView.element);
      chatView = freshView;
    },
    onFailure: (failureText) => {
      failureLine.hidden = failureText === null;
      failureLine.textContent = failureText ?? '';
    },
  });
  return { sessionId, root, feed, wasSessionWorking: isSessionWorking(sessionId), setTurnRunning: (isTurnRunning) => chatView.setTurnRunning(isTurnRunning) };
}

function unmountChat(): void {
  if (!mountedChat) return;
  mountedChat.feed.close();
  mountedChat.root.remove();
  mountedChat = null;
}

export function applyChatTraceChanged(sessionId: string): void {
  if (mountedChat?.sessionId !== sessionId) return;
  mountedChat.feed.refresh();
}

export function applyChatSnapshot(): void {
  if (!mountedChat) return;
  applyChatSessionStatus(mountedChat.sessionId);
  mountedChat.feed.refresh();
}

export function applyChatSessionStatus(sessionId: string): void {
  if (mountedChat?.sessionId !== sessionId) return;
  const isWorking = isSessionWorking(sessionId);
  if (isWorking === mountedChat.wasSessionWorking) return;
  mountedChat.wasSessionWorking = isWorking;
  mountedChat.setTurnRunning(isWorking);
  mountedChat.feed.noteSessionWorkingChanged();
}

subscribeSettings((change) => {
  if (change.kind !== 'broadcast') return;
  if (!isChatEnabled() && mountedChat && isSessionPageOpen(CHAT_PAGE_ID, mountedChat.sessionId)) closeSessionPage();
  announceSessionPageChange(CHAT_PAGE_ID, null);
});

export const chatPage: SessionPage = {
  id: CHAT_PAGE_ID,
  label: 'Chat',
  iconPath: CHAT_ICON_PATH,
  isAvailableFor: (sessionId) => isChatEnabled() && sessionUIs.has(sessionId),
  hasUnreadFor: () => false,
  mount(host, sessionId) {
    unmountChat();
    mountedChat = buildChat(sessionId);
    host.append(mountedChat.root);
    mountedChat.feed.refresh();
  },
  unmount: unmountChat,
  canStepBack: () => false,
  stepBack: () => {},
};
