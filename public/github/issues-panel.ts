import './issues-panel.css';
import { paintActionStatus } from '../action-status.ts';
import { githubPrByKey, subscribeGithubPrs } from './github-prs-store.ts';
import { STATES } from '#shared/states.ts';
import { createAuthorOrgTag, el, externalLink, isPanelHidden, isRealInputOwningKey, stateChip } from '../dom-helpers.ts';
import { paintStatusIcon } from '../status-icon.ts';
import { createGithubPollingControls } from './my-prs-panel.ts';
import { createPrQueueFoot } from './pr-queue-columns.ts';
import { createPrScopeTabs } from './pr-scope-tabs.ts';
import { ISSUE_STEPS, isIssueQueryActive, issueAgo, issuePullRequestState, issueRelativeAge, issueStepCounts, issueStepOf, issueTierOf, issueWaitStartMs, issuesPlaceholder, matchesIssueQuery, parseIssueQuery, tierIssues } from './issues-view-core.ts';
import type { IssueRow, IssueStep, IssueStepInput, IssueTier } from './issues-view-core.ts';
import { reviewKeyActionOf, steppedRowKey } from './review-queue-core.ts';
import { showPrInReviewQueue } from './review-queue-store.ts';
import { pullRequestKeyFromReference } from '#shared/contracts/control-messages.ts';
import { isModalOpen } from '../session-card/modal.ts';
import { selectSession } from '../session-actions.ts';
import { sessionName, sessionUIs } from '../session-card/card-registry.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { actionOutcomeOfIssue, isChangingIssueState, isIssueClosed, isOpeningIssue, issueBodyText, issuesSnapshot, openIssueSession, reportIssuesAction, requestIssueBody, selectedIssue, selectIssue, setIssueState, subscribeIssues } from './issues-store.ts';
import type { IssuesChange } from './issues-store.ts';

type IssueRailScope = 'all' | IssueStep;

const STEP_LABEL: Readonly<Record<IssueStep, string>> = { triage: 'Triage', shape: 'Shape', running: 'Running', review: 'Review', close: 'Close' };
const TIER_HEADING: Readonly<Record<IssueTier, { title: string; hint: string }>> = {
  needs: { title: 'Needs you', hint: 'session waits on you' },
  failed: { title: 'Failed', hint: 'session failed' },
  close: { title: 'Close', hint: 'PR merged, issue open' },
  review: { title: 'Review', hint: 'PR open' },
  working: { title: 'Working', hint: 'session live' },
  shape: { title: 'Shape', hint: 'assigned to you, no session' },
  triage: { title: 'Triage', hint: 'new to you' },
};
const railScopes: { id: IssueRailScope; label: string }[] = [{ id: 'all', label: 'All' }, ...ISSUE_STEPS.map((step) => ({ id: step, label: STEP_LABEL[step] }))];
let railScope: IssueRailScope = 'all';
let queryText = '';
let root: HTMLDivElement | null = null;
let railTabs: ReturnType<typeof createPrScopeTabs<IssueRailScope>> | null = null;
let queue: HTMLElement | null = null;
let detailHost: HTMLElement | null = null;
let querySummary: HTMLElement | null = null;
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

function stepInputOf(issue: IssueRow): IssueStepInput {
  const session = liveIssueSession(issue);
  return {
    issue,
    session: session ? { state: session.currentState, stateSince: session.stateSince } : null,
    pullRequestStates: issue.pullRequests.map((pullRequest) => issuePullRequestState(pullRequest, githubPrByKey)),
  };
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
  bottom.append(el('span', 'issues-row-repo', issue.repo));
  if (issue.sources.includes('me')) bottom.append(el('span', 'issues-why', 'you'));
  if (!issue.projectId) bottom.append(el('span', 'issues-row-note', 'view only'));
  bottom.append(el('span', 'issues-row-labels', issue.labels.join(', ')));
  for (const pullRequest of issue.pullRequests) {
    const state = issuePullRequestState(pullRequest, githubPrByKey);
    const badge = el('span', 'issues-row-pr', `PR #${pullRequest.number} ${state}`);
    badge.dataset.prState = state;
    bottom.append(badge);
  }
  const waitStart = new Date(issueWaitStartMs(stepInputOf(issue))).toISOString();
  const age = el('span', 'pr-queue-elapsed', issueRelativeAge(waitStart, Date.now()));
  age.dataset.issueAge = waitStart;
  bottom.append(age);
  row.append(createIssueState(issue), top, bottom);
  row.addEventListener('click', () => {
    reportIssuesAction('select');
    openIssueDetail(issue);
  });
  return row;
}

