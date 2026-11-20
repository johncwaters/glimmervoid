import { z } from 'zod';
import { PLAN_GATE_FEEDBACK_MAX_CHARS, PlanDecision } from '../plan-gate.ts';
import { AgentDoneLine, CHAT_OUTBOX_TEXT_MAX_CHARS, CHAT_SEND_MAX_ATTACHMENTS, ConversationAnswers, MergeStatus, PermissionDecision, SessionSnapshot, SessionState, TaskTitle, UploadFileName } from '../session.ts';
import { LinkedPr } from '../my-prs.ts';
import { WakeId, WakeView } from '../wakes.ts';
import { ModelSelection } from '../agent-models.ts';
import { StartPicks } from '../start-picks.ts';
import { ManagerDecision } from '../question-manager.ts';
import { AgentAccountId } from '../agent-accounts.ts';
import { AgeFileRemove, ProjectApprovals, SecretDecision, SecretName, SecretRequestCard, SecretRevoke, SecretSourceTestResult } from '../secrets.ts';
import { requestId, sessionId, KeptWorkPath, PullRequestKey, loose, openObject, nullableString, timestamp, optionalError, SessionCardFields, NotifyAlertGroup, SessionStatusFields } from './control-fields.ts';

export const CHAT_SEND_MAX_CHARS = CHAT_OUTBOX_TEXT_MAX_CHARS;

const restartClientShape = { id: sessionId, force: z.unknown().optional(), fresh: z.unknown().optional(), conversationId: z.string().optional() };

export const sessionClientVariants = [
  loose('list-start-picks', { requestId }),
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
    accountId: AgentAccountId.nullable().optional(),
    resumeSessionId: z.string().optional(),
    prompt: z.string().max(4000).optional(),
    setup: ModelSelection.optional(),
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
  loose('cancel-wake', { id: sessionId, wake: WakeId }),
  loose('wake-at-limit-reset', { id: sessionId, requestId }),
  loose('dismiss', { id: sessionId, force: z.unknown().optional(), expectedState: SessionState.optional() }),
  loose('manager-seen', { id: sessionId, throughSeq: z.number().int().min(1) }),
  loose('set-session-question-manager', { id: sessionId, isOn: z.boolean() }),
  loose('plan-decision', { id: sessionId, decision: PlanDecision, feedback: z.string().max(PLAN_GATE_FEEDBACK_MAX_CHARS).optional() }),
  loose('answer-approval', { id: sessionId, requestId: z.union([z.string().min(1).max(128), z.number().int()]), answers: ConversationAnswers }),
  loose('decide-approval', { id: sessionId, requestId: z.union([z.string().min(1).max(128), z.number().int()]), decision: PermissionDecision, message: z.string().trim().min(1).max(CHAT_SEND_MAX_CHARS).optional() }),
  loose('chat-send', { id: sessionId, text: z.string().trim().max(CHAT_SEND_MAX_CHARS), attachments: z.array(UploadFileName).max(CHAT_SEND_MAX_ATTACHMENTS).default([]), requestId })
    .refine((send) => send.text.length > 0 || send.attachments.length > 0, { message: 'chat-send needs text or an attachment' }),
  loose('chat-cancel', { id: sessionId, entryId: z.string().min(1).max(64), requestId }),
  loose('switch-session-account', { id: sessionId, accountId: AgentAccountId.nullable(), requestId }),
  loose('switch-session-model', { id: sessionId, setup: ModelSelection, requestId }),
  loose('secret-decision', SecretDecision.shape),
  loose('secret-revoke', SecretRevoke.shape),
  loose('age-file-remove', AgeFileRemove.shape),
  loose('secret-source-test', { requestId, lookIn: z.string() }),
] as const;

export const sessionServerVariants = [
  loose('snapshot', {
    sessions: z.array(SessionSnapshot),
    serverBuild: nullableString,
  }),
  loose('start-picks', { requestId, picks: StartPicks }),
  loose('add-session-result', { requestId, ok: z.boolean(), error: optionalError, reason: z.enum(['not-git']).optional(), sessionId: z.string().optional() }),
  loose('switch-session-account-result', { requestId, id: sessionId, ok: z.boolean(), error: optionalError, needsSignIn: z.boolean().optional() }),
  loose('wake-at-limit-reset-result', { requestId, id: sessionId, ok: z.boolean(), error: optionalError }),
  loose('switch-session-model-result', { requestId, id: sessionId, ok: z.boolean(), error: optionalError }),
  loose('chat-send-result', { requestId, id: sessionId, ok: z.boolean(), error: optionalError, acceptedAt: z.number().finite() }),
  loose('chat-cancel-result', { requestId, id: sessionId, cancelledTexts: z.array(z.string().max(CHAT_SEND_MAX_CHARS)), cancelledAttachments: z.array(UploadFileName).default([]) }),
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
  loose('session-done-lines', { id: sessionId, agentDoneLines: z.array(AgentDoneLine) }),
  loose('session-wakes', { id: sessionId, wakes: z.array(WakeView) }),
  loose('session-git', { id: sessionId, worktree: z.boolean() }),
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
  loose('session-secret-request', { id: sessionId, card: SecretRequestCard.nullable() }),
  loose('secret-requests-snapshot', { requests: z.record(z.string(), SecretRequestCard) }),
  loose('secret-approvals', { projects: z.array(ProjectApprovals), ageFileNames: z.array(SecretName) }),
  loose('secret-source-test-result', { requestId, ...SecretSourceTestResult.shape }),
] as const;
