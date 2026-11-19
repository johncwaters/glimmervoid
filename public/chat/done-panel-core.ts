import type { AgentDoneLine } from '#shared/contracts/session.ts';
import { AGENT_COMMAND_WAITING_REASON, AGENT_DONE_CHECK_ID_PREFIX } from '#shared/contracts/verification.ts';
import type { CheckOutcome, RemovedTestLine, VerificationRun } from '#shared/contracts/verification.ts';
import type { ChatPhase } from './chat-activity-core.ts';

type DoneLineStatus = 'running' | 'passed' | 'failed' | 'not-checked';
export type DoneLine = { text: string; status: DoneLineStatus; proof: string; isGlimmervoidRan: boolean; evidence: string; command: string; isFromAgent: boolean };
export type DonePanelModel = { lines: DoneLine[]; metCount: number; verdict: string | null; waitingCommands: string[] };

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
  return [...run.checks.filter((check) => !check.id.startsWith(AGENT_DONE_CHECK_ID_PREFIX)).map(checkLineOf), testKeepingLineOf(run.removedTestLines)];
}

function doneMeansLineOf(text: string): DoneLine {
  return { text, status: 'not-checked', proof: 'Not checked', isGlimmervoidRan: false, evidence: '', command: '', isFromAgent: false };
}

function agentCheckOf(run: VerificationRun | null, line: AgentDoneLine, index: number): CheckOutcome | null {
  if (run === null || line.command === undefined) return null;
  return run.checks.find((check) => check.id === `${AGENT_DONE_CHECK_ID_PREFIX}${index + 1}` && check.command === line.command) ?? null;
}

function isWaitingForOperator(check: CheckOutcome): boolean {
  return check.status === 'skipped' && check.outputTail === AGENT_COMMAND_WAITING_REASON;
}

function agentDoneLineOf(line: AgentDoneLine, check: CheckOutcome | null): DoneLine {
  const unchecked = { ...doneMeansLineOf(line.text), command: line.command ?? '', isFromAgent: true };
  if (check === null) return unchecked;
  if (isWaitingForOperator(check)) return { ...unchecked, proof: 'Waiting for you' };
  return { ...checkLineOf(check), text: line.text, command: line.command ?? '', isFromAgent: true };
}

function waitingCommandsOf(run: VerificationRun | null, agentDoneLines: readonly AgentDoneLine[]): string[] {
  if (run === null || run.status === 'running') return [];
  return agentDoneLines.flatMap((line, index) => {
    if (line.command === undefined) return [];
    const check = agentCheckOf(run, line, index);
    return check === null || isWaitingForOperator(check) ? [line.command] : [];
  });
}

const VERDICT_QUESTION = 'Is the work done?';

function verdictOf(lines: readonly DoneLine[]): string | null {
  if (lines.some((line) => line.status === 'running')) return null;
  return VERDICT_QUESTION;
}

export function donePanelModelOf(input: { run: VerificationRun | null; doneMeans: readonly string[]; agentDoneLines: readonly AgentDoneLine[]; phase: ChatPhase }): DonePanelModel | null {
  if (!FINISHED_PHASES.includes(input.phase)) return null;
  const agentLines = input.agentDoneLines.map((line, index) => agentDoneLineOf(line, agentCheckOf(input.run, line, index)));
  const lines = [...input.doneMeans.map(doneMeansLineOf), ...agentLines, ...runLinesOf(input.run)];
  if (lines.length === 0) return null;
  return { lines, metCount: lines.filter((line) => line.status === 'passed').length, verdict: verdictOf(lines), waitingCommands: [...new Set(waitingCommandsOf(input.run, input.agentDoneLines))] };
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
