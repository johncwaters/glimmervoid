import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { AttentionOwner, ParentLink, SessionSnapshot, SessionState, UnseenOutcome, UsageLimit } from '#shared/contracts/session.ts';
import { STATES } from '#shared/states.ts';
import type { CollectionHelpers } from './define-collection.ts';

interface SessionRecord {
  id: string;
  name: string;
  state: SessionState;
  stateSince: number;
  path: string;
  agent: string;
  agentDrawsAlternateScreen: boolean;
  hasTerminal: boolean;
  dangerouslySkipPermissions: boolean;
  saneYolo: boolean;
  isQuestionManagerOn: boolean;
  accountId: string | null;
  isWorktree: boolean;
  workspace: boolean;
  ephemeral: boolean;
  taskTitle: string | null;
  taskTitleIsCustom: boolean;
  parent: ParentLink | null;
  isStudioMain: boolean;
  attentionOwner: AttentionOwner;
  mergeStatus: string;
  mergeReason: string | null;
  activeAgents: number;
  awaitingBackgroundTasks: boolean;
  pendingPromptKind: string | null;
  usageLimit: UsageLimit | null;
  unseenOutcome: UnseenOutcome | null;
  failureReason: string | null;
}

export interface SessionsCollectionState {
  byId: Record<string, SessionRecord>;
  order: string[];
  serverBuild: string | null;
}

export const INITIAL_SESSIONS_STATE: SessionsCollectionState = {
  byId: {},
  order: [],
  serverBuild: null,
};

function sessionRecordFromSnapshot(row: SessionSnapshot): SessionRecord {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    stateSince: row.stateSince,
    path: row.path,
    agent: row.agent,
    agentDrawsAlternateScreen: row.agentDrawsAlternateScreen === true,
    hasTerminal: row.hasTerminal !== false,
    dangerouslySkipPermissions: row.dangerouslySkipPermissions,
    saneYolo: Boolean(row.saneYolo),
    isQuestionManagerOn: row.isQuestionManagerOn === true,
    accountId: row.accountId ?? null,
    isWorktree: row.isWorktree,
    workspace: row.isWorkspace === true,
    ephemeral: row.ephemeral === true,
    taskTitle: row.taskTitle ?? null,
    taskTitleIsCustom: row.taskTitleIsCustom === true,
    parent: row.parent ?? null,
    isStudioMain: row.isStudioMain === true,
    attentionOwner: row.attentionOwner ?? 'operator',
    mergeStatus: row.mergeStatus ?? 'none',
    mergeReason: row.mergeReason ?? null,
    activeAgents: row.activeAgents ?? 0,
    awaitingBackgroundTasks: row.awaitingBackgroundTasks === true,
    pendingPromptKind: row.pendingPromptKind ?? null,
    usageLimit: row.usageLimit ?? null,
    unseenOutcome: row.unseenOutcome ?? null,
    failureReason: row.failureReason ?? null,
  };
}

function sessionRecordFromCardFields(
  msg: ServerMessageOf<'session-added'> | ServerMessageOf<'session-modified'>,
  previous: SessionRecord | undefined,
): SessionRecord {
  return {
    id: msg.id,
    name: msg.session,
    state: msg.state,
    stateSince: msg.stateSince,
    path: msg.path,
    agent: msg.agent,
    agentDrawsAlternateScreen: msg.agentDrawsAlternateScreen === true,
    hasTerminal: msg.hasTerminal !== false,
    dangerouslySkipPermissions: msg.skipPerms,
    saneYolo: msg.saneYolo,
    isQuestionManagerOn: msg.isQuestionManagerOn ?? previous?.isQuestionManagerOn ?? false,
    accountId: msg.accountId ?? null,
    isWorktree: msg.worktree,
    workspace: msg.workspace === true,
    ephemeral: msg.ephemeral === true,
    taskTitle: msg.taskTitle ?? previous?.taskTitle ?? null,
    taskTitleIsCustom: msg.taskTitleIsCustom ?? previous?.taskTitleIsCustom ?? false,
    parent: msg.parent ?? previous?.parent ?? null,
    isStudioMain: msg.isStudioMain ?? previous?.isStudioMain ?? false,
    attentionOwner: msg.attentionOwner ?? previous?.attentionOwner ?? 'operator',
    mergeStatus: previous?.mergeStatus ?? 'none',
    mergeReason: previous?.mergeReason ?? null,
    activeAgents: previous?.activeAgents ?? 0,
    awaitingBackgroundTasks: previous?.awaitingBackgroundTasks ?? false,
    pendingPromptKind: previous?.pendingPromptKind ?? null,
    usageLimit: previous?.usageLimit ?? null,
    unseenOutcome: previous?.unseenOutcome ?? null,
    failureReason: msg.failureReason ?? null,
  };
}

function ensureInOrder(order: string[], sessionId: string): void {
  if (!order.includes(sessionId)) order.push(sessionId);
}

function removeFromOrder(order: string[], sessionId: string): void {
  const index = order.indexOf(sessionId);
  if (index !== -1) order.splice(index, 1);
}

