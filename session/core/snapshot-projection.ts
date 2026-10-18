import type { SessionCardFields } from "../../shared/contracts/control-messages.ts";
import type { CoherenceHooksState, ConversationApproval } from "../../shared/contracts/session.ts";
import type { LinkedPr } from "../../shared/contracts/my-prs.ts";

interface SessionCardSource {
  taskTitle?: string | null;
  taskTitleIsCustom?: boolean;
  path: string;
  agentId: string;
  state: SessionCardFields["state"];
  stateSince: number;
  dangerouslySkipPermissions?: boolean;
  saneYolo?: boolean;
  isWorktree?: boolean;
  isWorkspace?: boolean;
  isGuarded?: boolean;
  isGuardrailsReleased?: boolean;
  resumeSessionId?: string | null;
  ephemeral?: boolean;
  factoryRole?: 'orchestrator' | 'worker' | null;
  linkedPrs?: LinkedPr[];
}

interface SessionCardIdentity {
  id: string;
  name: string;
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
    agent: source.agentId,
    state: source.state,
    stateSince: source.stateSince,
    skipPerms: !!source.dangerouslySkipPermissions,
    saneYolo: !!source.saneYolo,
    worktree: !!source.isWorktree,
    guarded: source.isGuarded === true,
    guardrailsReleased: source.isGuardrailsReleased === true,
    resumeSessionId: source.resumeSessionId || null,
    ...(source.isWorkspace ? { workspace: true } : {}),
    ...(source.factoryRole ? { isFactory: true } : {}),
    ...(source.linkedPrs?.length ? { linkedPrs: source.linkedPrs } : {}),
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
  agent: string;
  state: string;
  stateSince: number;
  dangerouslySkipPermissions: boolean;
  saneYolo?: boolean;
  ephemeral: boolean;
  factoryRole: 'orchestrator' | 'worker' | null;
  isWorktree: boolean;
  isWorkspace: boolean;
  isGuarded?: boolean;
  isGuardrailsReleased?: boolean;
  resumeSessionId: string | null;
  activeAgents: number;
  awaitingBackgroundTasks: boolean;
  isCompacting?: boolean;
  isWaitingForMemory?: boolean;
  pendingWakeup: Record<string, unknown> | null;
  pendingPromptKind: string | null;
  conversationApproval?: ConversationApproval | null;
  hasConversationBridge?: boolean;
  isConversationViewOn?: boolean;
  hasPlan: boolean;
  mergeStatus: string;
  mergeReason: string | null;
  worktreeNotice: string | null;
  effectiveBase: string | null;
  linkedPrs: LinkedPr[];
  coherenceHooks?: CoherenceHooksState | null;
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
    agent: source.agent,
    state: source.state,
    stateSince: source.stateSince,
    dangerouslySkipPermissions: source.dangerouslySkipPermissions,
    saneYolo: !!source.saneYolo,
    ephemeral: source.ephemeral,
    isFactory: source.factoryRole !== null,
    isWorktree: source.isWorktree,
    isWorkspace: source.isWorkspace,
    isGuarded: source.isGuarded === true,
    isGuardrailsReleased: source.isGuardrailsReleased === true,
    resumeSessionId: source.resumeSessionId,
    activeAgents: source.activeAgents,
    awaitingBackgroundTasks: source.awaitingBackgroundTasks,
    isCompacting: source.isCompacting ?? false,
    isWaitingForMemory: source.isWaitingForMemory === true,
    pendingWakeup: source.pendingWakeup,
    pendingPromptKind: source.pendingPromptKind,
    conversationApproval: source.conversationApproval ?? null,
    hasConversationBridge: source.hasConversationBridge === true,
    isConversationViewOn: source.isConversationViewOn === true,
    hasPlan: source.hasPlan,
    mergeStatus: source.mergeStatus,
    mergeReason: source.mergeReason,
    worktreeNotice: source.worktreeNotice,
    effectiveBase: source.effectiveBase ?? null,
    linkedPrs: source.linkedPrs,
    coherenceHooks: source.coherenceHooks ?? null,
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
