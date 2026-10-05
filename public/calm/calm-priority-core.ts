import { ASK_USER_QUESTION_TOOL_NAME, isSamePromptQuestion, type PendingPromptDetail } from '#shared/contracts/session.ts';
import type { TraceRecord } from '#shared/contracts/trace.ts';
import { STATES } from '#shared/states.ts';
import { needsAttention, pickNextAttention } from '../focus-view/attention-core.ts';
import { formatMinutes } from '../usage-view-core.ts';
import { hasPermissionKeys } from './permission-keys-core.ts';

export type CalmTier = 'now' | 'next' | 'later' | 'ready' | 'working' | 'resting';

export interface CalmRow {
  id: string;
  name: string;
  state: string;
  stateSince?: number | null;
  agent?: string | null;
  pendingPromptKind?: string | null;
  pendingPromptDetail?: PendingPromptDetail | null;
  unseen?: boolean;
}

export function tierOf(row: CalmRow): CalmTier {
  if (row.state === STATES.WAITING) return 'now';
  if (row.state === STATES.FAILED) return 'next';
  if (needsAttention(row)) return 'later';
  switch (row.state) {
    case STATES.IDLE:
    case STATES.COMPLETE:
      return 'ready';
    case STATES.RUNNING:
    case STATES.STARTING:
    case STATES.INITIALIZING:
      return 'working';
    default:
      return 'resting';
  }
}

const QUEUE_RANK_BY_TIER = { now: 0, next: 1, later: 2, ready: 3, working: 4, resting: 5 };

export function orderCalmQueue<Row extends CalmRow>(rows: readonly Row[]): Row[] {
  return rows.map((row, index) => ({ row, index, rank: QUEUE_RANK_BY_TIER[tierOf(row)] }))
    .filter((entry) => entry.rank < QUEUE_RANK_BY_TIER.ready)
    .sort((first, second) => first.rank - second.rank
      || (first.row.stateSince ?? Infinity) - (second.row.stateSince ?? Infinity)
      || first.index - second.index)
    .map((entry) => entry.row);
}

export function pickNowPeek<Row extends CalmRow>(rows: readonly Row[], focusedSessionId: string | null | undefined): Row | null {
  return orderCalmQueue(rows).find((row) => tierOf(row) === 'now' && row.id !== focusedSessionId) ?? null;
}

export function pickNextQueueSessionId(rows: readonly CalmRow[], currentSessionId: string | null | undefined): string | null {
  return pickNextAttention(orderCalmQueue(rows).map((row) => row.id), currentSessionId) ?? null;
}

export function pickSessionAfterSubmit(
  submittedSessionId: string,
  openedFromQueueSessionId: string | null,
  rows: readonly CalmRow[],
): string | null {
  if (!openedFromQueueSessionId || submittedSessionId !== openedFromQueueSessionId) return null;
  return pickNowPeek(rows, submittedSessionId)?.id ?? null;
}

export const ARMED_ADVANCE_LIFETIME_MS = 15000;

export interface ArmedAdvance {
  sessionId: string;
  armedAtMs: number;
  armedStateSince: number | null | undefined;
  armedPromptSummary: string | undefined;
}

export interface ArmedSessionSnapshot {
  state: string;
  stateSince: number | null | undefined;
  pendingPromptSummary: string | undefined;
}

export type ArmedAdvanceDecision = 'fire' | 'keep' | 'cancel';

export function decideArmedAdvance(
  armed: ArmedAdvance,
  session: ArmedSessionSnapshot | null,
  nowMs: number,
  hasOtherInputArrived: boolean,
): ArmedAdvanceDecision {
  if (!session || hasOtherInputArrived) return 'cancel';
  if (nowMs - armed.armedAtMs >= ARMED_ADVANCE_LIFETIME_MS) return 'cancel';
  const isNewPrompt = session.pendingPromptSummary !== undefined && session.pendingPromptSummary !== armed.armedPromptSummary;
  if (session.state === STATES.WAITING && isNewPrompt) return 'cancel';
  if (session.stateSince === armed.armedStateSince) return 'keep';
  return session.state === STATES.RUNNING ? 'fire' : 'cancel';
}

const MS_PER_MINUTE = 60000;

