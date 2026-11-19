import type { AgentDoneLine } from '#shared/contracts/session.ts';
import type { CheckOutcome, RemovedTestLine, VerificationRun } from '#shared/contracts/verification.ts';
import type { ChatPhase } from './chat-activity-core.ts';

type DoneLineStatus = 'running' | 'passed' | 'failed' | 'not-checked';
export type DoneLine = { text: string; status: DoneLineStatus; proof: string; isGlimmervoidRan: boolean; evidence: string; command: string; isFromAgent: boolean };
export type DonePanelModel = { lines: DoneLine[]; metCount: number; verdict: string | null };

export const CHECK_STATUS_WORDS: Record<CheckOutcome['status'], string> = { pass: 'Passed', fail: 'Failed', timeout: 'Timed out', skipped: 'Skipped' };

export const ACCEPT_MESSAGE = 'Accepted as done. Land this work now.';

const SEND_BACK_HEADING = 'Not done. These Done means lines failed:';
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

function runLinesOf(run: VerificationRun | null): DoneLine[] {
  if (run === null) return [];
  if (run.status === 'running') return [{ text: 'Repo checks', status: 'running', proof: 'Running', isGlimmervoidRan: true, evidence: '', command: '', isFromAgent: false }];
  return [...run.checks.map(checkLineOf), testKeepingLineOf(run.removedTestLines)];
}

function doneMeansLineOf(text: string): DoneLine {
  return { text, status: 'not-checked', proof: 'Not checked', isGlimmervoidRan: false, evidence: '', command: '', isFromAgent: false };
}

function agentDoneLineOf(line: AgentDoneLine): DoneLine {
  return { ...doneMeansLineOf(line.text), command: line.command ?? '', isFromAgent: true };
}

function verdictOf(lines: readonly DoneLine[]): string | null {
  if (lines.some((line) => line.status === 'running')) return null;
  const failedCount = lines.filter((line) => line.status === 'failed').length;
  const passedCount = lines.filter((line) => line.status === 'passed').length;
  if (failedCount === 0 && passedCount === 0) return 'The agent finished. No line was checked.';
  if (failedCount === 0) return 'The agent finished. Every checked line passed.';
  return `The agent finished. ${failedCount} ${failedCount === 1 ? 'line' : 'lines'} failed.`;
}

export function donePanelModelOf(input: { run: VerificationRun | null; doneMeans: readonly string[]; agentDoneLines: readonly AgentDoneLine[]; phase: ChatPhase }): DonePanelModel | null {
  if (!FINISHED_PHASES.includes(input.phase)) return null;
  const lines = [...input.doneMeans.map(doneMeansLineOf), ...input.agentDoneLines.map(agentDoneLineOf), ...runLinesOf(input.run)];
  if (lines.length === 0) return null;
  return { lines, metCount: lines.filter((line) => line.status === 'passed').length, verdict: verdictOf(lines) };
}

function lastCharsOf(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - Math.max(0, maxChars));
}

export function sendBackMessageOf(model: DonePanelModel, maxChars: number): string {
  const failedLines = model.lines.filter((line) => line.status === 'failed');
  const headings = failedLines.map((line) => `\n\n${line.text} (${line.proof})`);
  const evidenceSeparator = ':\n';
  const linesWithEvidenceCount = failedLines.filter((line) => line.evidence !== '').length;
  const fixedLength = SEND_BACK_HEADING.length + headings.reduce((total, heading) => total + heading.length, 0) + linesWithEvidenceCount * evidenceSeparator.length;
  const evidenceBudgetPerLine = Math.floor(Math.max(0, maxChars - fixedLength) / Math.max(1, linesWithEvidenceCount));
  const sections = failedLines.map((line, index) => {
    const evidence = lastCharsOf(line.evidence, evidenceBudgetPerLine);
    return evidence === '' ? headings[index] : `${headings[index]}${evidenceSeparator}${evidence}`;
  });
  return `${SEND_BACK_HEADING}${sections.join('')}`.slice(0, maxChars);
}
