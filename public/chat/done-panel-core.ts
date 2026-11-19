import type { AgentDoneLine } from '#shared/contracts/session.ts';
import { AGENT_DONE_CHECK_ID_PREFIX } from '#shared/contracts/verification.ts';
import type { CheckOutcome, RemovedTestLine, VerificationRun } from '#shared/contracts/verification.ts';
import type { ChatPhase } from './chat-activity-core.ts';

type DoneLineStatus = 'running' | 'passed' | 'failed' | 'not-checked';
export type DoneLine = { text: string; status: DoneLineStatus; proof: string; isGlimmervoidRan: boolean; evidence: string; command: string; isFromAgent: boolean };
export type DonePanelModel = { lines: DoneLine[]; metCount: number };

export const CHECK_STATUS_WORDS: Record<CheckOutcome['status'], string> = { pass: 'Passed', fail: 'Failed', timeout: 'Timed out', skipped: 'Skipped' };

const FINISHED_PHASES: readonly ChatPhase[] = ['quiet', 'stopped'];
const LINE_STATUS_BY_CHECK_STATUS: Record<CheckOutcome['status'], DoneLineStatus> = { pass: 'passed', fail: 'failed', timeout: 'failed', skipped: 'not-checked' };

function checkLineOf(check: CheckOutcome): DoneLine {
  const status = LINE_STATUS_BY_CHECK_STATUS[check.status];
  return {
    text: check.id,
    status,
    proof: CHECK_STATUS_WORDS[check.status],
    isGlimmervoidRan: status !== 'not-checked',
    evidence: status === 'failed' ? check.outputTail.trim() : '',
    command: '',
    isFromAgent: false,
  };
}

const REMOVED_TEST_LINE_VERBS: Record<RemovedTestLine['kind'], string> = { 'removed-assertion': 'removed', 'removed-test': 'removed', 'added-skip': 'added' };

function testKeepingLineOf(removedTestLines: readonly RemovedTestLine[] | null): DoneLine {
  if (removedTestLines === null) return { text: 'Keeps every test', status: 'not-checked', proof: 'Not checked', isGlimmervoidRan: false, evidence: '', command: '', isFromAgent: false };
  const isKept = removedTestLines.length === 0;
  return {
    text: 'Keeps every test',
    status: isKept ? 'passed' : 'failed',
    proof: isKept ? 'Passed' : 'Failed',
    isGlimmervoidRan: true,
    evidence: removedTestLines.map((removed) => `${removed.path}:${removed.line} ${REMOVED_TEST_LINE_VERBS[removed.kind]}: ${removed.text}`).join('\n'),
    command: '',
    isFromAgent: false,
  };
}

function runLinesOf(run: VerificationRun): DoneLine[] {
  if (run.status === 'running') return [{ text: 'Repo checks', status: 'running', proof: 'Running', isGlimmervoidRan: true, evidence: '', command: '', isFromAgent: false }];
  return [...run.checks.filter((check) => !check.id.startsWith(AGENT_DONE_CHECK_ID_PREFIX)).map(checkLineOf), testKeepingLineOf(run.removedTestLines)];
}

function agentCheckOf(run: VerificationRun, line: AgentDoneLine, index: number): CheckOutcome | null {
  return run.checks.find((check) => check.id === `${AGENT_DONE_CHECK_ID_PREFIX}${index + 1}` && check.command === line.command) ?? null;
}

function agentDoneLinesOf(run: VerificationRun, agentDoneLines: readonly AgentDoneLine[]): DoneLine[] {
  if (run.status === 'running') return [];
  return agentDoneLines.flatMap((line, index) => {
    const check = agentCheckOf(run, line, index);
    if (check === null) return [];
    return [{ ...checkLineOf(check), text: line.text, command: line.command, isFromAgent: true }];
  });
}

export function donePanelModelOf(input: { run: VerificationRun | null; agentDoneLines: readonly AgentDoneLine[]; phase: ChatPhase }): DonePanelModel | null {
  if (!FINISHED_PHASES.includes(input.phase) || input.run === null) return null;
  const lines = [...agentDoneLinesOf(input.run, input.agentDoneLines), ...runLinesOf(input.run)];
  if (lines.length === 0) return null;
  return { lines, metCount: lines.filter((line) => line.status === 'passed').length };
}
