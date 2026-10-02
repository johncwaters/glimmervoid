import { buildPanelSection, buildStatChip, el } from './dom-helpers.ts';
import type { BenchmarkAction, BenchmarkArmScore, BenchmarkReport, BenchmarkStatus, BenchmarkSuiteSummary } from '#shared/contracts/benchmark.ts';

type BenchmarkRequestSender = (message: Record<string, unknown>) => boolean;

const ACTION_LABELS: Readonly<Record<BenchmarkAction, string>> = { mine: 'Mine', run: 'Run', cancel: 'Cancel' };
const ACTION_PENDING_TEXT: Readonly<Record<BenchmarkAction, string>> = { mine: 'Mining merged pull requests.', run: 'Starting the run.', cancel: 'Cancelling the run.' };

let root: HTMLDivElement | null = null;
let status: BenchmarkStatus | null = null;
let requestSender: BenchmarkRequestSender | null = null;
let requestSeq = 0;
const pendingActionBySuite = new Map<string, BenchmarkAction>();
const outcomeBySuite = new Map<string, string>();

function percent(ratio: number | null): string {
  if (ratio === null) return 'n/a';
  return `${Math.round(ratio * 100)}%`;
}

function signedPoints(delta: number | null): string {
  if (delta === null) return 'n/a';
  const points = Math.round(delta * 100);
  return points > 0 ? `+${points}` : String(points);
}

function sendAction(suiteId: string, action: BenchmarkAction): void {
  requestSeq += 1;
  const sent = requestSender?.({ type: 'benchmark-action', requestId: `benchmark-${requestSeq}`, suiteId, action }) === true;
  if (!sent) {
    outcomeBySuite.set(suiteId, 'Not connected.');
    render();
    return;
  }
  pendingActionBySuite.set(suiteId, action);
  outcomeBySuite.set(suiteId, ACTION_PENDING_TEXT[action]);
  render();
}

function buildActionButton(suite: BenchmarkSuiteSummary, action: BenchmarkAction, isDisabled: boolean): HTMLButtonElement {
  const button = el('button', 'bench-action-button', ACTION_LABELS[action]);
  button.type = 'button';
  button.disabled = isDisabled;
  button.addEventListener('click', () => sendAction(suite.id, action));
  return button;
}

function inFlightText(suite: BenchmarkSuiteSummary): string {
  const cell = status?.inFlight;
  if (!cell || cell.suiteId !== suite.id) return '';
  const casePart = cell.caseId ? `case ${cell.caseId}, ` : '';
  return `Cell ${cell.cellIndex + 1} of ${cell.cellCount}: ${casePart}arm ${cell.armId}, trial ${cell.trial}, ${cell.phase}.`;
}

function scoreCell(score: BenchmarkArmScore | undefined): HTMLTableCellElement {
  const cell = el('td', 'bench-score', percent(score?.recall ?? null));
  if (score && score.invalid > 0) cell.title = `${score.invalid} invalid or failed cell(s)`;
  if (score && score.degraded > 0) cell.dataset.degraded = 'true';
  return cell;
}

function buildReportTable(report: BenchmarkReport): HTMLTableElement {
  const comparedArms = report.armIds.filter((armId) => armId !== report.baselineArm);
  const table = el('table', 'bench-table');
  const head = el('tr');
  head.append(el('th', null, 'Case'), ...report.armIds.map((armId) => el('th', null, armId === report.baselineArm ? `${armId} (baseline)` : armId)));
  head.append(...comparedArms.map((armId) => el('th', null, `${armId} vs baseline`)));
  table.append(head);
  for (const row of report.rows) {
    const line = el('tr');
    line.append(el('td', 'bench-case', row.caseId), ...report.armIds.map((armId) => scoreCell(row.arms[armId])));
    line.append(...comparedArms.map((armId) => el('td', 'bench-delta', signedPoints(row.deltaVsBaseline[armId] ?? null))));
    table.append(line);
  }
  const tags = [...new Set(report.armIds.flatMap((armId) => Object.keys(report.totals[armId]?.recallByTag ?? {})))].sort();
  const totalLine = el('tr', 'bench-total');
  totalLine.append(el('td', 'bench-case', 'Paired recall'), ...report.armIds.map((armId) => scoreCell(report.totals[armId])));
  table.append(totalLine);
  for (const tag of tags) {
    const tagLine = el('tr', 'bench-total');
    tagLine.append(el('td', 'bench-case', `Recall, ${tag}`), ...report.armIds.map((armId) => el('td', 'bench-score', percent(report.totals[armId]?.recallByTag[tag] ?? null))));
    table.append(tagLine);
  }
  return table;
}

