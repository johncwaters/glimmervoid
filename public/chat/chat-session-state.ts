import type { AgentDoneLine, ChatOutboxEntry, ConversationApproval } from '#shared/contracts/session.ts';
import type { PlanGate } from '#shared/contracts/plan-gate.ts';

interface ChatSessionState {
  approval: ConversationApproval | null;
  planGate: PlanGate | null;
  draft: string;
  draftAttachments: string[];
  outbox: ChatOutboxEntry[];
  agentDoneLines: readonly AgentDoneLine[];
  uploadingCount: number;
}

const stateBySessionId = new Map<string, ChatSessionState>();
const outboxListeners = new Set<(sessionId: string) => void>();

function freshSessionState(): ChatSessionState {
  return { approval: null, planGate: null, draft: '', draftAttachments: [], outbox: [], agentDoneLines: [], uploadingCount: 0 };
}

export function chatSessionStateOf(sessionId: string): ChatSessionState {
  const existing = stateBySessionId.get(sessionId);
  if (existing !== undefined) return existing;
  const created = freshSessionState();
  stateBySessionId.set(sessionId, created);
  return created;
}

export function noteChatOutboxEntries(sessionId: string, entries: ChatOutboxEntry[]): void {
  chatSessionStateOf(sessionId).outbox = entries;
  for (const listener of outboxListeners) listener(sessionId);
}

export function onChatOutboxNoted(listener: (sessionId: string) => void): () => void {
  outboxListeners.add(listener);
  return () => outboxListeners.delete(listener);
}

export function clearChatSnapshotState(): void {
  for (const state of stateBySessionId.values()) {
    state.approval = null;
    state.planGate = null;
    state.outbox = [];
    state.agentDoneLines = [];
  }
}
