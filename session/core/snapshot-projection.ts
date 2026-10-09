import type { SessionCardFields } from "../../shared/contracts/control-messages.ts";
import type { PendingPromptDetail } from "../../shared/contracts/session.ts";

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
  resumeSessionId?: string | null;
  ephemeral?: boolean;
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
    resumeSessionId: source.resumeSessionId || null,
    ...(source.isWorkspace ? { workspace: true } : {}),
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
  sleeping: boolean;
  dangerouslySkipPermissions: boolean;
  saneYolo?: boolean;
  ephemeral: boolean;
  isWorktree: boolean;
  isWorkspace: boolean;
  resumeSessionId: string | null;
  activeAgents: number;
  awaitingBackgroundTasks: boolean;
  isCompacting?: boolean;
  hasEndedTurn: boolean;
  pendingWakeup: Record<string, unknown> | null;
  pendingPromptKind: string | null;
  pendingPromptDetail: PendingPromptDetail | null;
  hasPlan: boolean;
  mergeStatus: string;
  mergeReason: string | null;
  worktreeNotice: string | null;
  effectiveBase: string | null;
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
    sleeping: source.sleeping,
    dangerouslySkipPermissions: source.dangerouslySkipPermissions,
    saneYolo: !!source.saneYolo,
    ephemeral: source.ephemeral,
    isWorktree: source.isWorktree,
    isWorkspace: source.isWorkspace,
    resumeSessionId: source.resumeSessionId,
    activeAgents: source.activeAgents,
    awaitingBackgroundTasks: source.awaitingBackgroundTasks,
    hasEndedTurn: source.hasEndedTurn,
    isCompacting: source.isCompacting ?? false,
    pendingWakeup: source.pendingWakeup,
    pendingPromptKind: source.pendingPromptKind,
    pendingPromptDetail: source.pendingPromptDetail,
    hasPlan: source.hasPlan,
    mergeStatus: source.mergeStatus,
    mergeReason: source.mergeReason,
    worktreeNotice: source.worktreeNotice,
    effectiveBase: source.effectiveBase ?? null,
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
export type { SessionCardIdentity, SessionCardSource, SnapshotSource };