function openIssueDetail(issue: IssueRow): void {
  selectIssue(issue.key);
  if (root) root.dataset.detailOpen = 'true';
  requestIssueBody(issue);
  render();
  if (detailHost) detailHost.scrollTop = 0;
}

function buildFact(list: HTMLElement, name: string, contents: (HTMLElement | string)[]): void {
  const value = el('dd');
  value.append(...contents);
  list.append(el('dt', null, name), value);
}

function actionButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function goToSessionButton(sessionId: string): HTMLButtonElement {
  return actionButton('Go to session', 'pr-action', () => {
    reportIssuesAction('go-to-session');
    selectSession(sessionId);
  });
}

function openInReviewsButton(issue: IssueRow, status: HTMLElement): HTMLButtonElement | null {
  const pullRequest = issue.pullRequests.find((candidate) => {
    const state = issuePullRequestState(candidate, githubPrByKey);
    return state === 'open' || state === 'draft';
  });
  const prKey = pullRequest ? pullRequestKeyFromReference(pullRequest.url) : null;
  if (!prKey) return null;
  return actionButton('Open in Reviews', 'pr-action', () => {
    reportIssuesAction('open-reviews');
    if (showPrInReviewQueue(prKey)) return;
    paintActionStatus(status, 'error', `PR #${pullRequest?.number ?? ''} is not in the Reviews queue. Open it on GitHub.`);
  });
}

function issueStateButton(issue: IssueRow, label: string, state: 'closed' | 'open'): HTMLButtonElement {
  const button = actionButton(label, 'pr-action', () => setIssueState(issue, state));
  button.disabled = isChangingIssueState(issue);
  return button;
}

function primaryActions(issue: IssueRow, step: IssueStep, status: HTMLElement): HTMLElement[] {
  if (isIssueClosed(issue)) return [issueStateButton(issue, 'Reopen', 'open')];
  const session = liveIssueSession(issue);
  const sessionButton = session && issue.sessionId ? goToSessionButton(issue.sessionId) : null;
  if (step === 'review') return [openInReviewsButton(issue, status), sessionButton].filter((button) => button !== null);
  if (step === 'close') return [issueStateButton(issue, 'Close issue', 'closed'), sessionButton].filter((button) => button !== null);
  if (sessionButton) return [sessionButton];
  if (!issue.projectId) return [];
  const open = actionButton('Open session', 'pr-action', () => openIssueSessionUnlessLive(issue));
  open.disabled = isOpeningIssue(issue);
  return [open];
}

function buildDetailFooter(issue: IssueRow): HTMLElement {
  const footer = el('footer', 'pr-footer issues-detail-footer');
  const status = el('span', 'pr-action-status issue-open-status');
  status.setAttribute('role', 'status');
  footer.append(...primaryActions(issue, issueStepOf(stepInputOf(issue)), status));
  footer.append(externalLink('pr-action pr-action-ghost', 'View on GitHub', issue.url));
  const outcome = actionOutcomeOfIssue(issue);
  const fallback = issue.projectId ? '' : `Add a project for ${issue.repo} in Settings to open sessions from here.`;
  paintActionStatus(status, outcome?.tone ?? null, outcome?.text ?? fallback);
  footer.append(status);
  return footer;
}

function buildStepTrack(currentStep: IssueStep): HTMLElement {
  const track = el('ol', 'issues-step-track');
  track.setAttribute('aria-label', `Step: ${STEP_LABEL[currentStep]}`);
  const currentIndex = ISSUE_STEPS.indexOf(currentStep);
  for (const [index, step] of ISSUE_STEPS.entries()) {
    const item = el('li', 'issues-step', STEP_LABEL[step]);
    item.dataset.progress = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'ahead';
    if (index === currentIndex) item.setAttribute('aria-current', 'step');
    track.append(item);
  }
  return track;
}

function createDetailAge(timestamp: string, nowMs: number): HTMLElement {
  const age = el('span', null, issueAgo(timestamp, nowMs));
  age.dataset.issueAgo = timestamp;
  return age;
}

function detailRenderKey(issue: IssueRow): string {
  const liveSessionId = liveIssueSession(issue) ? issue.sessionId : null;
  return `${issueTierOf(stepInputOf(issue))}:${liveSessionId ?? ''}`;
}

function renderDetailKeepingFocus(): void {
  const focused = document.activeElement instanceof HTMLElement && detailHost?.contains(document.activeElement) ? document.activeElement : null;
  const focusedLabel = focused?.textContent;
  renderDetail();
  if (!focusedLabel) return;
  [...detailHost?.querySelectorAll<HTMLElement>('button, a') ?? []].find((control) => control.textContent === focusedLabel)?.focus({ preventScroll: true });
}

