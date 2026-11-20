import type { AgentDoneLine } from '#shared/contracts/session.ts';
import { AGENT_DONE_CHECK_ID_PREFIX, agentDoneCheckIdOf } from '#shared/contracts/verification.ts';
import type { CheckOutcome, VerificationRun } from '#shared/contracts/verification.ts';
import type { ChatPhase } from './chat-activity-core.ts';

type DoneLineStatus = 'passed' | 'failed' | 'not-checked';
export type DoneLine = { text: string; status: DoneLineStatus; proof: string; evidence: string; command: string };
type DonePillTone = 'running' | 'passed' | 'partial' | 'skipped' | 'failed';
export type DonePanelModel =
  | { kind: 'running'; runKey: string }
  | { kind: 'settled'; runKey: string; failedLines: DoneLine[]; skippedLines: DoneLine[]; passedLines: DoneLine[] };

export const CHECK_STATUS_WORDS: Record<CheckOutcome['status'], string> = { pass: 'Passed', fail: 'Failed', timeout: 'Timed out', skipped: 'Skipped' };

const FINISHED_PHASES: readonly ChatPhase[] = ['quiet', 'stopped'];
const LINE_STATUS_BY_CHECK_STATUS: Record<CheckOutcome['status'], DoneLineStatus> = { pass: 'passed', fail: 'failed', timeout: 'failed', skipped: 'not-checked' };

function checkLineOf(check: CheckOutcome): DoneLine {
  const status = LINE_STATUS_BY_CHECK_STATUS[check.status];
  return {
    text: check.id,
    status,
    proof: CHECK_STATUS_WORDS[check.status],
    evidence: status === 'passed' ? '' : check.outputTail.trim(),
    command: check.command,
  };
}

function repoCheckLinesOf(run: VerificationRun): DoneLine[] {
  return run.checks.filter((check) => !check.id.startsWith(AGENT_DONE_CHECK_ID_PREFIX)).map(checkLineOf);
}

function agentCheckOf(run: VerificationRun, line: AgentDoneLine, index: number): CheckOutcome | null {
  return run.checks.find((check) => check.id === agentDoneCheckIdOf(index) && check.command === line.command) ?? null;
}

function agentDoneLinesOf(run: VerificationRun, agentDoneLines: readonly AgentDoneLine[]): DoneLine[] {
  return agentDoneLines.flatMap((line, index) => {
    const check = agentCheckOf(run, line, index);
    if (check === null) return [];
    return [{ ...checkLineOf(check), text: line.text, command: line.command }];
  });
}

type SettledModel = Extract<DonePanelModel, { kind: 'settled' }>;

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function settledPillText(model: SettledModel): string {
  const failedCount = model.failedLines.length;
  const skippedCount = model.skippedLines.length;
  const passedCount = model.passedLines.length;
  const totalCount = failedCount + skippedCount + passedCount;
  if (failedCount > 0 && skippedCount === 0) return `${failedCount} of ${countLabel(totalCount, 'check', 'checks')} failed`;
  if (failedCount > 0) return `${failedCount} of ${totalCount} failed, ${skippedCount} skipped`;
  if (skippedCount === 0) return `${countLabel(passedCount, 'check', 'checks')} passed`;
  if (passedCount === 0) return `${countLabel(skippedCount, 'check', 'checks')} skipped`;
  return `${passedCount} passed, ${skippedCount} skipped`;
}

function settledPillTone(model: SettledModel): DonePillTone {
  if (model.failedLines.length > 0) return 'failed';
  if (model.skippedLines.length === 0) return 'passed';
  if (model.passedLines.length === 0) return 'skipped';
  return 'partial';
}

export function donePillOf(model: DonePanelModel): { tone: DonePillTone; text: string } {
  if (model.kind === 'running') return { tone: 'running', text: 'Running checks' };
  return { tone: settledPillTone(model), text: settledPillText(model) };
}

export function donePanelModelOf(input: { run: VerificationRun | null; agentDoneLines: readonly AgentDoneLine[]; phase: ChatPhase }): DonePanelModel | null {
  const { run } = input;
  if (!FINISHED_PHASES.includes(input.phase) || run === null) return null;
  const runKey = `${run.sig}:${run.finishedAt ?? 'running'}`;
  if (run.status === 'running') return { kind: 'running', runKey };
  const lines = [...agentDoneLinesOf(run, input.agentDoneLines), ...repoCheckLinesOf(run)];
  if (lines.length === 0) return null;
  return {
    kind: 'settled',
    runKey,
    failedLines: lines.filter((line) => line.status === 'failed'),
    skippedLines: lines.filter((line) => line.status === 'not-checked'),
    passedLines: lines.filter((line) => line.status === 'passed'),
  };
}
