import type { AgentDoneLine } from '#shared/contracts/session.ts';
import { AGENT_DONE_CHECK_ID_PREFIX, agentDoneCheckIdOf } from '#shared/contracts/verification.ts';
import type { CheckOutcome, VerificationRun } from '#shared/contracts/verification.ts';
import type { ChatPhase } from './chat-activity-core.ts';

type DoneLineStatus = 'passed' | 'failed' | 'not-checked';
export type DoneLine = { text: string; status: DoneLineStatus; proof: string; evidence: string; command: string };
export type DonePanelModel =
  | { kind: 'running'; runKey: string }
  | { kind: 'settled'; runKey: string; failedLines: DoneLine[]; foldedLines: DoneLine[]; passedCount: number; skippedCount: number };

export const CHECK_STATUS_WORDS: Record<CheckOutcome['status'], string> = { pass: 'Passed', fail: 'Failed', timeout: 'Timed out', skipped: 'Skipped' };

const FINISHED_PHASES: readonly ChatPhase[] = ['quiet', 'stopped'];
const LINE_STATUS_BY_CHECK_STATUS: Record<CheckOutcome['status'], DoneLineStatus> = { pass: 'passed', fail: 'failed', timeout: 'failed', skipped: 'not-checked' };

function checkLineOf(check: CheckOutcome): DoneLine {
  const status = LINE_STATUS_BY_CHECK_STATUS[check.status];
  return {
    text: check.id,
    status,
    proof: CHECK_STATUS_WORDS[check.status],
    evidence: status === 'failed' ? check.outputTail.trim() : '',
    command: '',
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

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function settledSummaryText(model: Extract<DonePanelModel, { kind: 'settled' }>): string {
  const passedText = `${countLabel(model.passedCount, 'check', 'checks')} passed`;
  if (model.skippedCount === 0) return passedText;
  if (model.passedCount === 0) return `${countLabel(model.skippedCount, 'check', 'checks')} skipped`;
  return `${passedText}, ${model.skippedCount} skipped`;
}

export function foldedSummaryText(model: Extract<DonePanelModel, { kind: 'settled' }>): string {
  const passedText = `${model.passedCount} more passed`;
  if (model.skippedCount === 0) return passedText;
  if (model.passedCount === 0) return `${model.skippedCount} skipped`;
  return `${passedText}, ${model.skippedCount} skipped`;
}

export function failedCountText(model: Extract<DonePanelModel, { kind: 'settled' }>): string {
  return `${model.failedLines.length} of ${model.failedLines.length + model.foldedLines.length} failed`;
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
    foldedLines: lines.filter((line) => line.status !== 'failed'),
    passedCount: lines.filter((line) => line.status === 'passed').length,
    skippedCount: lines.filter((line) => line.status === 'not-checked').length,
  };
}
