import { buildPanelSection, buildStatChip, el, externalLink } from './dom-helpers.ts';
import type { IssuesReportPush } from '#shared/contracts/control-messages.ts';
import {
  type IssueFilter,
  type IssueRow,
  type LabelMatch,
  ISSUES_NO_MATCH_TEXT,
  ISSUES_SEARCH_PLACEHOLDER,
  LABEL_MATCH_TITLES,
  assigneeOptions,
  emptyIssueFilter,
  filterIssues,
  isIssueFilterActive,
  issuesPlaceholder,
  issuesShownText,
  labelFacets,
  summarizeIssues,
  toggleIssueLabel,
} from './issues-view-core.ts';
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

interface SearchFocus {
  start: number | null;
  end: number | null;
}

const ISSUES_REQUEST_TIMEOUT_MS = 45000;
const SEARCH_INPUT_CLASS = 'issues-search-input';
const LABEL_MATCH_ORDER: LabelMatch[] = ['any', 'all'];
const LABEL_MATCH_TEXT: Record<LabelMatch, string> = { any: 'Any', all: 'All' };

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
const filterByProjectId = new Map<string, IssueFilter>();

function nextRequestId(prefix: string): string {
  requestSeq += 1;
  return `${prefix}-${requestSeq}`;
}

function filterFor(projectId: string): IssueFilter {
  return filterByProjectId.get(projectId) ?? emptyIssueFilter();
}

