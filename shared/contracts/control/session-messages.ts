import { z } from 'zod';
import { CoherenceHooksState, MergeStatus, SessionSnapshot, SessionState, TaskTitle } from '../session.ts';
import { LinkedPr } from '../my-prs.ts';
import { ManagerDecision } from '../question-manager.ts';
import { PackSecretLink, PackSecretRow, ProjectApprovals, SecretDecision, SecretName, SecretRevoke } from '../secrets.ts';
import { requestId, sessionId, KeptWorkPath, PullRequestKey, loose, openObject, nullableString, timestamp, optionalError, SessionCardFields, NotifyAlertGroup, SessionStatusFields } from './control-fields.ts';

const restartClientShape = { id: sessionId, force: z.unknown().optional(), fresh: z.unknown().optional(), conversationId: z.string().optional() };

export const sessionClientVariants = [
  loose('restart', restartClientShape),
  loose('force-restart', restartClientShape),
  loose('add-session', {
    name: z.string(),
    path: z.string(),
    repos: z.array(z.string()).optional(),
    agent: z.string().optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
    saneYolo: z.boolean().optional(),
    runInPlace: z.boolean().optional(),
    environment: z.string().optional(),
    resumeSessionId: z.string().optional(),
    prompt: z.string().max(4000).optional(),
    requestId,
  }),
  loose('quick-session', { id: sessionId, requestId }),
  loose('remove-session', { id: sessionId, force: z.unknown().optional(), checkOnly: z.boolean().optional(), discardWork: z.boolean().optional(), confirmedKeptPaths: z.array(z.string()).optional(), requestId }),
  loose('list-conversations', { id: sessionId, requestId }),
  loose('resume-conversation', { id: sessionId, conversationId: z.string() }),
  loose('rename-session', { id: sessionId, newName: z.string() }),
  loose('get-workspace-repos', { id: sessionId, requestId }),
  loose('set-workspace-repos', { id: sessionId, repos: z.array(z.string()), requestId }),
  loose('set-session-title', { id: sessionId, title: TaskTitle }),
  loose('link-session-pr', { id: sessionId, key: PullRequestKey }),
  loose('unlink-session-pr', { id: sessionId, key: PullRequestKey }),
  loose('dismiss', { id: sessionId, force: z.unknown().optional(), expectedState: SessionState.optional() }),
  loose('manager-seen', { id: sessionId, throughSeq: z.number().int().min(1) }),
  loose('set-session-question-manager', { id: sessionId, isOn: z.boolean() }),
  loose('secret-decision', SecretDecision.shape),
  loose('secret-revoke', SecretRevoke.shape),
  loose('pack-secret-link', PackSecretLink.shape),
] as const;

export const sessionServerVariants = [
  loose('snapshot', {
    sessions: z.array(SessionSnapshot),
    serverBuild: nullableString,
  }),
  loose('add-session-result', { requestId, ok: z.boolean(), error: optionalError, reason: z.enum(['not-git']).optional(), sessionId: z.string().optional() }),
  loose('remove-session-result', { requestId, ok: z.boolean(), error: optionalError, canDiscardWork: z.boolean().optional(), keptPaths: z.array(KeptWorkPath).optional() }),
  loose('workspace-repos', { requestId, id: sessionId, ok: z.boolean(), repos: z.array(z.string()), error: optionalError }),
  loose('set-workspace-repos-result', { requestId, id: sessionId, ok: z.boolean(), error: optionalError }),
  loose('session-status', { id: sessionId, session: z.string(), timestamp, ...SessionStatusFields.shape }),
  loose('session-added', SessionCardFields.shape),
  loose('session-modified', SessionCardFields.shape),
  loose('session-removed', { id: sessionId, session: z.string() }),
  loose('session-close-confirm', { id: sessionId, mergeStatus: MergeStatus }),
  loose('session-renamed', { id: sessionId, oldName: z.string(), newName: z.string() }),
  loose('session-title', { id: sessionId, taskTitle: TaskTitle.nullable(), isCustom: z.boolean() }),
  loose('session-prs', { id: sessionId, linkedPrs: z.array(LinkedPr) }),
  loose('session-git', { id: sessionId, worktree: z.boolean() }),
  loose('session-coherence-hooks', { id: sessionId, coherenceHooks: CoherenceHooksState.nullable() }),
  loose('session-manager-decision', { id: sessionId, decision: ManagerDecision }),
  loose('notify', {
    session: z.string(),
    category: z.string(),
    message: z.string(),
    escalationCount: z.number().int().nonnegative(),
    group: NotifyAlertGroup.optional(),
  }),
  loose('post-turn-leftovers', { repositories: z.array(z.string()), command: z.string() }),
  loose('error', { id: sessionId.optional(), message: z.string(), requestId, scope: z.string().optional() }),
  loose('session-error', { id: sessionId.optional(), session: z.string(), message: z.string(), scope: z.string().optional() }),
  loose('conversations', {
    requestId,
    id: nullableString,
    current: nullableString.optional(),
    conversations: z.array(openObject({
      id: z.string(),
      title: z.string(),
      cwd: z.string(),
      worktreePath: z.string(),
      worktreeName: z.string(),
      gitBranch: nullableString,
      mtime: timestamp,
    })),
    error: z.string().optional(),
  }),
  loose('resume-conversation-ack', {
    id: sessionId.optional(),
    resumeSessionId: nullableString.optional(),
    ok: z.boolean(),
    error: z.string().optional(),
    requestId,
  }),
  loose('session-secret-request', { id: sessionId, names: z.array(SecretName), newItemsVault: z.string().nullable() }),
  loose('secret-requests-snapshot', { requests: z.record(z.string(), z.array(SecretName)), newItemsVault: z.string().nullable() }),
  loose('secret-approvals', { projects: z.array(ProjectApprovals), packSecrets: z.array(PackSecretRow) }),
] as const;