function buildSuite(suite: BenchmarkSuiteSummary): HTMLElement {
  const card = el('div', 'bench-suite');
  const isThisSuiteRunning = status?.inFlight?.suiteId === suite.id;
  const isAnotherSuiteRunning = Boolean(status?.inFlight) && !isThisSuiteRunning;
  const isPending = pendingActionBySuite.has(suite.id);
  const summary = el('div', 'bench-summary');
  summary.append(
    el('span', 'bench-suite-title', suite.title),
    buildStatChip('bench', suite.caseCount === 1 ? 'case' : 'cases', String(suite.caseCount)),
    buildStatChip('bench', suite.candidateCount === 1 ? 'candidate' : 'candidates', String(suite.candidateCount)),
    buildStatChip('bench', 'arms', String(suite.armIds.length)),
  );
  card.append(summary);
  const controls = el('div', 'bench-controls');
  const isConfigured = status?.configured === true && suite.error === null;
  controls.append(
    buildActionButton(suite, 'mine', !isConfigured || isPending || isThisSuiteRunning),
    buildActionButton(suite, 'run', !isConfigured || isPending || isThisSuiteRunning || isAnotherSuiteRunning || suite.caseCount === 0),
    buildActionButton(suite, 'cancel', isPending || !isThisSuiteRunning),
  );
  const statusText = el('span', 'bench-status', inFlightText(suite) || outcomeBySuite.get(suite.id) || '');
  statusText.setAttribute('role', 'status');
  controls.append(statusText);
  card.append(controls);
  if (suite.error) {
    card.append(el('p', 'bench-error', suite.error));
    return card;
  }
  const report = suite.latestReport;
  if (!report) {
    card.append(el('p', 'bench-empty', suite.caseCount === 0 ? 'Move approved candidates into the cases folder, then choose Run.' : 'No run yet.'));
    return card;
  }
  card.append(el('p', 'bench-run-line', `Latest run ${report.runId}: ${report.status}. Only cases every arm scored count toward paired recall.`));
  if (report.rows.length > 0) card.append(buildReportTable(report));
  return card;
}

function render(): void {
  if (!root) return;
  root.textContent = '';
  const section = buildPanelSection('bench', 'Benchmarks', 'Suites from the benchmarks folder of the Glimmervoid home, one run at a time.');
  root.append(section);
  if (!status) {
    root.append(el('p', 'bench-empty', 'Waiting for the server.'));
    return;
  }
  if (!status.configured) {
    root.append(el('p', 'bench-empty', status.reason || 'Benchmarks are off.'));
    return;
  }
  if (status.suites.length === 0) {
    root.append(el('p', 'bench-empty', 'No suites yet. Create a folder holding suite.json under benchmarks in the Glimmervoid home.'));
    return;
  }
  for (const suite of status.suites) root.append(buildSuite(suite));
}

export function setBenchmarkRequestSender(sender: BenchmarkRequestSender): void {
  requestSender = sender;
}

export function mountBenchmarkView(parent: HTMLElement): HTMLDivElement {
  if (root) return root;
  root = el('div', 'bench-content');
  parent.append(root);
  render();
  return root;
}

export function applyBenchmarkConnectionState(connected: boolean): void {
  if (connected || pendingActionBySuite.size === 0) return;
  for (const suiteId of pendingActionBySuite.keys()) outcomeBySuite.set(suiteId, 'Connection lost.');
  pendingActionBySuite.clear();
  render();
}

export function applyBenchmarkStatus(message: BenchmarkStatus): void {
  status = message;
  render();
}

export function applyBenchmarkActionResult(message: { suiteId: string; action: BenchmarkAction; ok: boolean; error?: string; runId?: string }): void {
  pendingActionBySuite.delete(message.suiteId);
  const candidateCount = status?.suites.find((suite) => suite.id === message.suiteId)?.candidateCount ?? 0;
  const doneText: Record<BenchmarkAction, string> = { mine: `Mining finished. ${candidateCount} candidate${candidateCount === 1 ? '' : 's'} awaiting approval in the candidates folder.`, run: `Run ${message.runId ?? ''} started.`, cancel: 'Run cancelled.' };
  outcomeBySuite.set(message.suiteId, message.ok ? doneText[message.action] : message.error || 'The server refused the action.');
  render();
}
