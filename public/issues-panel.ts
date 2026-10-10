import { nextRequestId } from './control-ws.ts';
import { buildPanelSection, buildStatChip, el, externalLink } from './dom-helpers.ts';
import type { IssuesStatus } from '#shared/contracts/issues.ts';
import { createReviewsPollingControls } from './my-prs-panel.ts';
import { createPrQueueFoot } from './pr-queue-columns.ts';
import { type IssueRow, issuesPlaceholder, summarizeIssues } from './issues-view-core.ts';
import { formatAgo } from './poll-ago.ts';
import { selectSession } from './session-actions.ts';

type IssuesRequestSender = (message: Record<string, unknown>) => boolean;

interface PendingOpenRequest {
  issueKey: string;
  issueNumber: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const ISSUES_REQUEST_TIMEOUT_MS = 45000;

let root: HTMLDivElement | null = null;
let latestStatus: IssuesStatus | null = null;
let pollingControls: ReturnType<typeof createReviewsPollingControls> | null = null;
let requestSender: IssuesRequestSender | null = null;
const openRequestById = new Map<string, PendingOpenRequest>();
const openOutcomeByIssue = new Map<string, string>();

function abandonOpenRequest(requestId: string): void {
  const request = openRequestById.get(requestId);
  if (!request) return;
  openRequestById.delete(requestId);
  openOutcomeByIssue.set(request.issueKey, 'No reply from the server.');
  render();
}

function resolveOpenRequest(requestId: string): PendingOpenRequest | null {
  const request = openRequestById.get(requestId);
  if (!request) return null;
  clearTimeout(request.timeoutHandle);
  openRequestById.delete(requestId);
  return request;
}

function issueAge(updatedAt: string): string {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return 'updated unknown';
  return `updated ${formatAgo(timestamp)}`;
}

function buildIssueRow(issue: IssueRow): HTMLDivElement {
  const row = el('div', 'issue-row');
  const number = el('span', 'issue-number', `#${issue.number}`);
  const title = externalLink('issue-title', issue.title || 'Untitled issue', issue.url);
  const age = el('span', 'issue-age', issueAge(issue.updatedAt));
  row.append(number, title, age);

  const labels = el('div', 'issue-labels');
  for (const issueLabel of issue.labels) {
    const chip = el('span', 'issue-label-chip', issueLabel);
    labels.append(chip);
  }

  const pullRequest = issue.pullRequests[0];
  if (pullRequest) labels.append(externalLink('issue-age', `PR #${pullRequest.number} ${pullRequest.state}`, pullRequest.url));
  if (labels.childElementCount > 0) row.append(labels);

  const sessionId = issue.sessionId;
  const action = el('div', 'issue-action');
  if (sessionId) {
    const sessionButton = el('button', 'issue-open-button', 'Go to session');
    sessionButton.type = 'button';
    sessionButton.addEventListener('click', () => selectSession(sessionId));
    action.append(sessionButton);
  }

  const projectId = issue.projectId;
  if (!projectId) {
    if (sessionId) row.append(action);
    return row;
  }
  const button = el('button', 'issue-open-button', 'Open session');
  button.type = 'button';
  const key = issue.key;
  const isPending = [...openRequestById.values()].some((request) => request.issueKey === key);
  button.disabled = isPending || sessionId !== null;
  button.addEventListener('click', () => {
    const id = nextRequestId('open-issue-session');
    if (!requestSender?.({ type: 'open-issue-session', requestId: id, projectId, repo: issue.repo, issueNumber: issue.number })) {
      openOutcomeByIssue.set(key, 'Not connected.');
      render();
      return;
    }
    openRequestById.set(id, {
      issueKey: key,
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

function buildReport(repo: string, issues: IssueRow[]): HTMLElement {
  const card = el('div', 'issues-project');
  const summary = summarizeIssues(issues);
  const summaryRow = el('div', 'issues-summary');
  summaryRow.append(
    el('span', 'issues-repo', repo),
    buildStatChip('issues', summary.open === 1 ? 'open issue' : 'open issues', String(summary.open)),
    buildStatChip('issues', 'labeled', String(summary.labeled)),
  );
  card.append(summaryRow);
  const rows = el('div', 'issue-rows');
  for (const issue of issues) rows.append(buildIssueRow(issue));
  card.append(rows);
  return card;
}

function render(): void {
  if (!root) return;
  root.textContent = '';
  root.append(buildPanelSection('issues', 'GitHub issues', 'Open issues from your projects, assignments and GitHub teams.'));
  if (pollingControls) root.append(pollingControls.notice);
  if (!latestStatus?.configured || latestStatus.issues.length === 0) {
    root.append(el('p', 'issues-placeholder', issuesPlaceholder(latestStatus)));
  }
  const issuesByRepo = new Map<string, IssueRow[]>();
  for (const issue of latestStatus?.issues ?? []) {
    const issues = issuesByRepo.get(issue.repo) ?? [];
    issues.push(issue);
    issuesByRepo.set(issue.repo, issues);
  }
  for (const [repo, issues] of issuesByRepo) root.append(buildReport(repo, issues));
  const foot = createPrQueueFoot(pollingControls?.control ?? null);
  if (latestStatus?.lastSyncAt) foot.prepend(el('span', 'issues-refreshed', `refreshed ${formatAgo(latestStatus.lastSyncAt)}`));
  root.append(foot);
  pollingControls?.update(latestStatus);
}

export function setIssuesRequestSender(sender: IssuesRequestSender): void {
  requestSender = sender;
}

export function mountIssuesView(parent: HTMLElement): HTMLDivElement {
  if (root) return root;
  root = el('div', 'issues-content');
  parent.append(root);
  pollingControls = createReviewsPollingControls('issues', root);
  render();
  return root;
}

export function applyIssuesConnectionState(connected: boolean): void {
  if (connected) return;
  for (const request of openRequestById.values()) {
    clearTimeout(request.timeoutHandle);
    openOutcomeByIssue.set(request.issueKey, 'Connection lost.');
  }
  openRequestById.clear();
  render();
}

export function applyIssuesStatus(message: IssuesStatus): void {
  latestStatus = message;
  render();
}

export function applyOpenIssueSessionResult(message: Record<string, unknown>): void {
  if (typeof message.requestId !== 'string') return;
  const request = resolveOpenRequest(message.requestId);
  if (!request) return;
  const key = request.issueKey;
  if (message.ok === true) {
    const name = typeof message.sessionName === 'string' ? message.sessionName : `issue #${request.issueNumber}`;
    const suffix = message.pending === true ? ' Prompt queued.' : '';
    const outcome = message.existing === true ? 'already open' : 'created';
    openOutcomeByIssue.set(key, `Session "${name}" ${outcome}.${suffix}`);
    render();
    return;
  }
  const error = typeof message.error === 'string' && message.error ? message.error : 'Could not open session.';
  openOutcomeByIssue.set(key, error);
  render();
}
