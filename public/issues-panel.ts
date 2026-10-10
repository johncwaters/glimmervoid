import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { IssuesStatus } from '#shared/contracts/issues.ts';
import { STATES } from '#shared/states.ts';
import { nextRequestId } from './control-ws.ts';
import { el, externalLink, isPanelHidden, stateChip } from './dom-helpers.ts';
import { createReviewsPollingControls } from './my-prs-panel.ts';
import { createPrQueueFoot, createPrQueueHead } from './pr-queue-columns.ts';
import { filterIssues, groupIssuesByRepo, issueFilterOptions, issueFilterSummary, issueAgo, issueRelativeAge, issueScopeCounts, issuesPlaceholder } from './issues-view-core.ts';
import type { IssueFilters, IssueRow, IssueScope, IssueSort } from './issues-view-core.ts';
import { selectSession } from './session-actions.ts';
import { sessionName, sessionUIs } from './session-card/card-registry.ts';

type IssuesRequestSender = (message: Record<string, unknown>) => boolean;

interface PendingOpenRequest {
  issueKey: string;
  issueNumber: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface PendingDetailRequest {
  cacheKey: string;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const ISSUES_REQUEST_TIMEOUT_MS = 45000;
const scopes: { id: IssueScope; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'me', label: 'Mine' }, { id: 'team', label: 'Team' }, { id: 'project', label: 'Projects' },
];
const filters: IssueFilters = { scope: 'all', repo: '', label: '', sort: 'updated', query: '', hasSession: false, hasPr: false, isUnassignedOnly: false };
let root: HTMLDivElement | null = null;
let scopeTabs: HTMLElement | null = null;
let queue: HTMLElement | null = null;
let detailHost: HTMLElement | null = null;
let filterSummary: HTMLElement | null = null;
let repoSelect: HTMLSelectElement | null = null;
let labelSelect: HTMLSelectElement | null = null;
let syncStatus: HTMLElement | null = null;
let selectedKey: string | null = null;
let latestStatus: IssuesStatus | null = null;
let issueByKey = new Map<string, IssueRow>();
let hasStaleSessionState = false;
let pollingControls: ReturnType<typeof createReviewsPollingControls> | null = null;
let requestSender: IssuesRequestSender | null = null;
const openRequestById = new Map<string, PendingOpenRequest>();
const openOutcomeByIssue = new Map<string, string>();
const detailRequestById = new Map<string, PendingDetailRequest>();
const bodyByCacheKey = new Map<string, string>();
const bodyErrorByCacheKey = new Map<string, string>();

function issueBodyCacheKey(issue: IssueRow): string {
  return `${issue.key}:${issue.updatedAt}`;
}

function liveIssueSession(issue: IssueRow) {
  return issue.sessionId ? sessionUIs.get(issue.sessionId) : undefined;
}

function syncIssueState(glyph: HTMLElement, issue: IssueRow, hasLabel: boolean): void {
  const session = liveIssueSession(issue);
  const state = session?.currentState ?? STATES.DORMANT;
  const chip = stateChip(state, session?.awaitingBackgroundTasks);
  const title = session ? `Session: ${chip.label}` : 'No session yet';
  const text = hasLabel ? `${chip.glyph} ${chip.label}` : chip.glyph;
  if (glyph.dataset.state === state && glyph.title === title && glyph.textContent === text) return;
  glyph.dataset.state = state;
  glyph.title = title;
  glyph.setAttribute('aria-label', title);
  glyph.textContent = text;
}

function createIssueState(issue: IssueRow, hasLabel = false): HTMLElement {
  const glyph = el('span', hasLabel ? 'issues-state' : 'pr-queue-glyph issues-state');
  syncIssueState(glyph, issue, hasLabel);
  return glyph;
}

function issueSessionLabel(issue: IssueRow): string {
  const session = liveIssueSession(issue);
  return session ? sessionName(session) : 'none yet';
}

function isOpeningIssue(issue: IssueRow): boolean {
  return [...openRequestById.values()].some((request) => request.issueKey === issue.key);
}

function abandonOpenRequest(requestId: string): void {
  const request = openRequestById.get(requestId);
  if (!request) return;
  openRequestById.delete(requestId);
  openOutcomeByIssue.set(request.issueKey, 'No reply from the server.');
  renderDetail();
}

function resolveOpenRequest(requestId: string): PendingOpenRequest | null {
  const request = openRequestById.get(requestId);
  if (!request) return null;
  clearTimeout(request.timeoutHandle);
  openRequestById.delete(requestId);
  return request;
}

function requestIssueBody(issue: IssueRow): void {
  const cacheKey = issueBodyCacheKey(issue);
  if (bodyByCacheKey.has(cacheKey) || [...detailRequestById.values()].some((request) => request.cacheKey === cacheKey)) return;
  const requestId = nextRequestId('issue-detail');
  bodyErrorByCacheKey.delete(cacheKey);
  if (!requestSender?.({ type: 'issue-detail', requestId, repo: issue.repo, issueNumber: issue.number })) {
    bodyErrorByCacheKey.set(cacheKey, 'Not connected. Select the issue to load its description.');
    return;
  }
  detailRequestById.set(requestId, {
    cacheKey,
    timeoutHandle: setTimeout(() => {
      detailRequestById.delete(requestId);
      bodyErrorByCacheKey.set(cacheKey, 'No reply from the server. Select the issue to load its description.');
      renderDetail();
    }, ISSUES_REQUEST_TIMEOUT_MS),
  });
}

function openIssueSession(issue: IssueRow): void {
  const projectId = issue.projectId;
  if (!projectId || liveIssueSession(issue) || isOpeningIssue(issue)) return;
  const requestId = nextRequestId('open-issue-session');
  if (!requestSender?.({ type: 'open-issue-session', requestId, projectId, repo: issue.repo, issueNumber: issue.number })) {
    openOutcomeByIssue.set(issue.key, 'Not connected.');
    renderDetail();
    return;
  }
  openRequestById.set(requestId, {
    issueKey: issue.key,
    issueNumber: issue.number,
    timeoutHandle: setTimeout(() => abandonOpenRequest(requestId), ISSUES_REQUEST_TIMEOUT_MS),
  });
  openOutcomeByIssue.set(issue.key, 'Opening session.');
  renderDetail();
}

function buildIssueRow(issue: IssueRow): HTMLButtonElement {
  const row = el('button', 'pr-queue-row issue-row');
  row.type = 'button';
  row.dataset.issueKey = issue.key;
  row.setAttribute('aria-current', String(issue.key === selectedKey));
  const top = el('span', 'pr-queue-top');
  top.append(el('span', 'pr-queue-ref', `#${issue.number}`), el('span', 'pr-queue-title', issue.title || 'Untitled issue'));
  const bottom = el('span', 'pr-queue-bottom');
  if (issue.sources.includes('me')) bottom.append(el('span', 'issues-why', 'you'));
  bottom.append(el('span', 'issues-row-labels', issue.labels.join(', ')));
  for (const pullRequest of issue.pullRequests) bottom.append(el('span', 'issues-row-pr', `PR #${pullRequest.number}`));
  const age = el('span', 'pr-queue-elapsed', issueRelativeAge(issue.updatedAt, Date.now()));
  age.dataset.issueAge = issue.updatedAt;
  bottom.append(age);
  row.append(createIssueState(issue), top, bottom);
  row.addEventListener('click', () => {
    selectedKey = issue.key;
    if (root) root.dataset.detailOpen = 'true';
    requestIssueBody(issue);
    render();
    if (detailHost) detailHost.scrollTop = 0;
  });
  return row;
}

function buildFact(list: HTMLElement, name: string, contents: (HTMLElement | string)[]): void {
  const value = el('dd');
  value.append(...contents);
  list.append(el('dt', null, name), value);
}

function buildDetailFooter(issue: IssueRow): HTMLElement {
  const footer = el('footer', 'pr-footer issues-detail-footer');
  const session = liveIssueSession(issue);
  if (session && issue.sessionId) {
    const sessionId = issue.sessionId;
    const button = el('button', 'pr-action', 'Go to session');
    button.type = 'button';
    button.addEventListener('click', () => selectSession(sessionId));
    footer.append(button);
  }
  if (issue.projectId && !session) {
    const button = el('button', 'pr-action', 'Open session');
    button.type = 'button';
    button.disabled = isOpeningIssue(issue);
    button.addEventListener('click', () => openIssueSession(issue));
    footer.append(button);
  }
  footer.append(externalLink('pr-action', 'View on GitHub', issue.url));
  const outcome = openOutcomeByIssue.get(issue.key);
  const fallback = issue.projectId ? '' : `Add a project for ${issue.repo} in Settings to open sessions from here.`;
  const status = el('span', 'pr-action-status issue-open-status', outcome ?? fallback);
  status.setAttribute('role', 'status');
  if (isOpeningIssue(issue)) status.prepend(el('span', 'issues-spinner'));
  footer.append(status);
  return footer;
}

function createDetailAge(timestamp: string, nowMs: number): HTMLElement {
  const age = el('span', null, issueAgo(timestamp, nowMs));
  age.dataset.issueAgo = timestamp;
  return age;
}

function refreshDetailSessionState(): void {
  const article = detailHost?.querySelector<HTMLElement>('.issues-detail');
  const issue = selectedKey ? issueByKey.get(selectedKey) : undefined;
  if (!article || !issue) return;
  const glyph = article.querySelector<HTMLElement>('.issues-facts .issues-state');
  if (glyph) syncIssueState(glyph, issue, true);
  const name = article.querySelector('.issues-session-name');
  const label = issueSessionLabel(issue);
  if (name && name.textContent !== label) name.textContent = label;
  const hasLiveSession = String(Boolean(liveIssueSession(issue)));
  if (article.dataset.hasLiveSession === hasLiveSession) return;
  article.dataset.hasLiveSession = hasLiveSession;
  article.querySelector('.issues-detail-footer')?.replaceWith(buildDetailFooter(issue));
}

function renderDetail(): void {
  if (!detailHost) return;
  const issue = latestStatus?.issues.find((candidate) => candidate.key === selectedKey);
  if (!issue) {
    detailHost.replaceChildren(el('p', 'pr-empty', 'Pick an issue from the queue.'));
    return;
  }
  const article = el('article', 'pr-detail issues-detail');
  const back = el('button', 'pr-action issues-back', 'Back to issues');
  back.type = 'button';
  back.addEventListener('click', () => {
    if (root) root.dataset.detailOpen = 'false';
    [...queue?.querySelectorAll<HTMLButtonElement>('[data-issue-key]') ?? []].find((row) => row.dataset.issueKey === selectedKey)?.focus({ preventScroll: true });
  });
  const heading = el('header', 'pr-detail-heading');
  const title = el('div', 'pr-detail-title');
  title.append(externalLink('pr-link', `${issue.repo}#${issue.number}`, issue.url), el('h2', null, issue.title || 'Untitled issue'));
  const nowMs = Date.now();
  const meta = el('div', 'pr-detail-meta');
  const opened = el('span', null, `opened by ${issue.author || 'unknown'} `);
  const updated = el('span', null, 'updated ');
  opened.append(createDetailAge(issue.createdAt, nowMs));
  updated.append(createDetailAge(issue.updatedAt, nowMs));
  meta.append(opened, updated, el('span', null, `${issue.comments} comments`));
  if (issue.sources.includes('me')) meta.append(el('span', 'issues-why', 'assigned to you'));
  for (const team of issue.teams) meta.append(el('span', null, `mentions ${team}`));
  heading.append(title, meta);
  const facts = el('dl', 'issues-facts');
  buildFact(facts, 'Repository', [issue.repo]);
  buildFact(facts, 'Labels', [issue.labels.join(', ') || 'none']);
  buildFact(facts, 'Assignees', [issue.assignees.join(', ') || 'unassigned']);
  article.dataset.hasLiveSession = String(Boolean(liveIssueSession(issue)));
  buildFact(facts, 'Session', [createIssueState(issue, true), el('span', 'issues-session-name', issueSessionLabel(issue))]);
  const pullRequests = issue.pullRequests.flatMap((pullRequest) => {
    const state = el('span', 'issues-pr-state', pullRequest.state);
    state.dataset.prState = pullRequest.state;
    return [state, externalLink('issues-inline-link', `#${pullRequest.number} ${pullRequest.title}`, pullRequest.url)];
  });
  buildFact(facts, 'Pull request', pullRequests.length > 0 ? pullRequests : ['none linked']);
  const bodySection = el('section', 'issues-body-section');
  const cacheKey = issueBodyCacheKey(issue);
  const body = el('div', 'issue-body', bodyByCacheKey.get(cacheKey) ?? bodyErrorByCacheKey.get(cacheKey) ?? 'Loading description.');
  if (bodyByCacheKey.get(cacheKey) === '') body.textContent = 'No description.';
  body.setAttribute('role', 'status');
  bodySection.append(el('h3', 'pr-section-heading', 'Description'), body);
  article.append(back, heading, facts, bodySection, buildDetailFooter(issue));
  detailHost.replaceChildren(article);
}

function updateSelectOptions(select: HTMLSelectElement | null, placeholder: string, options: string[], selected: string): void {
  if (!select) return;
  const values = selected && !options.includes(selected) ? [...options, selected].sort() : options;
  select.replaceChildren(...['', ...values].map((value) => {
    const option = el('option', null, value || placeholder);
    option.value = value;
    return option;
  }));
  select.value = selected;
}

function render(): void {
  hasStaleSessionState = false;
  renderQueue();
  renderDetail();
}

function renderQueue(): void {
  if (!root || !queue || !scopeTabs) return;
  const issues = latestStatus?.issues ?? [];
  const counts = issueScopeCounts(issues);
  for (const scope of scopes) {
    scopeTabs.querySelector(`[data-scope="${scope.id}"]`)?.setAttribute('aria-selected', String(scope.id === filters.scope));
    const count = scopeTabs.querySelector(`[data-scope-count="${scope.id}"]`);
    if (count) count.textContent = String(counts[scope.id]);
  }
  const options = issueFilterOptions(issues);
  updateSelectOptions(repoSelect, 'All repos', options.repos, filters.repo);
  updateSelectOptions(labelSelect, 'All labels', options.labels, filters.label);
  if (filterSummary) filterSummary.textContent = issueFilterSummary(filters);
  const visible = filterIssues(issues, filters, new Set(sessionUIs.keys()));
  const focusedKey = document.activeElement instanceof HTMLElement && queue.contains(document.activeElement) ? document.activeElement.dataset.issueKey : null;
  const sections = [...groupIssuesByRepo(visible)].map(([repo, repoIssues]) => {
    const section = el('section', 'pr-queue-section');
    const heading = el('h3', 'pr-section-heading issues-repo-heading', repo);
    if (!repoIssues.some((issue) => issue.projectId)) heading.append(el('span', 'issues-repo-note', 'view only'));
    heading.append(el('span', 'issues-repo-count', String(repoIssues.length)));
    section.append(heading, ...repoIssues.map(buildIssueRow));
    return section;
  });
  queue.replaceChildren(...sections);
  if (visible.length === 0) queue.append(el('p', 'pr-empty', issues.length > 0 ? 'No open issues match these filters. Clear the search or pick All.' : issuesPlaceholder(latestStatus)));
  if (focusedKey) [...queue.querySelectorAll<HTMLButtonElement>('[data-issue-key]')].find((row) => row.dataset.issueKey === focusedKey)?.focus({ preventScroll: true });
  if (selectedKey && !issues.some((issue) => issue.key === selectedKey)) {
    selectedKey = null;
    root.dataset.detailOpen = 'false';
  }
  pollingControls?.update(latestStatus);
  updateAges();
}

function createFilters(): HTMLElement {
  const container = el('div', 'issues-filters');
  const searchRow = el('div', 'issues-search-row');
  const search = el('input', 'issues-search');
  search.type = 'search';
  search.placeholder = 'Search issues';
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search issues');
  search.addEventListener('input', () => { filters.query = search.value; render(); });
  const toggle = el('button', 'pr-action', 'Filters');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'issues-filters-panel');
  const panel = el('div', 'issues-filters-panel');
  panel.id = 'issues-filters-panel';
  panel.hidden = true;
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
  searchRow.append(search, toggle);
  const selectRow = el('div', 'issues-filter-row');
  function createSelect(label: string): HTMLSelectElement {
    const select = el('select', 'issues-field');
    select.setAttribute('aria-label', label);
    selectRow.append(select);
    return select;
  }
  repoSelect = createSelect('Repository');
  repoSelect.addEventListener('change', () => { filters.repo = repoSelect?.value ?? ''; render(); });
  labelSelect = createSelect('Label');
  labelSelect.addEventListener('change', () => { filters.label = labelSelect?.value ?? ''; render(); });
  const sortSelect = createSelect('Sort');
  for (const [value, label] of [['updated', 'Updated'], ['created', 'Newest'], ['comments', 'Most discussed']]) {
    const option = el('option', null, label);
    option.value = value ?? '';
    sortSelect.append(option);
  }
  sortSelect.addEventListener('change', () => { filters.sort = sortSelect.value as IssueSort; render(); });
  const toggles = el('div', 'issues-filter-row');
  for (const [field, label] of [['hasSession', 'Has session'], ['hasPr', 'Has PR'], ['isUnassignedOnly', 'Unassigned']] as const) {
    const wrapper = el('label', 'issues-toggle');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => { filters[field] = checkbox.checked; render(); });
    wrapper.append(checkbox, ` ${label}`);
    toggles.append(wrapper);
  }
  filterSummary = el('span', 'issues-filter-summary');
  filterSummary.setAttribute('role', 'status');
  panel.append(selectRow, toggles);
  container.append(searchRow, filterSummary, panel);
  return container;
}

