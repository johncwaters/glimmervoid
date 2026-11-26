import type { SessionCardFields } from "../../shared/contracts/control-messages.ts";
import type { AgentDoneLine, AttentionNote, AttentionOwner, ParentLink, ChatOutboxEntry, ConversationApproval, UnseenOutcome, UsageLimit } from "../../shared/contracts/session.ts";
import type { LinkedPr } from "../../shared/contracts/my-prs.ts";
import type { PlanGate } from "../../shared/contracts/plan-gate.ts";
import type { AgentSetup, ModelSelection } from "../../shared/contracts/agent-models.ts";

interface SessionCardSource {
  taskTitle?: string | null;
  taskTitleIsCustom?: boolean;
  path: string;
  workingDirectory?: string;
  agentId: string;
  agentDrawsAlternateScreen?: boolean;
  hasTerminal?: boolean;
  state: SessionCardFields["state"];
  stateSince: number;
  dangerouslySkipPermissions?: boolean;
  saneYolo?: boolean;
  isQuestionManagerOn?: boolean | null;
  accountId?: string | null;
  parent?: ParentLink | null;
  isStudioMain?: boolean;
  isWorktree?: boolean;
  isWorkspace?: boolean;
  resumeSessionId?: string | null;
  ephemeral?: boolean;
  attentionOwner?: AttentionOwner;
  linkedPrs?: LinkedPr[];
  doneMeans?: readonly string[];
  agentDoneLines?: readonly AgentDoneLine[];
  agentSetup?: AgentSetup | null;
}

interface SessionCardIdentity {
  id: string;
  name: string;
}

function modelSelectionOf(agentSetup: AgentSetup | null | undefined): ModelSelection | null {
  if (!agentSetup) return null;
  const { agent, provider, model, options } = agentSetup;
  return { agent, model, options, ...(provider ? { provider } : {}) };
}

function projectSessionCard(
  source: SessionCardSource,
  { id, name }: SessionCardIdentity,
): SessionCardFields {
  const card: SessionCardFields = {
    id,
    session: name,
    taskTitle: source.taskTitle ?? null,
    taskTitleIsCustom: source.taskTitleIsCustom ?? false,
    path: source.path,
    ...(source.workingDirectory ? { workingDirectory: source.workingDirectory } : {}),
    agent: source.agentId,
    agentDrawsAlternateScreen: !!source.agentDrawsAlternateScreen,
    ...(source.hasTerminal === false ? { hasTerminal: false } : {}),
    state: source.state,
    stateSince: source.stateSince,
    skipPerms: !!source.dangerouslySkipPermissions,
    saneYolo: !!source.saneYolo,
    worktree: !!source.isWorktree,
    resumeSessionId: source.resumeSessionId || null,
    ...(source.isWorkspace ? { workspace: true } : {}),
    ...(source.linkedPrs?.length ? { linkedPrs: source.linkedPrs } : {}),
    ...(source.doneMeans?.length ? { doneMeans: [...source.doneMeans] } : {}),
    ...(source.agentDoneLines?.length ? { agentDoneLines: source.agentDoneLines.map((line) => ({ ...line })) } : {}),
    ...(source.parent ? { parent: { sessionId: source.parent.sessionId, box: source.parent.box ? { ...source.parent.box } : null } } : {}),
    ...(source.isStudioMain ? { isStudioMain: true } : {}),
    ...(source.attentionOwner && source.attentionOwner !== 'operator' ? { attentionOwner: source.attentionOwner } : {}),
    ...(typeof source.isQuestionManagerOn === 'boolean' ? { isQuestionManagerOn: source.isQuestionManagerOn } : {}),
    ...(source.accountId ? { accountId: source.accountId } : {}),
    ...(source.agentSetup ? { modelSelection: modelSelectionOf(source.agentSetup) } : {}),
  };
  if (source.ephemeral === undefined) return card;
  return { ...card, ephemeral: source.ephemeral };
}