function refreshDetailSessionState(): void {
  const article = detailHost?.querySelector<HTMLElement>('.issues-detail');
  const issue = selectedIssue();
  if (!article || !issue) return;
  const glyph = article.querySelector<HTMLElement>('.issues-facts .issues-state');
  if (glyph) syncIssueState(glyph, issue, true);
  const name = article.querySelector('.issues-session-name');
  const label = issueSessionLabel(issue);
  if (name && name.textContent !== label) name.textContent = label;
  if (article.dataset.renderKey === detailRenderKey(issue)) return;
  renderDetailKeepingFocus();
}

function renderDetail(): void {
  if (!detailHost) return;
  const issue = selectedIssue();
  if (!issue) {
    detailHost.replaceChildren(el('p', 'pr-empty', 'Pick an issue from the queue.'));
    return;
  }
  const article = el('article', 'pr-detail issues-detail');
  const back = el('button', 'pr-action pr-action-ghost issues-back', 'Back to issues');
  back.type = 'button';
  back.addEventListener('click', returnToQueue);
  const heading = el('header', 'pr-detail-heading');
  const title = el('div', 'pr-detail-title');
  title.append(externalLink('pr-link', `${issue.repo}#${issue.number}`, issue.url), el('h2', null, issue.title || 'Untitled issue'));
  const nowMs = Date.now();
  const meta = el('div', 'pr-detail-meta');
  const opened = el('span', null, `opened by ${issue.author || 'unknown'} `);
  const orgTag = createAuthorOrgTag(issue.isAuthorOrgMember, issue.repo);
  if (orgTag) opened.append(orgTag, ' ');
  const updated = el('span', null, 'updated ');
  opened.append(createDetailAge(issue.createdAt, nowMs));
  updated.append(createDetailAge(issue.updatedAt, nowMs));
  meta.append(opened, updated, el('span', null, `${issue.comments} comments`));
  if (issue.sources.includes('me')) meta.append(el('span', 'issues-why', 'assigned to you'));
  for (const team of issue.teams) meta.append(el('span', null, `mentions ${team}`));
  const input = stepInputOf(issue);
  article.dataset.renderKey = detailRenderKey(issue);
  heading.append(title, meta, buildStepTrack(issueStepOf(input)));
  const facts = el('dl', 'issues-facts');
  buildFact(facts, 'Repository', [issue.repo]);
  buildFact(facts, 'Labels', [issue.labels.join(', ') || 'none']);
  buildFact(facts, 'Assignees', [issue.assignees.join(', ') || 'unassigned']);
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

function render(): void {
  hasStaleSessionState = false;
  renderQueue();
  renderDetail();
}

function buildTierSection(tier: IssueTier, inputs: readonly IssueStepInput[]): HTMLElement {
  const section = el('section', 'pr-queue-section');
  section.dataset.tier = tier;
  const heading = el('h3', 'pr-section-heading issues-tier-heading', TIER_HEADING[tier].title);
  heading.append(el('span', 'issues-tier-hint', TIER_HEADING[tier].hint), el('span', 'issues-tier-count', String(inputs.length)));
  section.append(heading, ...inputs.map((input) => buildIssueRow(input.issue)));
  return section;
}

function renderQueue(): void {
  if (!root || !queue || !railTabs) return;
  const { latestStatus, selectedKey } = issuesSnapshot();
  const issues = latestStatus?.issues ?? [];
  const query = parseIssueQuery(queryText);
  const matching = issues.map(stepInputOf).filter((input) => matchesIssueQuery(input, query));
  const counts = issueStepCounts(matching);
  railTabs.select(railScope);
  for (const [scope, count] of railTabs.countElementByScope) count.textContent = String(scope === 'all' ? matching.length : counts.byStep[scope]);
  if (querySummary) querySummary.textContent = counts.needsYou > 0 ? `${counts.needsYou} ${counts.needsYou === 1 ? 'session needs' : 'sessions need'} you.` : '';
  const visible = railScope === 'all' ? matching : matching.filter((input) => issueStepOf(input) === railScope);
  const focusedKey = document.activeElement instanceof HTMLElement && queue.contains(document.activeElement) ? document.activeElement.dataset.issueKey : null;
  queue.replaceChildren(...tierIssues(visible).map((group) => buildTierSection(group.tier, group.inputs)));
  if (visible.length === 0) queue.append(el('p', 'pr-empty', emptyQueueText(issues.length, isIssueQueryActive(query))));
  if (focusedKey) [...queue.querySelectorAll<HTMLButtonElement>('[data-issue-key]')].find((row) => row.dataset.issueKey === focusedKey)?.focus({ preventScroll: true });
  if (selectedKey && !selectedIssue()) {
    selectIssue(null);
    root.dataset.detailOpen = 'false';
  }
  pollingControls?.update(latestStatus);
  updateAges();
}

function emptyQueueText(issueCount: number, isQueryActive: boolean): string {
  if (issueCount === 0) return issuesPlaceholder(issuesSnapshot().latestStatus);
  if (isQueryActive) return 'No open issues match this search. Clear it or pick All.';
  return `No issues are in ${railScope === 'all' ? 'any step' : STEP_LABEL[railScope]} right now. Pick All.`;
}

function createSearch(): HTMLElement {
  const container = el('div', 'issues-filters');
  const search = el('input', 'issues-search');
  search.type = 'search';
  search.placeholder = 'Search, or is:mine repo: label: has:pr';
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search issues');
  search.addEventListener('input', () => { queryText = search.value; render(); });
  search.addEventListener('change', () => reportIssuesAction('search'));
  querySummary = el('span', 'issues-filter-summary');
  querySummary.setAttribute('role', 'status');
  container.append(search, querySummary);
  return container;
}

function visibleRowKeys(): string[] {
  return [...queue?.querySelectorAll<HTMLElement>('[data-issue-key]') ?? []].map((row) => row.dataset.issueKey ?? '').filter(Boolean);
}

function returnToQueue(): void {
  if (root?.dataset.detailOpen !== 'true') return;
  reportIssuesAction('back');
  root.dataset.detailOpen = 'false';
  [...queue?.querySelectorAll<HTMLButtonElement>('[data-issue-key]') ?? []].find((row) => row.dataset.issueKey === issuesSnapshot().selectedKey)?.focus({ preventScroll: true });
}

function onIssuesKey(event: KeyboardEvent): void {
  if (event.repeat || event.defaultPrevented || !root || isPanelHidden(root) || isModalOpen() || isRealInputOwningKey(event)) return;
  if (document.activeElement?.classList.contains('xterm-helper-textarea')) return;
  const action = reviewKeyActionOf(event);
  if (action === 'cancel') { returnToQueue(); return; }
  const { selectedKey, issueByKey } = issuesSnapshot();
  if (action === 'open-session') {
    const sessionId = selectedKey ? issueByKey.get(selectedKey)?.sessionId : null;
    if (!sessionId || !sessionUIs.has(sessionId)) return;
    event.preventDefault();
    reportIssuesAction('go-to-session');
    selectSession(sessionId);
    return;
  }
  if (action !== 'next-row' && action !== 'previous-row') return;
  const nextKey = steppedRowKey(visibleRowKeys(), selectedKey, action === 'next-row' ? 1 : -1);
  const nextIssue = nextKey ? issueByKey.get(nextKey) : undefined;
  if (!nextIssue) return;
  event.preventDefault();
  openIssueDetail(nextIssue);
  const row = [...queue?.querySelectorAll<HTMLButtonElement>('[data-issue-key]') ?? []].find((candidate) => candidate.dataset.issueKey === nextKey);
  row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: 'nearest' });
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
  railTabs = createPrScopeTabs({
    label: 'Issue step',
    scopes: railScopes,
    selected: railScope,
    onSelect: (scope) => { reportIssuesAction('step'); railScope = scope; render(); },
    extraClassName: 'issues-scope-tabs issues-rail',
    countClassPrefix: 'issues-scope',
  });
  queue = el('nav', 'pr-queue');
  queue.setAttribute('aria-label', 'Issues');
  const foot = createPrQueueFoot(pollingControls.control);
  syncStatus = el('span', 'issues-sync');
  syncStatus.setAttribute('role', 'status');
  foot.prepend(syncStatus);
  foot.append(pollingControls.notice);
  pane.append(createSearch(), queue, foot);
  detailHost = el('section', 'pr-detail-host');
  detailHost.setAttribute('aria-label', 'Issue detail');
  columns.append(pane, detailHost);
  root.append(railTabs.element, columns);
  document.addEventListener('keydown', onIssuesKey);
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
  renderQueue();
}

const RENDER_BY_CHANGE: Record<IssuesChange, () => void> = {
  status: render,
  detail: renderDetailKeepingFocus,
  'session-state': refreshIssuesSessionState,
};

function applyIssuesChange(change: IssuesChange): void {
  RENDER_BY_CHANGE[change]();
}

export const view: ViewModule<HTMLElement> = { mount: mountIssuesView, refresh: refreshIssuesViewOnShow };