function updateAges(): void {
  if (!root || root.closest('[hidden]') || document.hidden) return;
  const nowMs = Date.now();
  if (syncStatus) syncStatus.textContent = latestStatus?.lastSyncAt ? `Synced ${issueAgo(latestStatus.lastSyncAt, nowMs)}.` : 'Not synced yet.';
  for (const age of root.querySelectorAll<HTMLElement>('[data-issue-age]')) age.textContent = issueRelativeAge(age.dataset.issueAge ?? '', nowMs);
  for (const age of root.querySelectorAll<HTMLElement>('[data-issue-ago]')) age.textContent = issueAgo(age.dataset.issueAgo ?? '', nowMs);
}

export function setIssuesRequestSender(sender: IssuesRequestSender): void {
  requestSender = sender;
}

export function mountIssuesView(parent: HTMLElement): HTMLDivElement {
  if (root) return root;
  root = el('div', 'issues-content');
  root.dataset.detailOpen = 'false';
  parent.append(root);
  pollingControls = createReviewsPollingControls('issues', root);
  const columns = el('div', 'pr-columns issues-columns');
  const pane = el('section', 'pr-queue-pane');
  pane.setAttribute('aria-label', 'Issue queue');
  scopeTabs = el('div', 'pr-scope-tabs issues-scope-tabs');
  scopeTabs.setAttribute('role', 'tablist');
  scopeTabs.setAttribute('aria-label', 'Issue scope');
  for (const scope of scopes) {
    const wrapper = el('span', 'issues-scope');
    wrapper.setAttribute('role', 'presentation');
    const tab = el('button', 'pr-scope-tab', scope.label);
    tab.type = 'button';
    tab.dataset.scope = scope.id;
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', () => { filters.scope = scope.id; render(); });
    const count = el('span', 'issues-scope-count');
    count.dataset.scopeCount = scope.id;
    wrapper.append(tab, count);
    scopeTabs.append(wrapper);
  }
  queue = el('nav', 'pr-queue');
  queue.setAttribute('aria-label', 'Issues');
  const foot = createPrQueueFoot(pollingControls.control);
  syncStatus = el('span', 'issues-sync');
  syncStatus.setAttribute('role', 'status');
  foot.prepend(syncStatus);
  foot.append(pollingControls.notice);
  pane.append(createPrQueueHead(scopeTabs), createFilters(), queue, foot);
  detailHost = el('section', 'pr-detail-host');
  detailHost.setAttribute('aria-label', 'Issue detail');
  columns.append(pane, detailHost);
  root.append(columns);
  window.setInterval(updateAges, 30000);
  render();
  return root;
}

