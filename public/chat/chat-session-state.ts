import type { SessionPermissionMode } from './status-rail-core.ts';
import type { AgentDoneLine, ConversationApproval } from '#shared/contracts/session.ts';
import type { PlanGate } from '#shared/contracts/plan-gate.ts';
import { getChatDraft, pruneChatDrafts, setChatDraft } from '../ui-prefs.ts';

interface ChatSessionState {
  approval: ConversationApproval | null;
  planGate: PlanGate | null;
  draftAttachments: string[];
  agentDoneLines: readonly AgentDoneLine[];
  uploadingCount: number;
  permissionMode: SessionPermissionMode | null;
}

interface PendingDraftSave {
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

const CHAT_DRAFT_SAVE_DELAY_MS = 250;
const stateBySessionId = new Map<string, ChatSessionState>();
const pendingDraftBySessionId = new Map<string, PendingDraftSave>();
let isPageHideListenerInstalled = false;

function freshSessionState(): ChatSessionState {
  return { approval: null, planGate: null, draftAttachments: [], agentDoneLines: [], uploadingCount: 0, permissionMode: null };
}

function clearPendingDraftSave(sessionId: string): void {
  const pending = pendingDraftBySessionId.get(sessionId);
  if (pending === undefined) return;
  clearTimeout(pending.timer);
  pendingDraftBySessionId.delete(sessionId);
}

function flushPendingChatDrafts(): void {
  for (const [sessionId, pending] of pendingDraftBySessionId) {
    clearTimeout(pending.timer);
    setChatDraft(sessionId, pending.text);
  }
  pendingDraftBySessionId.clear();
}

function ensurePageHideFlushInstalled(): void {
  if (isPageHideListenerInstalled || typeof window === 'undefined') return;
  isPageHideListenerInstalled = true;
  window.addEventListener('pagehide', flushPendingChatDrafts);
}

export function chatDraftOf(sessionId: string): string {
  const pending = pendingDraftBySessionId.get(sessionId);
  if (pending !== undefined) return pending.text;
  return getChatDraft(sessionId);
}

export function saveChatDraft(sessionId: string, text: string): void {
  clearPendingDraftSave(sessionId);
  setChatDraft(sessionId, text);
}

export function scheduleChatDraftSave(sessionId: string, text: string): void {
  if (!sessionId) return;
  ensurePageHideFlushInstalled();
  clearPendingDraftSave(sessionId);
  const timer = setTimeout(() => {
    pendingDraftBySessionId.delete(sessionId);
    setChatDraft(sessionId, text);
  }, CHAT_DRAFT_SAVE_DELAY_MS);
  pendingDraftBySessionId.set(sessionId, { text, timer });
}

export function forgetChatDraft(sessionId: string): void {
  saveChatDraft(sessionId, '');
}

export function pruneChatDraftsForSessions(liveSessionIds: ReadonlySet<string>): void {
  for (const [sessionId, pending] of pendingDraftBySessionId) {
    if (liveSessionIds.has(sessionId)) continue;
    clearTimeout(pending.timer);
    pendingDraftBySessionId.delete(sessionId);
  }
  pruneChatDrafts(liveSessionIds);
}

export function chatSessionStateOf(sessionId: string): ChatSessionState {
  const existing = stateBySessionId.get(sessionId);
  if (existing !== undefined) return existing;
  const created = freshSessionState();
  stateBySessionId.set(sessionId, created);
  return created;
}

export function clearChatSnapshotState(): void {
  for (const state of stateBySessionId.values()) {
    state.approval = null;
    state.planGate = null;
    state.agentDoneLines = [];
  }
}