interface SnapshotSource {
  taskTitle?: string | null;
  taskTitleIsCustom?: boolean;
  id: string;
  name: string;
  path: string;
  workingDirectory?: string | null;
  agent: string;
  agentDrawsAlternateScreen?: boolean;
  hasTerminal?: boolean;
  state: string;
  stateSince: number;
  dangerouslySkipPermissions: boolean;
  saneYolo?: boolean;
  ephemeral: boolean;
  attentionOwner?: AttentionOwner;
  isWorktree: boolean;
  isWorkspace: boolean;
  resumeSessionId: string | null;
  activeAgents: number;
  awaitingBackgroundTasks: boolean;
  pendingPromptKind: string | null;
  usageLimit: UsageLimit | null;
  attentionNotes: AttentionNote[];
  planGate: PlanGate | null;
  conversationApproval: ConversationApproval | null;
  chatOutbox: ChatOutboxEntry[];
  mergeStatus: string;
  mergeReason: string | null;
  worktreeNotice: string | null;
  failureReason?: string | null;
  unseenOutcome?: UnseenOutcome | null;
  managerSeenSeq?: number;
  passedQuestionSeq?: number;
  isQuestionManagerOn?: boolean | null;
  accountId?: string | null;
  parent?: ParentLink | null;
  isStudioMain?: boolean;
  agentSetup?: AgentSetup | null;
  effectiveBase: string | null;
  linkedPrs: LinkedPr[];
  doneMeans: readonly string[];
  agentDoneLines: readonly AgentDoneLine[];
  auditLog: Record<string, unknown>[];
  detection: Record<string, unknown>;
  decisions: Record<string, unknown>[];
}

function projectSessionSnapshots(source: SnapshotSource) {
  const wire = {
    id: source.id,
    name: source.name,
    taskTitle: source.taskTitle ?? null,
    taskTitleIsCustom: source.taskTitleIsCustom ?? false,
    path: source.path,
    workingDirectory: source.workingDirectory ?? null,
    agent: source.agent,
    agentDrawsAlternateScreen: !!source.agentDrawsAlternateScreen,
    hasTerminal: source.hasTerminal !== false,
    state: source.state,
    stateSince: source.stateSince,
    dangerouslySkipPermissions: source.dangerouslySkipPermissions,
    saneYolo: !!source.saneYolo,
    ephemeral: source.ephemeral,
    attentionOwner: source.attentionOwner ?? 'operator',
    isWorktree: source.isWorktree,
    isWorkspace: source.isWorkspace,
    resumeSessionId: source.resumeSessionId,
    activeAgents: source.activeAgents,
    awaitingBackgroundTasks: source.awaitingBackgroundTasks,
    pendingPromptKind: source.pendingPromptKind,
    usageLimit: source.usageLimit,
    attentionNotes: source.attentionNotes,
    planGate: source.planGate,
    conversationApproval: source.conversationApproval,
    chatOutbox: source.chatOutbox,
    mergeStatus: source.mergeStatus,
    mergeReason: source.mergeReason,
    worktreeNotice: source.worktreeNotice,
    failureReason: source.failureReason ?? null,
    unseenOutcome: source.unseenOutcome ?? null,
    managerSeenSeq: source.managerSeenSeq ?? 0,
    passedQuestionSeq: source.passedQuestionSeq ?? 0,
    isQuestionManagerOn: source.isQuestionManagerOn ?? null,
    accountId: source.accountId ?? null,
    parent: source.parent ?? null,
    isStudioMain: source.isStudioMain === true,
    modelSelection: modelSelectionOf(source.agentSetup),
    effectiveBase: source.effectiveBase ?? null,
    linkedPrs: source.linkedPrs,
    doneMeans: [...source.doneMeans],
    agentDoneLines: source.agentDoneLines.map((line) => ({ ...line })),
    auditLog: source.auditLog.slice(-100),
  };
  const debug = {
    state: wire.state,
    transitions: wire.auditLog.slice(-5).map((entry) => ({
      from: entry.from,
      to: entry.to,
      event: entry.event,
      timestamp: entry.timestamp,
      detail: entry.detail,
    })),
    detection: source.detection,
    decisions: source.decisions.slice(-15),
  };
  return { wire, debug };
}

export { projectSessionCard, projectSessionSnapshots };