export function refreshIssuesViewOnShow(): void {
  if (hasStaleSessionState) refreshIssuesSessionState();
  updateAges();
}

export function refreshIssuesSessionState(): void {
  if (isPanelHidden(root)) {
    hasStaleSessionState = true;
    return;
  }
  hasStaleSessionState = false;
  refreshDetailSessionState();
  if (filters.hasSession) {
    renderQueue();
    return;
  }
  for (const row of queue?.querySelectorAll<HTMLElement>('[data-issue-key]') ?? []) {
    const issue = issueByKey.get(row.dataset.issueKey ?? '');
    const glyph = row.querySelector<HTMLElement>('.issues-state');
    if (issue && glyph) syncIssueState(glyph, issue, false);
  }
}

export function applyIssuesConnectionState(connected: boolean): void {
  if (connected) return;
  for (const request of openRequestById.values()) {
    clearTimeout(request.timeoutHandle);
    openOutcomeByIssue.set(request.issueKey, 'Connection lost.');
  }
  openRequestById.clear();
  for (const request of detailRequestById.values()) {
    clearTimeout(request.timeoutHandle);
    bodyErrorByCacheKey.set(request.cacheKey, 'Connection lost. Select the issue to load its description.');
  }
  detailRequestById.clear();
  render();
}