function setFilter(projectId: string, filter: IssueFilter): void {
  filterByProjectId.set(projectId, filter);
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

function buildLabelToggle(className: string, text: string, color: string, pressed: boolean, onToggle: () => void): HTMLButtonElement {
  const chip = el('button', className, text);
  chip.type = 'button';
  chip.setAttribute('aria-pressed', String(pressed));
  if (color) chip.style.setProperty('--issue-label-color', `#${color}`);
  chip.addEventListener('click', onToggle);
  return chip;
}

function toggleLabelFilter(projectId: string, name: string): void {
  setFilter(projectId, toggleIssueLabel(filterFor(projectId), name));
  render();
}

function buildIssueRow(projectId: string, issue: IssueRow, filter: IssueFilter): HTMLDivElement {
  const row = el('div', 'issue-row');
  const number = el('span', 'issue-number', `#${issue.number}`);
  const title = externalLink('issue-title', issue.title || 'Untitled issue', issue.url);
  const age = el('span', 'issue-age', issueAge(issue.updatedAt));
  row.append(number, title, age);

  const labels = el('div', 'issue-labels');
  for (const issueLabel of issue.labels) {
    const isSelected = filter.labels.includes(issueLabel.name);
    labels.append(buildLabelToggle('issue-label-chip', issueLabel.name, issueLabel.color, isSelected, () => toggleLabelFilter(projectId, issueLabel.name)));
  }
  for (const login of issue.assignees ?? []) labels.append(el('span', 'issue-assignee', `@${login}`));
  if (labels.childElementCount > 0) row.append(labels);

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

function fillIssueRows(projectId: string, issues: IssueRow[], rows: HTMLElement, count: HTMLElement): void {
  const filter = filterFor(projectId);
  const shown = filterIssues(issues, filter);
  count.textContent = issuesShownText(shown.length, issues.length);
  rows.textContent = '';
  if (shown.length === 0) {
    rows.append(el('p', 'issues-empty', ISSUES_NO_MATCH_TEXT));
    return;
  }
  for (const issue of shown) rows.append(buildIssueRow(projectId, issue, filter));
}

function buildMatchToggle(projectId: string, filter: IssueFilter): HTMLDivElement {
  const group = el('div', 'issues-match-toggle');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Match selected labels');
  group.append(el('span', 'issues-filter-label', 'Labels'));
  for (const match of LABEL_MATCH_ORDER) {
    const option = el('button', 'issues-match-option', LABEL_MATCH_TEXT[match]);
    option.type = 'button';
    option.title = LABEL_MATCH_TITLES[match];
    option.setAttribute('aria-pressed', String(filter.labelMatch === match));
    option.addEventListener('click', () => {
      setFilter(projectId, { ...filterFor(projectId), labelMatch: match });
      render();
    });
    group.append(option);
  }
  return group;
}

function buildAssigneePicker(projectId: string, issues: IssueRow[], filter: IssueFilter): HTMLSelectElement {
  const picker = el('select', 'issues-assignee-picker');
  picker.setAttribute('aria-label', 'Filter by assignee');
  for (const choice of assigneeOptions(issues)) {
    const option = el('option', null, `${choice.label} (${choice.count})`);
    option.value = choice.value;
    option.selected = choice.value === filter.assignee;
    picker.append(option);
  }
  picker.addEventListener('change', () => {
    setFilter(projectId, { ...filterFor(projectId), assignee: picker.value });
    render();
  });
  return picker;
}

function buildFacets(projectId: string, issues: IssueRow[], filter: IssueFilter): HTMLDivElement {
  const facets = el('div', 'issues-facets');
  for (const facet of labelFacets(issues, filter.labels)) {
    const group = el('div', 'issues-facet');
    group.append(el('span', 'issues-facet-title', facet.title));
    const chips = el('div', 'issues-facet-labels');
    for (const label of facet.labels) {
      const isSelected = filter.labels.includes(label.name);
      const chip = buildLabelToggle('issues-filter-chip', '', label.color, isSelected, () => toggleLabelFilter(projectId, label.name));
      chip.title = label.name;
      chip.append(el('span', 'issues-filter-chip-name', label.shortName), el('span', 'issues-filter-chip-count', String(label.count)));
      chips.append(chip);
    }
    group.append(chips);
    facets.append(group);
  }
  return facets;
}

function buildFilters(projectId: string, issues: IssueRow[], rows: HTMLElement, count: HTMLElement): HTMLDivElement {
  const filter = filterFor(projectId);
  const panel = el('div', 'issues-filters');
  const bar = el('div', 'issues-filter-bar');
  const clear = el('button', 'issues-clear-filters', 'Clear');
  clear.type = 'button';
  clear.disabled = !isIssueFilterActive(filter);
  clear.addEventListener('click', () => {
    setFilter(projectId, emptyIssueFilter());
    render();
  });
  const search = el('input', SEARCH_INPUT_CLASS);
  search.type = 'search';
  search.placeholder = ISSUES_SEARCH_PLACEHOLDER;
  search.setAttribute('aria-label', 'Search issues');
  search.value = filter.text;
  search.addEventListener('input', () => {
    setFilter(projectId, { ...filterFor(projectId), text: search.value });
    fillIssueRows(projectId, issues, rows, count);
    clear.disabled = !isIssueFilterActive(filterFor(projectId));
  });
  count.setAttribute('role', 'status');
  bar.append(search, buildAssigneePicker(projectId, issues, filter), buildMatchToggle(projectId, filter), count, clear);
  panel.append(bar, buildFacets(projectId, issues, filter));
  return panel;
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
  const count = el('span', 'issues-filter-count');
  card.append(buildFilters(projectId, report.issues, rows, count), rows);
  fillIssueRows(projectId, report.issues, rows, count);
  return card;
}

function captureSearchFocus(): SearchFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !active.classList.contains(SEARCH_INPUT_CLASS) || !root?.contains(active)) return null;
  return { start: active.selectionStart, end: active.selectionEnd };
}

function restoreSearchFocus(focus: SearchFocus | null): void {
  if (!focus || !root) return;
  const search = root.querySelector<HTMLInputElement>(`.${SEARCH_INPUT_CLASS}`);
  if (!search) return;
  search.focus();
  if (focus.start !== null && focus.end !== null) search.setSelectionRange(focus.start, focus.end);
}

function render(): void {
  if (!root) return;
  const focus = captureSearchFocus();
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
  restoreSearchFocus(focus);
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

export function upsertIssuesProject(project: IssuesProject): void {
  if (projects.some((known) => known.id === project.id)) {
    applyIssuesProjects(projects.map((known) => (known.id === project.id ? project : known)));
    return;
  }
  applyIssuesProjects([...projects, project]);
}

export function removeIssuesProject(projectId: string): void {
  if (!projects.some((project) => project.id === projectId)) return;
  reportsByProjectId.delete(projectId);
  filterByProjectId.delete(projectId);
  applyIssuesProjects(projects.filter((project) => project.id !== projectId));
}

export function renameIssuesProject(projectId: string, name: string): void {
  if (!projects.some((project) => project.id === projectId)) return;
  upsertIssuesProject({ id: projectId, name });
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