export function formatWaitTime(elapsedMs: number): string {
  const totalMinutes = Math.floor(Math.max(0, elapsedMs) / MS_PER_MINUTE);
  if (totalMinutes < 1) return '<1m';
  return formatMinutes(totalMinutes);
}

export function countByTier(rows: readonly CalmRow[]) {
  const counts = { now: 0, next: 0, later: 0, ready: 0, working: 0 };
  for (const row of rows) {
    const tier = tierOf(row);
    if (tier === 'resting') continue;
    counts[tier] += 1;
  }
  return counts;
}

export type CalmComponent = 'permission' | 'question' | 'plan' | 'failure' | 'review' | 'terminal';

function isAnswerableQuestion(detail: PendingPromptDetail | null | undefined): boolean {
  return detail?.question?.multiSelect === false;
}

function pickPromptComponent(row: CalmRow): { component: CalmComponent; canApprove: boolean } {
  if (row.pendingPromptKind === 'plan') return { component: 'plan', canApprove: false };
  if (row.pendingPromptKind !== 'permission' || !hasPermissionKeys(row.agent)) return { component: 'terminal', canApprove: false };
  if (isAnswerableQuestion(row.pendingPromptDetail)) return { component: 'question', canApprove: false };
  if (row.pendingPromptDetail?.toolName === ASK_USER_QUESTION_TOOL_NAME) return { component: 'terminal', canApprove: false };
  return { component: 'permission', canApprove: row.pendingPromptDetail?.isComplete === true };
}

export function pickComponent(row: CalmRow): { component: CalmComponent; canApprove: boolean } {
  switch (tierOf(row)) {
    case 'now':
      return pickPromptComponent(row);
    case 'next':
      return { component: 'failure', canApprove: false };
    case 'later':
      return { component: 'review', canApprove: false };
    default:
      return { component: 'terminal', canApprove: false };
  }
}

const PANEL_CONTEXT_BY_COMPONENT: Record<Exclude<CalmComponent, 'terminal'>, string> = {
  permission: 'wants to run',
  question: 'asks',
  plan: 'has a plan ready',
  failure: 'failed',
  review: 'finished',
};

const TERMINAL_PANEL_CONTEXT_BY_STATE = new Map<string, string>([
  [STATES.RUNNING, 'is working'],
  [STATES.STARTING, 'is working'],
  [STATES.INITIALIZING, 'is working'],
  [STATES.IDLE, 'is idle'],
  [STATES.DONE, 'has exited'],
  [STATES.DORMANT, 'is asleep'],
  [STATES.COMPLETE, 'finished'],
]);

export function panelContextFor(row: CalmRow, component: CalmComponent): string {
  if (component !== 'terminal') return PANEL_CONTEXT_BY_COMPONENT[component];
  return TERMINAL_PANEL_CONTEXT_BY_STATE.get(row.state) ?? (tierOf(row) === 'now' ? 'needs you' : 'is quiet');
}

export function isSamePermissionPrompt(
  currentState: string,
  currentKind: string | null | undefined,
  currentDetail: PendingPromptDetail | null | undefined,
  shownDetail: PendingPromptDetail | null | undefined,
): boolean {
  if (currentState !== STATES.WAITING || currentKind !== 'permission') return false;
  if (!currentDetail || !shownDetail) return false;
  return currentDetail.toolName === shownDetail.toolName
    && currentDetail.summary === shownDetail.summary
    && currentDetail.isComplete === shownDetail.isComplete
    && isSamePromptQuestion(currentDetail.question, shownDetail.question);
}

export function canReplyToFinishedSession(currentState: string, pendingPromptKind: string | null | undefined): boolean {
  const isFinished = currentState === STATES.COMPLETE || currentState === STATES.IDLE;
  return isFinished && (pendingPromptKind === null || pendingPromptKind === undefined);
}

export function offersReplyInput(row: Pick<CalmRow, 'agent'>): boolean {
  return hasPermissionKeys(row.agent);
}

export function offersNextInstructionInput(row: CalmRow): boolean {
  return pickComponent(row).component === 'terminal' && tierOf(row) === 'ready' && offersReplyInput(row);
}

export function latestAgentMessageText(records: readonly TraceRecord[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.kind === 'assistant' && !record.agentType && record.text.trim()) return record.text.trim();
  }
  return null;
}
