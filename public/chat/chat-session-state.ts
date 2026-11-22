import type { AgentDoneLine, ChatOutboxEntry, ConversationApproval } from '#shared/contracts/session.ts';

interface ChatSessionState {
  approval: ConversationApproval | null;
  draft: string;
  draftAttachments: string[];
  outbox: ChatOutboxEntry[];
  agentDoneLines: readonly AgentDoneLine[];
  uploadingCount: number;
}

const stateBySessionId = new Map<string, ChatSessionState>();

function freshSessionState(): ChatSessionState {
  return { approval: null, draft: '', draftAttachments: [], outbox: [], agentDoneLines: [], uploadingCount: 0 };
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
    state.outbox = [];
    state.agentDoneLines = [];
  }
}