export function applyIssuesStatus(message: IssuesStatus): void {
  const previousSelected = latestStatus?.issues.find((issue) => issue.key === selectedKey);
  latestStatus = message;
  issueByKey = new Map(message.issues.map((issue) => [issue.key, issue]));
  const selected = message.issues.find((issue) => issue.key === selectedKey);
  if (selected && selected.updatedAt !== previousSelected?.updatedAt) requestIssueBody(selected);
  render();
}

export function applyIssueDetailResult(message: ServerMessageOf<'issue-detail-result'>): void {
  const request = detailRequestById.get(message.requestId);
  if (!request) return;
  clearTimeout(request.timeoutHandle);
  detailRequestById.delete(message.requestId);
  if (message.ok && message.body !== null) bodyByCacheKey.set(request.cacheKey, message.body);
  if (!message.ok || message.body === null) bodyErrorByCacheKey.set(request.cacheKey, message.error || 'Could not load description. Select the issue to try again.');
  renderDetail();
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
    const issue = latestStatus?.issues.find((candidate) => candidate.key === key);
    if (issue && typeof message.sessionId === 'string') issue.sessionId = message.sessionId;
    render();
    return;
  }
  const error = typeof message.error === 'string' && message.error ? message.error : 'Could not open session.';
  openOutcomeByIssue.set(key, error);
  renderDetail();
}
