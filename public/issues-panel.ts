import { buildPanelSection, buildStatChip, el, externalLink } from './dom-helpers.ts';
import type { IssuesReportPush } from '#shared/contracts/control-messages.ts';
import { type IssueRow, issuesPlaceholder, summarizeIssues } from './issues-view-core.ts';
import { formatAgo } from './poll-ago.ts';

interface IssuesProject {
  id: string;
  name: string;
}

interface IssuesReport {
  issues: IssueRow[];
  error: string;
  ts: number;
}

type IssuesRequestSender = (message: Record<string, unknown>) => boolean;

interface PendingRefresh {
  projectId: string;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface PendingOpenRequest {
  projectId: string;
  issueNumber: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const ISSUES_REQUEST_TIMEOUT_MS = 45000;

let root: HTMLDivElement | null = null;
let projects: IssuesProject[] = [];
let selectedProjectId = '';
let requestSender: IssuesRequestSender | null = null;
let pendingRefresh: PendingRefresh | null = null;
let requestSeq = 0;
const reportsByProjectId = new Map<string, IssuesReport>();
const openRequestById = new Map<string, PendingOpenRequest>();
const openOutcomeByIssue = new Map<string, string>();
const refreshOutcomeByProjectId = new Map<string, string>();

function nextRequestId(prefix: string): string {
  requestSeq += 1;
  return `${prefix}-${requestSeq}`;
}

function clearPendingRefresh(): void {
  if (!pendingRefresh) return;
  clearTimeout(pendingRefresh.timeoutHandle);
  pendingRefresh = null;
}

function abandonRefresh(projectId: string): void {
  if (pendingRefresh?.projectId !== projectId) return;
  pendingRefresh = null;
  refreshOutcomeByProjectId.set(projectId, 'No reply from the server. Press Refresh to try again.');
  render();
}

function abandonOpenRequest(requestId: string): void {
  const request = openRequestById.get(requestId);
  if (!request) return;
  openRequestById.delete(requestId);
  openOutcomeByIssue.set(issueKey(request.projectId, request.issueNumber), 'No reply from the server.');
  render();
}

function resolveOpenRequest(requestId: string): PendingOpenRequest | null {
  const request = openRequestById.get(requestId);
  if (!request) return null;
  clearTimeout(request.timeoutHandle);
  openRequestById.delete(requestId);
  return request;
}

function issueKey(projectId: string, issueNumber: number): string {
  return `${projectId}:${issueNumber}`;
}

function issueAge(updatedAt: string): string {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return 'updated unknown';
  return `updated ${formatAgo(timestamp)}`;
}

function buildIssueRow(projectId: string, issue: IssueRow): HTMLDivElement {
  const row = el('div', 'issue-row');
  const number = el('span', 'issue-number', `#${issue.number}`);
  const title = externalLink('issue-title', issue.title || 'Untitled issue', issue.url);
  const age = el('span', 'issue-age', issueAge(issue.updatedAt));
  row.append(number, title, age);

  const labels = el('div', 'issue-labels');
  for (const issueLabel of issue.labels) {
    const chip = el('span', 'issue-label-chip', issueLabel.name);
    if (issueLabel.color) chip.style.setProperty('--issue-label-color', `#${issueLabel.color}`);
    labels.append(chip);
  }
  if (issue.labels.length > 0) row.append(labels);

  const action = el('div', 'issue-action');
  const button = el('button', 'issue-open-button', 'Open session');
  button.type = 'button';
  const key = issueKey(projectId, issue.number);
  const isPending = [...openRequestById.values()].some((request) => request.projectId === projectId && request.issueNumber === issue.number);
  button.disabled = isPending;
  button.addEventListener('click', () => {
    const id = nextRequestId('open-issue-session');
    if (!requestSender?.({ type: 'open-issue-session', requestId: id, projectId, issueNumber: issue.number })) {
      openOutcomeByIssue.set(key, 'Not connected.');
      render();
      return;
    }
    openRequestById.set(id, {
      projectId,
      issueNumber: issue.number,
      timeoutHandle: setTimeout(() => abandonOpenRequest(id), ISSUES_REQUEST_TIMEOUT_MS),
    });
    openOutcomeByIssue.set(key, 'Opening session.');
    render();
  });
  const status = el('span', 'issue-open-status', openOutcomeByIssue.get(key) || '');
  status.setAttribute('role', 'status');
  action.append(button, status);
  row.append(action);
  return row;
}

function buildReport(projectId: string, report: IssuesReport): HTMLElement {
  const card = el('div', 'issues-project');
  const summary = summarizeIssues(report.issues);
  const summaryRow = el('div', 'issues-summary');
  summaryRow.append(
    buildStatChip('issues', summary.open === 1 ? 'open issue' : 'open issues', String(summary.open)),
    buildStatChip('issues', 'labeled', String(summary.labeled)),
    el('span', 'issues-refreshed', `refreshed ${formatAgo(report.ts)}`),
  );
  card.append(summaryRow);
  if (report.error) {
    card.append(el('p', 'issues-error', report.error));
    return card;
  }
  if (report.issues.length === 0) {
    card.append(el('p', 'issues-empty', 'No open issues.'));
    return card;
  }
  const rows = el('div', 'issue-rows');
  for (const issue of report.issues) rows.append(buildIssueRow(projectId, issue));
  card.append(rows);
  return card;
}

function render(): void {
  if (!root) return;
  root.textContent = '';
  const section = buildPanelSection('issues', 'GitHub issues', 'Open issues ordered by last update on GitHub.');
  const controls = el('div', 'issues-controls');
  const picker = el('select', 'issues-project-picker');
  picker.setAttribute('aria-label', 'GitHub issues project');
  for (const project of projects) {
    const option = el('option', null, project.name);
    option.value = project.id;
    option.selected = project.id === selectedProjectId;
    picker.append(option);
  }
  picker.disabled = projects.length === 0;
  picker.addEventListener('change', () => {
    selectedProjectId = picker.value;
    render();
  });
  const refresh = el('button', 'issues-refresh-button', 'Refresh');
  refresh.type = 'button';
  refresh.disabled = !selectedProjectId || pendingRefresh?.projectId === selectedProjectId;
  refresh.addEventListener('click', () => {
    if (!selectedProjectId) return;
    const projectId = selectedProjectId;
    const id = nextRequestId('request-issues');
    clearPendingRefresh();
    if (!requestSender?.({ type: 'request-issues', requestId: id, projectId })) {
      reportsByProjectId.set(projectId, { issues: [], error: 'Not connected.', ts: Date.now() });
      render();
      return;
    }
    refreshOutcomeByProjectId.delete(projectId);
    pendingRefresh = { projectId, timeoutHandle: setTimeout(() => abandonRefresh(projectId), ISSUES_REQUEST_TIMEOUT_MS) };
    render();
  });
  const isRefreshPending = pendingRefresh?.projectId === selectedProjectId;
  const refreshStatus = el('span', 'issues-refresh-status', isRefreshPending ? 'Loading issues.' : refreshOutcomeByProjectId.get(selectedProjectId) || '');
  refreshStatus.setAttribute('role', 'status');
  controls.append(picker, refresh, refreshStatus);
  section.append(controls);
  root.append(section);

  if (projects.length === 0) {
    root.append(el('p', 'issues-placeholder', issuesPlaceholder({ hasProjects: false })));
    return;
  }
  const report = reportsByProjectId.get(selectedProjectId);
  if (!report) {
    root.append(el('p', 'issues-placeholder', issuesPlaceholder({ hasProjects: true })));
    return;
  }
  root.append(buildReport(selectedProjectId, report));
}

export function setIssuesRequestSender(sender: IssuesRequestSender): void {
  requestSender = sender;
}

export function mountIssuesView(parent: HTMLElement): HTMLDivElement {
  if (root) return root;
  root = el('div', 'issues-content');
  parent.append(root);
  render();
  return root;
}

export function applyIssuesConnectionState(connected: boolean): void {
  if (connected) return;
  for (const request of openRequestById.values()) {
    clearTimeout(request.timeoutHandle);
    openOutcomeByIssue.set(issueKey(request.projectId, request.issueNumber), 'Connection lost.');
  }
  openRequestById.clear();
  if (pendingRefresh) refreshOutcomeByProjectId.set(pendingRefresh.projectId, 'Connection lost.');
  clearPendingRefresh();
  render();
}

export function applyIssuesProjects(nextProjects: IssuesProject[]): void {
  projects = nextProjects;
  if (!projects.some((project) => project.id === selectedProjectId)) selectedProjectId = projects[0]?.id || '';
  render();
}

export function applyIssuesReport(message: IssuesReportPush): void {
  reportsByProjectId.set(message.projectId, { issues: message.issues, error: message.error || '', ts: message.ts });
  refreshOutcomeByProjectId.delete(message.projectId);
  if (pendingRefresh?.projectId === message.projectId) clearPendingRefresh();
  render();
}

export function applyOpenIssueSessionResult(message: Record<string, unknown>): void {
  if (typeof message.requestId !== 'string') return;
  const request = resolveOpenRequest(message.requestId);
  if (!request) return;
  const key = issueKey(request.projectId, request.issueNumber);
  if (message.ok === true) {
    const name = typeof message.sessionName === 'string' ? message.sessionName : `issue #${request.issueNumber}`;
    const suffix = message.pending === true ? ' Prompt queued.' : '';
    openOutcomeByIssue.set(key, `Session "${name}" created.${suffix}`);
    render();
    return;
  }
  const error = typeof message.error === 'string' && message.error ? message.error : 'Could not open session.';
  openOutcomeByIssue.set(key, error);
  render();
}