function applySessionStatusToDraft(draft: SessionsCollectionState, msg: ServerMessageOf<'session-status'>): void {
  const existing = draft.byId[msg.id];
  if (!existing) {
    if (!msg.transition) return;
    draft.byId[msg.id] = {
      id: msg.id,
      name: msg.session,
      state: msg.transition.to,
      stateSince: msg.stateSince ?? msg.timestamp,
      path: '',
      agent: '',
      agentDrawsAlternateScreen: false,
      hasTerminal: true,
      dangerouslySkipPermissions: msg.skipPerms === true,
      saneYolo: msg.saneYolo === true,
      isQuestionManagerOn: msg.isQuestionManagerOn === true,
      accountId: msg.accountId ?? null,
      isWorktree: false,
      workspace: false,
      ephemeral: false,
      taskTitle: null,
      taskTitleIsCustom: false,
      parent: null,
      isStudioMain: false,
      attentionOwner: 'operator',
      mergeStatus: 'none',
      mergeReason: null,
      activeAgents: msg.activeAgents ?? 0,
      awaitingBackgroundTasks: msg.awaitingBackgroundTasks === true,
      pendingPromptKind: msg.pendingPromptKind ?? null,
      usageLimit: msg.usageLimit ?? null,
      unseenOutcome: msg.unseenOutcome ?? null,
      failureReason: msg.failureReason ?? null,
    };
    ensureInOrder(draft.order, msg.id);
    return;
  }

  if (msg.transition) {
    existing.state = msg.transition.to;
    existing.stateSince = msg.stateSince ?? msg.timestamp;
    if (msg.failureReason !== undefined) existing.failureReason = msg.failureReason;
    if (msg.failureReason === undefined && msg.transition.to === STATES.INITIALIZING) existing.failureReason = null;
  }
  if (msg.saneYolo !== undefined) existing.saneYolo = msg.saneYolo;
  if (msg.activeAgents !== undefined) existing.activeAgents = Math.max(0, msg.activeAgents);
  if (msg.awaitingBackgroundTasks !== undefined) existing.awaitingBackgroundTasks = msg.awaitingBackgroundTasks;
  if (msg.unseenOutcome !== undefined) existing.unseenOutcome = msg.unseenOutcome;
  if (msg.pendingPromptKind !== undefined) existing.pendingPromptKind = msg.pendingPromptKind;
  if (msg.usageLimit !== undefined) existing.usageLimit = msg.usageLimit;
  if (msg.isQuestionManagerOn !== undefined) existing.isQuestionManagerOn = msg.isQuestionManagerOn;
  if (msg.accountId !== undefined) existing.accountId = msg.accountId;
}

export interface SessionsApplyContext {
  confirmedChatStopSessionId?: string;
}

export function applySessionsServerMessage(
  draft: SessionsCollectionState,
  message: ServerMessage,
  helpers: CollectionHelpers<SessionsCollectionState>,
  context: SessionsApplyContext = {},
): void {
  if (message.type === 'session-action-result') {
    if (message.ok && context.confirmedChatStopSessionId) {
      applyOptimisticChatStop(draft, context.confirmedChatStopSessionId);
    }
    return;
  }
  if (message.type === 'snapshot') {
    const nextById: Record<string, SessionRecord> = {};
    const nextOrder: string[] = [];
    for (const row of message.sessions) {
      nextById[row.id] = sessionRecordFromSnapshot(row);
      nextOrder.push(row.id);
    }
    helpers.replace({
      byId: nextById,
      order: nextOrder,
      serverBuild: message.serverBuild ?? null,
    });
    return;
  }
  if (message.type === 'session-added' || message.type === 'session-modified') {
    draft.byId[message.id] = sessionRecordFromCardFields(message, draft.byId[message.id]);
    ensureInOrder(draft.order, message.id);
    return;
  }
  if (message.type === 'session-removed') {
    delete draft.byId[message.id];
    removeFromOrder(draft.order, message.id);
    return;
  }
  if (message.type === 'session-renamed') {
    const record = draft.byId[message.id];
    if (record) record.name = message.newName;
    return;
  }
  if (message.type === 'session-status') {
    applySessionStatusToDraft(draft, message);
    return;
  }
  if (message.type === 'session-title') {
    const record = draft.byId[message.id];
    if (!record) return;
    record.taskTitle = message.taskTitle;
    record.taskTitleIsCustom = message.isCustom;
    return;
  }
  if (message.type === 'session-git') {
    const record = draft.byId[message.id];
    if (record) record.isWorktree = Boolean(message.worktree);
    return;
  }
  if (message.type === 'session-merge-status') {
    const record = draft.byId[message.id];
    if (!record) return;
    record.mergeStatus = message.mergeStatus || 'none';
    record.mergeReason = message.reason ?? null;
  }
}

export function applyOptimisticSessionRename(
  draft: SessionsCollectionState,
  sessionId: string,
  newName: string,
): void {
  const record = draft.byId[sessionId];
  if (record) record.name = newName;
}

export function applyOptimisticSessionRemove(
  draft: SessionsCollectionState,
  sessionId: string,
): void {
  delete draft.byId[sessionId];
  removeFromOrder(draft.order, sessionId);
}

export function applyOptimisticSessionRestart(
  draft: SessionsCollectionState,
  sessionId: string,
): void {
  const record = draft.byId[sessionId];
  if (!record) return;
  record.state = STATES.INITIALIZING;
  record.failureReason = null;
  record.unseenOutcome = null;
  record.pendingPromptKind = null;
}

export function applyOptimisticChatStop(
  draft: SessionsCollectionState,
  sessionId: string,
): void {
  const record = draft.byId[sessionId];
  if (!record) return;
  record.state = STATES.IDLE;
}
