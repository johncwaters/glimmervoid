import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';

type SnapshotCardFields = Pick<ServerMessageOf<'snapshot'>['sessions'][number], 'dangerouslySkipPermissions' | 'isWorktree' | 'isWorkspace' | 'saneYolo' | 'path' | 'stateSince' | 'taskTitle' | 'taskTitleIsCustom'>;
type MessageCardFields = Pick<ServerMessageOf<'session-added'>, 'skipPerms' | 'worktree' | 'workspace'>;
type SessionCardFields = Partial<SnapshotCardFields & MessageCardFields>;

export interface CardOptions {
  taskTitle?: string | null;
  taskTitleIsCustom?: boolean;
  skipPerms?: boolean;
  saneYolo?: boolean;
  worktree?: boolean;
  workspace?: boolean;
  path?: unknown;
  stateSince?: unknown;
}

export function buildSessionCardOptions(session: SessionCardFields): CardOptions {
  return {
    skipPerms: session.skipPerms ?? session.dangerouslySkipPermissions ?? false,
    saneYolo: session.saneYolo === true,
    worktree: session.worktree ?? session.isWorktree ?? false,
    workspace: session.workspace ?? session.isWorkspace ?? false,
    path: session.path,
    stateSince: session.stateSince,
    taskTitle: typeof session.taskTitle === 'string' ? session.taskTitle : null,
    taskTitleIsCustom: session.taskTitleIsCustom === true,
  };
}
