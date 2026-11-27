import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { AttentionOwner, ParentLink } from '#shared/contracts/session.ts';

type SnapshotCardFields = Pick<ServerMessageOf<'snapshot'>['sessions'][number], 'dangerouslySkipPermissions' | 'isWorktree' | 'isWorkspace' | 'saneYolo' | 'isQuestionManagerOn' | 'accountId' | 'path' | 'stateSince' | 'taskTitle' | 'taskTitleIsCustom' | 'attentionOwner' | 'hasTerminal'>;
type MessageCardFields = Pick<ServerMessageOf<'session-added'>, 'skipPerms' | 'worktree' | 'workspace' | 'ephemeral' | 'hasTerminal'>;
type SessionCardFields = Partial<SnapshotCardFields & MessageCardFields> & { parent?: ParentLink | null; isStudioMain?: boolean };

export interface CardOptions {
  taskTitle?: string | null;
  taskTitleIsCustom?: boolean;
  skipPerms?: boolean;
  saneYolo?: boolean;
  isQuestionManagerOn?: boolean | null;
  accountId?: string | null;
  worktree?: boolean;
  workspace?: boolean;
  ephemeral?: boolean;
  hasTerminal?: boolean;
  parent?: ParentLink | null;
  isStudioMain?: boolean;
  attentionOwner?: AttentionOwner;
  path?: unknown;
  stateSince?: unknown;
}

export function buildSessionCardOptions(session: SessionCardFields): CardOptions {
  return {
    skipPerms: session.skipPerms ?? session.dangerouslySkipPermissions ?? false,
    saneYolo: session.saneYolo === true,
    isQuestionManagerOn: session.isQuestionManagerOn ?? null,
    accountId: session.accountId ?? null,
    worktree: session.worktree ?? session.isWorktree ?? false,
    workspace: session.workspace ?? session.isWorkspace ?? false,
    ephemeral: session.ephemeral === true,
    hasTerminal: session.hasTerminal !== false,
    parent: session.parent ?? null,
    isStudioMain: session.isStudioMain === true,
    attentionOwner: session.attentionOwner ?? 'operator',
    path: session.path,
    stateSince: session.stateSince,
    taskTitle: typeof session.taskTitle === 'string' ? session.taskTitle : null,
    taskTitleIsCustom: session.taskTitleIsCustom === true,
  };
}
