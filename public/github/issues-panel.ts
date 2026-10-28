import './issues-panel.css';
import { paintActionStatus } from '../action-status.ts';
import { githubPrByKey, subscribeGithubPrs } from './github-prs-store.ts';
import { STATES } from '#shared/states.ts';
import { el, externalLink, isPanelHidden, stateChip } from '../dom-helpers.ts';
import { paintStatusIcon } from '../status-icon.ts';
import { createGithubPollingControls } from './my-prs-panel.ts';
import { createPrQueueFoot, createPrQueueHead } from './pr-queue-columns.ts';
import { createPrScopeTabs } from './pr-scope-tabs.ts';
import { issuePullRequestState, filterIssues, groupIssuesByRepo, issueFilterOptions, issueFilterSummary, issueAgo, issueRelativeAge, issueScopeCounts, issuesPlaceholder } from './issues-view-core.ts';
import type { IssueFilters, IssueRow, IssueScope, IssueSort } from './issues-view-core.ts';
import { selectSession } from '../session-actions.ts';
import { sessionName, sessionUIs } from '../session-card/card-registry.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { isOpeningIssue, issueBodyText, issuesSnapshot, openIssueSession, openOutcomeOfIssue, reportIssuesAction, requestIssueBody, selectIssue, subscribeIssues } from './issues-store.ts';
import type { IssuesChange } from './issues-store.ts';

const scopes: { id: IssueScope; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'me', label: 'Mine' }, { id: 'team', label: 'Team' }, { id: 'project', label: 'Projects' },
];
const filters: IssueFilters = { scope: 'all', repo: '', label: '', sort: 'updated', query: '', hasSession: false, hasPr: false, isUnassignedOnly: false };
let root: HTMLDivElement | null = null;
let scopeTabs: ReturnType<typeof createPrScopeTabs<IssueScope>> | null = null;
let queue: HTMLElement | null = null;
let detailHost: HTMLElement | null = null;
let filterSummary: HTMLElement | null = null;
let repoSelect: HTMLSelectElement | null = null;
let labelSelect: HTMLSelectElement | null = null;
let syncStatus: HTMLElement | null = null;
let hasStaleSessionState = false;
let pollingControls: ReturnType<typeof createGithubPollingControls> | null = null;

function liveIssueSession(issue: IssueRow) {
  return issue.sessionId ? sessionUIs.get(issue.sessionId) : undefined;
}

function syncIssueState(glyph: HTMLElement, issue: IssueRow, hasLabel: boolean): void {
  const session = liveIssueSession(issue);
  const state = session?.currentState ?? STATES.DORMANT;
  const chip = stateChip(state, session?.awaitingBackgroundTasks);
  const title = session ? `Session: ${chip.label}` : 'No session yet';
  const text = hasLabel ? chip.label : '';
  if (glyph.dataset.state === state && glyph.title === title && glyph.dataset.icon === chip.icon && glyph.textContent === text) return;
  glyph.dataset.state = state;
  glyph.dataset.icon = chip.icon;
  glyph.title = title;
  glyph.setAttribute('aria-label', title);
  const icon = el('span', 'issues-state-icon');
  paintStatusIcon(icon, chip.icon);
  glyph.replaceChildren(icon);
  if (hasLabel) glyph.append(text);
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

function openIssueSessionUnlessLive(issue: IssueRow): void {
  if (liveIssueSession(issue)) return;
  openIssueSession(issue);
}

function buildIssueRow(issue: IssueRow): HTMLButtonElement {
  const row = el('button', 'pr-queue-row issue-row');
  row.type = 'button';
  row.dataset.issueKey = issue.key;
  row.setAttribute('aria-current', String(issue.key === issuesSnapshot().selectedKey));
  const top = el('span', 'pr-queue-top');
  top.append(el('span', 'pr-queue-ref', `#${issue.number}`), el('span', 'pr-queue-title', issue.title || 'Untitled issue'));
  const bottom = el('span', 'pr-queue-bottom');
  if (issue.sources.includes('me')) bottom.append(el('span', 'issues-why', 'you'));
  bottom.append(el('span', 'issues-row-labels', issue.labels.join(', ')));
  for (const pullRequest of issue.pullRequests) {
    const state = issuePullRequestState(pullRequest, githubPrByKey);
    const badge = el('span', 'issues-row-pr', `PR #${pullRequest.number} ${state}`);
    badge.dataset.prState = state;
    bottom.append(badge);
  }
  const age = el('span', 'pr-queue-elapsed', issueRelativeAge(issue.updatedAt, Date.now()));
  age.dataset.issueAge = issue.updatedAt;
  bottom.append(age);
  row.append(createIssueState(issue), top, bottom);
  row.addEventListener('click', () => {
    reportIssuesAction('select');
    selectIssue(issue.key);
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
    button.addEventListener('click', () => {
      reportIssuesAction('go-to-session');
      selectSession(sessionId);
    });
    footer.append(button);
  }
  if (issue.projectId && !session) {
    const button = el('button', 'pr-action', 'Open session');
    button.type = 'button';
    button.disabled = isOpeningIssue(issue);
    button.addEventListener('click', () => openIssueSessionUnlessLive(issue));
    footer.append(button);
  }
  footer.append(externalLink('pr-action pr-action-ghost', 'View on GitHub', issue.url));
  const outcome = openOutcomeOfIssue(issue);
  const fallback = issue.projectId ? '' : `Add a project for ${issue.repo} in Settings to open sessions from here.`;
  const status = el('span', 'pr-action-status issue-open-status');
  status.setAttribute('role', 'status');
  paintActionStatus(status, outcome?.tone ?? null, outcome?.text ?? fallback);
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
  const { selectedKey, issueByKey } = issuesSnapshot();
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
  const { latestStatus, selectedKey } = issuesSnapshot();
  const issue = latestStatus?.issues.find((candidate) => candidate.key === selectedKey);
  if (!issue) {
    detailHost.replaceChildren(el('p', 'pr-empty', 'Pick an issue from the queue.'));
    return;
  }
  const article = el('article', 'pr-detail issues-detail');
  const back = el('button', 'pr-action pr-action-ghost issues-back', 'Back to issues');
  back.type = 'button';
  back.addEventListener('click', () => {
    reportIssuesAction('back');
    if (root) root.dataset.detailOpen = 'false';
    [...queue?.querySelectorAll<HTMLButtonElement>('[data-issue-key]') ?? []].find((row) => row.dataset.issueKey === issuesSnapshot().selectedKey)?.focus({ preventScroll: true });
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
    const prState = issuePullRequestState(pullRequest, githubPrByKey);
    const state = el('span', 'issues-pr-state', prState);
    state.dataset.prState = prState;
    return [state, externalLink('issues-inline-link', `#${pullRequest.number} ${pullRequest.title}`, pullRequest.url)];
  });
  buildFact(facts, 'Pull request', pullRequests.length > 0 ? pullRequests : ['none linked']);
  const bodySection = el('section', 'issues-body-section');
  const body = el('div', 'issue-body', issueBodyText(issue));
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
  const { latestStatus, selectedKey } = issuesSnapshot();
  const issues = latestStatus?.issues ?? [];
  const counts = issueScopeCounts(issues);
  scopeTabs.select(filters.scope);
  for (const [scope, count] of scopeTabs.countElementByScope) count.textContent = String(counts[scope]);
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
    selectIssue(null);
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
  search.addEventListener('change', () => reportIssuesAction('search'));
  const toggle = el('button', 'pr-action pr-action-ghost', 'Filters');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'issues-filters-panel');
  const panel = el('div', 'issues-filters-panel');
  panel.id = 'issues-filters-panel';
  panel.hidden = true;
  toggle.addEventListener('click', () => {
    reportIssuesAction('filters-toggle');
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
  repoSelect.addEventListener('change', () => { reportIssuesAction('filter'); filters.repo = repoSelect?.value ?? ''; render(); });
  labelSelect = createSelect('Label');
  labelSelect.addEventListener('change', () => { reportIssuesAction('filter'); filters.label = labelSelect?.value ?? ''; render(); });
  const sortSelect = createSelect('Sort');
  for (const [value, label] of [['updated', 'Updated'], ['created', 'Newest'], ['comments', 'Most discussed']]) {
    const option = el('option', null, label);
    option.value = value ?? '';
    sortSelect.append(option);
  }
  sortSelect.addEventListener('change', () => { reportIssuesAction('filter'); filters.sort = sortSelect.value as IssueSort; render(); });
  const toggles = el('div', 'issues-filter-row');
  for (const [field, label] of [['hasSession', 'Has session'], ['hasPr', 'Has PR'], ['isUnassignedOnly', 'Unassigned']] as const) {
    const wrapper = el('label', 'issues-toggle');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => { reportIssuesAction('filter'); filters[field] = checkbox.checked; render(); });
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
  const lastSyncAt = issuesSnapshot().latestStatus?.lastSyncAt;
  if (syncStatus) syncStatus.textContent = lastSyncAt ? `Synced ${issueAgo(lastSyncAt, nowMs)}.` : 'Not synced yet.';
  for (const age of root.querySelectorAll<HTMLElement>('[data-issue-age]')) age.textContent = issueRelativeAge(age.dataset.issueAge ?? '', nowMs);
  for (const age of root.querySelectorAll<HTMLElement>('[data-issue-ago]')) age.textContent = issueAgo(age.dataset.issueAgo ?? '', nowMs);
}

function mountIssuesView(parent: HTMLElement): void {
  if (root) return;
  root = el('div', 'issues-content');
  root.dataset.detailOpen = 'false';
  parent.append(root);
  pollingControls = createGithubPollingControls('issues', root);
  const columns = el('div', 'pr-columns issues-columns');
  const pane = el('section', 'pr-queue-pane');
  pane.setAttribute('aria-label', 'Issue queue');
  scopeTabs = createPrScopeTabs({
    label: 'Issue scope',
    scopes,
    selected: filters.scope,
    onSelect: (scope) => { reportIssuesAction('scope'); filters.scope = scope; render(); },
    extraClassName: 'issues-scope-tabs',
    countClassPrefix: 'issues-scope',
  });
  queue = el('nav', 'pr-queue');
  queue.setAttribute('aria-label', 'Issues');
  const foot = createPrQueueFoot(pollingControls.control);
  syncStatus = el('span', 'issues-sync');
  syncStatus.setAttribute('role', 'status');
  foot.prepend(syncStatus);
  foot.append(pollingControls.notice);
  pane.append(createPrQueueHead(scopeTabs.element), createFilters(), queue, foot);
  detailHost = el('section', 'pr-detail-host');
  detailHost.setAttribute('aria-label', 'Issue detail');
  columns.append(pane, detailHost);
  root.append(columns);
  window.setInterval(updateAges, 30000);
  subscribeIssues(applyIssuesChange);
  subscribeGithubPrs(render);
  render();
}

function refreshIssuesViewOnShow(): void {
  if (hasStaleSessionState) refreshIssuesSessionState();
  updateAges();
}

function refreshIssuesSessionState(): void {
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
    const issue = issuesSnapshot().issueByKey.get(row.dataset.issueKey ?? '');
    const glyph = row.querySelector<HTMLElement>('.issues-state');
    if (issue && glyph) syncIssueState(glyph, issue, false);
  }
}

const RENDER_BY_CHANGE: Record<IssuesChange, () => void> = {
  status: render,
  detail: renderDetail,
  'session-state': refreshIssuesSessionState,
};

function applyIssuesChange(change: IssuesChange): void {
  RENDER_BY_CHANGE[change]();
}

export const view: ViewModule<HTMLElement> = { mount: mountIssuesView, refresh: refreshIssuesViewOnShow };
