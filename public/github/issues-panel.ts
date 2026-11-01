import './issues-panel.css';
import { paintActionStatus } from '../action-status.ts';
import { githubPrByKey, subscribeGithubPrs } from './github-prs-store.ts';
import { createAuthorOrgTag, el, externalLink, isMonitoringState, isPanelHidden, isRealInputOwningKey } from '../dom-helpers.ts';
import { paintStatusIcon } from '../status-icon.ts';
import { createPrStatusIcon } from './pr-status-icon.ts';
import { createGithubPollingControls } from './my-prs-panel.ts';
import { createPrQueueFoot } from './pr-queue-columns.ts';
import { ISSUE_STEPS, isIssueQueryActive, issueAgo, issuePullRequestState, issueRelativeAge, issueStatusOf, issueStepOf, issueWaitStartMs, issuesPlaceholder, matchesIssueQuery, orderedIssuesIn, parseIssueQuery } from './issues-view-core.ts';
import type { IssueList, IssueRow, IssueStatus, IssueStep, IssueStepInput } from './issues-view-core.ts';
import { reviewKeyActionOf, steppedRowKey } from './review-queue-core.ts';
import { showPrInReviewQueue } from './review-queue-store.ts';
import { pullRequestKeyFromReference } from '#shared/contracts/control-messages.ts';
import { isModalOpen } from '../session-card/modal.ts';
import { selectSession } from '../session-actions.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { actionOutcomeOfIssue, isChangingIssueState, isIssueClosed, isOpeningIssue, issueBodyText, issuesSnapshot, openIssueSession, reportIssuesAction, requestIssueBody, selectedIssue, selectIssue, setIssueState, subscribeIssues } from './issues-store.ts';
import type { IssuesChange } from './issues-store.ts';

type IssuesPage = { kind: 'list'; list: IssueList } | { kind: 'issue'; cameFrom: IssueList };

const STEP_LABEL: Readonly<Record<IssueStep, string>> = { triage: 'Triage', shape: 'Shape', running: 'Running', review: 'Review', close: 'Close' };
const LIST_TITLE: Readonly<Record<IssueList, string>> = { 'needs-you': 'Needs you', 'everything-else': 'Everything else' };
const OTHER_LIST: Readonly<Record<IssueList, IssueList>> = { 'needs-you': 'everything-else', 'everything-else': 'needs-you' };
const COLUMN_HEADINGS = ['', 'Issue', 'Status', 'Repo', 'Age'];
let page: IssuesPage = { kind: 'list', list: 'needs-you' };
let queryText = '';
let root: HTMLDivElement | null = null;
let listPane: HTMLElement | null = null;
let listBody: HTMLElement | null = null;
let pageHost: HTMLElement | null = null;
let syncStatus: HTMLElement | null = null;
let hasStaleSessionState = false;
let pollingControls: ReturnType<typeof createGithubPollingControls> | null = null;

function liveIssueSession(issue: IssueRow) {
  return issue.sessionId ? sessionUIs.get(issue.sessionId) : undefined;
}

function stepInputOf(issue: IssueRow): IssueStepInput {
  const session = liveIssueSession(issue);
  return {
    issue,
    session: session ? { state: session.currentState, stateSince: session.stateSince, isMonitoring: isMonitoringState(session.currentState, session.awaitingBackgroundTasks) } : null,
    pullRequestStates: issue.pullRequests.map((pullRequest) => issuePullRequestState(pullRequest, githubPrByKey)),
  };
}

function matchingInputs(): IssueStepInput[] {
  const query = parseIssueQuery(queryText);
  return (issuesSnapshot().latestStatus?.issues ?? []).map(stepInputOf).filter((input) => matchesIssueQuery(input, query));
}

function createStatusIcon(status: IssueStatus): HTMLElement {
  const icon = el('span', 'issues-status-icon');
  icon.setAttribute('aria-hidden', 'true');
  if (status.icon.kind === 'pr') {
    icon.append(createPrStatusIcon(status.icon.icon));
    return icon;
  }
  paintStatusIcon(icon, status.icon.icon);
  return icon;
}

function createAge(timestampMs: number, className: string): HTMLElement {
  const waitStart = new Date(timestampMs).toISOString();
  const age = el('span', className, issueRelativeAge(waitStart, Date.now()));
  age.dataset.issueAge = waitStart;
  return age;
}

function buildIssueRow(input: IssueStepInput, list: IssueList): HTMLButtonElement {
  const { issue } = input;
  const status = issueStatusOf(input);
  const row = el('button', 'issues-row');
  row.type = 'button';
  row.dataset.issueKey = issue.key;
  row.dataset.group = status.group;
  row.append(
    createStatusIcon(status),
    el('span', 'issues-row-title', issue.title || 'Untitled issue'),
    el('span', 'issues-row-status', status.text),
    el('span', 'issues-row-ref', `${issue.repo.split('/').at(-1) ?? issue.repo}#${issue.number}`),
    createAge(issueWaitStartMs(input), 'issues-row-age'),
  );
  row.addEventListener('click', () => {
    reportIssuesAction('select');
    openIssuePage(issue, list);
  });
  return row;
}

function buildTableHead(): HTMLElement {
  const head = el('div', 'issues-table-head');
  head.setAttribute('aria-hidden', 'true');
  head.append(...COLUMN_HEADINGS.map((heading) => el('span', null, heading)));
  return head;
}

function buildOtherListLink(list: IssueList, count: number): HTMLElement {
  const otherList = OTHER_LIST[list];
  const line = el('div', 'issues-other-list');
  const link = el('button', 'pr-action pr-action-ghost issues-small-action', LIST_TITLE[otherList]);
  link.type = 'button';
  link.addEventListener('click', () => {
    reportIssuesAction('step');
    showList(otherList);
  });
  line.append(link, el('span', 'issues-other-list-count', `${count} ${count === 1 ? 'issue' : 'issues'}`));
  return line;
}

function emptyListText(list: IssueList, issueCount: number): string {
  if (issueCount === 0) return issuesPlaceholder(issuesSnapshot().latestStatus);
  if (isIssueQueryActive(parseIssueQuery(queryText))) return 'No open issues match this search.';
  if (list === 'needs-you') return 'Nothing needs you right now.';
  return 'No sessions are running on issues.';
}

function rowElements(): HTMLButtonElement[] {
  return [...listBody?.querySelectorAll<HTMLButtonElement>('.issues-row') ?? []];
}

function renderList(): void {
  if (!listBody || page.kind !== 'list') return;
  const { list } = page;
  const matching = matchingInputs();
  const rows = orderedIssuesIn(list, matching);
  const otherCount = orderedIssuesIn(OTHER_LIST[list], matching).length;
  const focusedKey = document.activeElement instanceof HTMLElement && listBody.contains(document.activeElement) ? document.activeElement.dataset.issueKey : null;
  const heading = el('h2', 'issues-list-heading', LIST_TITLE[list]);
  heading.append(el('span', 'issues-list-count', String(rows.length)));
  const table = el('div', 'issues-table');
  table.append(buildTableHead(), ...rows.map((input) => buildIssueRow(input, list)));
  if (rows.length === 0) table.append(el('p', 'issues-empty', emptyListText(list, issuesSnapshot().latestStatus?.issues.length ?? 0)));
  listBody.replaceChildren(heading, table, buildOtherListLink(list, otherCount));
  if (focusedKey) rowElements().find((row) => row.dataset.issueKey === focusedKey)?.focus({ preventScroll: true });
}

function actionButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', `${className} issues-small-action`, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function openSessionButton(sessionId: string): HTMLButtonElement {
  return actionButton('Open session', 'pr-action', () => {
    reportIssuesAction('go-to-session');
    selectSession(sessionId);
  });
}

function reviewPullRequestButton(issue: IssueRow, status: HTMLElement): HTMLButtonElement | null {
  const pullRequest = issue.pullRequests.find((candidate) => {
    const state = issuePullRequestState(candidate, githubPrByKey);
    return state === 'open' || state === 'draft';
  });
  const prKey = pullRequest ? pullRequestKeyFromReference(pullRequest.url) : null;
  if (!pullRequest || !prKey) return null;
  return actionButton('Review PR', 'pr-action', () => {
    reportIssuesAction('open-reviews');
    if (showPrInReviewQueue(prKey)) return;
    paintActionStatus(status, 'error', `PR #${pullRequest.number} is not in the Reviews queue. Open it on GitHub.`);
  });
}

function issueStateButton(issue: IssueRow, label: string, state: 'closed' | 'open'): HTMLButtonElement {
  const button = actionButton(label, 'pr-action', () => setIssueState(issue, state));
  button.disabled = isChangingIssueState(issue);
  return button;
}

function startSessionButton(issue: IssueRow): HTMLButtonElement | null {
  if (!issue.projectId) return null;
  const button = actionButton('Start session', 'pr-action', () => {
    reportIssuesAction('open-session');
    if (liveIssueSession(issue)) return;
    openIssueSession(issue);
  });
  button.disabled = isOpeningIssue(issue);
  return button;
}

function primaryActions(issue: IssueRow, step: IssueStep, status: HTMLElement): HTMLElement[] {
  if (isIssueClosed(issue)) return [issueStateButton(issue, 'Reopen issue', 'open')];
  const sessionButton = liveIssueSession(issue) && issue.sessionId ? openSessionButton(issue.sessionId) : null;
  if (step === 'review') return [reviewPullRequestButton(issue, status), sessionButton].filter((button) => button !== null);
  if (step === 'close') return [issueStateButton(issue, 'Close issue', 'closed'), sessionButton].filter((button) => button !== null);
  if (sessionButton) return [sessionButton];
  return [startSessionButton(issue)].filter((button) => button !== null);
}

function buildPageActions(issue: IssueRow, step: IssueStep): HTMLElement {
  const footer = el('footer', 'issues-page-actions');
  const status = el('span', 'pr-action-status issue-open-status');
  status.setAttribute('role', 'status');
  footer.append(...primaryActions(issue, step, status));
  footer.append(externalLink('pr-action pr-action-ghost issues-small-action', 'View on GitHub', issue.url));
  const outcome = actionOutcomeOfIssue(issue);
  const fallback = issue.projectId ? '' : `Add a project for ${issue.repo} in Settings to start sessions from here.`;
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

function buildStatusBox(input: IssueStepInput): HTMLElement {
  const status = issueStatusOf(input);
  const box = el('div', 'issues-status-box');
  box.dataset.group = status.group;
  box.append(createStatusIcon(status), el('span', 'issues-status-text', status.text), createAge(issueWaitStartMs(input), 'issues-status-age'));
  return box;
}

function buildRefLine(issue: IssueRow): HTMLElement {
  const line = el('p', 'issues-ref-line');
  line.append(externalLink('issues-inline-link', `${issue.repo}#${issue.number}`, issue.url), ` by ${issue.author || 'unknown'}`);
  const orgTag = createAuthorOrgTag(issue.isAuthorOrgMember, issue.repo);
  if (orgTag) line.append(' ', orgTag);
  if (issue.labels.length > 0) line.append(`, ${issue.labels.join(', ')}`);
  return line;
}

function issuePageRenderKey(issue: IssueRow): string {
  const liveSessionId = liveIssueSession(issue) ? issue.sessionId : null;
  const input = stepInputOf(issue);
  const status = issueStatusOf(input);
  return `${status.group}:${status.icon.icon}:${status.text}:${issueWaitStartMs(input)}:${liveSessionId ?? ''}`;
}

function renderIssuePage(): void {
  if (!pageHost || page.kind !== 'issue') return;
  const issue = selectedIssue();
  if (!issue) {
    showList(page.cameFrom);
    return;
  }
  const input = stepInputOf(issue);
  const step = issueStepOf(input);
  const article = el('article', 'issues-page');
  article.dataset.renderKey = issuePageRenderKey(issue);
  const back = el('button', 'pr-action pr-action-ghost issues-small-action issues-back', 'Back to issues');
  back.type = 'button';
  back.addEventListener('click', returnToList);
  const body = el('section', 'issue-body');
  body.setAttribute('aria-label', 'Description');
  body.append(renderPlanBlocks(parsePlanMarkdown(issueBodyText(issue))));
  article.append(back, el('h2', 'issues-page-title', issue.title || 'Untitled issue'), buildRefLine(issue), buildStepTrack(step), buildStatusBox(input), body, buildPageActions(issue, step));
  pageHost.replaceChildren(article);
}

function renderIssuePageKeepingFocus(): void {
  const focused = document.activeElement instanceof HTMLElement && pageHost?.contains(document.activeElement) ? document.activeElement : null;
  const focusedLabel = focused?.textContent;
  renderIssuePage();
  if (!focusedLabel) return;
  [...pageHost?.querySelectorAll<HTMLElement>('button, a') ?? []].find((control) => control.textContent === focusedLabel)?.focus({ preventScroll: true });
}

function syncPageVisibility(): void {
  if (!root || !listPane || !pageHost) return;
  root.dataset.page = page.kind;
  listPane.hidden = page.kind !== 'list';
  pageHost.hidden = page.kind !== 'issue';
}

function render(): void {
  hasStaleSessionState = false;
  syncPageVisibility();
  renderList();
  renderIssuePage();
  pollingControls?.update(issuesSnapshot().latestStatus);
  updateAges();
}

function showList(list: IssueList): void {
  page = { kind: 'list', list };
  selectIssue(null);
  render();
}

function openIssuePage(issue: IssueRow, cameFrom: IssueList): void {
  selectIssue(issue.key);
  requestIssueBody(issue);
  page = { kind: 'issue', cameFrom };
  render();
  if (pageHost) pageHost.scrollTop = 0;
  pageHost?.querySelector<HTMLElement>('.issues-back')?.focus({ preventScroll: true });
}

function returnToList(): void {
  if (page.kind !== 'issue') return;
  reportIssuesAction('back');
  const issueKey = issuesSnapshot().selectedKey;
  showList(page.cameFrom);
  rowElements().find((row) => row.dataset.issueKey === issueKey)?.focus({ preventScroll: true });
}

function createSearch(): HTMLElement {
  const search = el('input', 'issues-search');
  search.type = 'search';
  search.placeholder = 'Search, or is:mine repo: label: has:pr';
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search issues');
  search.addEventListener('input', () => { queryText = search.value; renderList(); });
  search.addEventListener('change', () => reportIssuesAction('search'));
  return search;
}

function stepIssuePage(cameFrom: IssueList, step: 1 | -1): void {
  const orderedKeys = orderedIssuesIn(cameFrom, matchingInputs()).map((input) => input.issue.key);
  const nextKey = steppedRowKey(orderedKeys, issuesSnapshot().selectedKey, step);
  const nextIssue = nextKey ? issuesSnapshot().issueByKey.get(nextKey) : undefined;
  if (!nextIssue) return;
  openIssuePage(nextIssue, cameFrom);
}

function stepRowFocus(step: 1 | -1): void {
  const rows = rowElements();
  const focusedKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.issueKey ?? null : null;
  const nextKey = steppedRowKey(rows.map((row) => row.dataset.issueKey ?? ''), focusedKey, step);
  const row = rows.find((candidate) => candidate.dataset.issueKey === nextKey);
  row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: 'nearest' });
}

function openSelectedSession(event: KeyboardEvent): void {
  const sessionId = selectedIssue()?.sessionId;
  if (!sessionId || !sessionUIs.has(sessionId)) return;
  event.preventDefault();
  reportIssuesAction('go-to-session');
  selectSession(sessionId);
}

function onIssuesKey(event: KeyboardEvent): void {
  if (event.repeat || event.defaultPrevented || !root || isPanelHidden(root) || isModalOpen() || isRealInputOwningKey(event)) return;
  if (document.activeElement?.classList.contains('xterm-helper-textarea')) return;
  const action = reviewKeyActionOf(event);
  if (action === 'cancel') { returnToList(); return; }
  if (action === 'open-session' && page.kind === 'issue') { openSelectedSession(event); return; }
  if (action !== 'next-row' && action !== 'previous-row') return;
  event.preventDefault();
  const step = action === 'next-row' ? 1 : -1;
  if (page.kind === 'issue') { stepIssuePage(page.cameFrom, step); return; }
  stepRowFocus(step);
}

function updateAges(): void {
  if (!root || root.closest('[hidden]') || document.hidden) return;
  const nowMs = Date.now();
  const lastSyncAt = issuesSnapshot().latestStatus?.lastSyncAt;
  if (syncStatus) syncStatus.textContent = lastSyncAt ? `Synced ${issueAgo(lastSyncAt, nowMs)}.` : 'Not synced yet.';
  for (const age of root.querySelectorAll<HTMLElement>('[data-issue-age]')) age.textContent = issueRelativeAge(age.dataset.issueAge ?? '', nowMs);
}

function mountIssuesView(parent: HTMLElement): void {
  if (root) return;
  root = el('div', 'issues-content');
  parent.append(root);
  pollingControls = createGithubPollingControls('issues', root);
  listPane = el('section', 'issues-list-pane');
  listPane.setAttribute('aria-label', 'Issues');
  listBody = el('div', 'issues-list-body');
  const foot = createPrQueueFoot(pollingControls.control);
  syncStatus = el('span', 'issues-sync');
  syncStatus.setAttribute('role', 'status');
  foot.prepend(syncStatus);
  foot.append(pollingControls.notice);
  listPane.append(createSearch(), listBody, foot);
  pageHost = el('section', 'issues-page-host');
  pageHost.setAttribute('aria-label', 'Issue');
  root.append(listPane, pageHost);
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
  renderList();
  const issue = selectedIssue();
  const article = pageHost?.querySelector<HTMLElement>('.issues-page');
  if (page.kind === 'issue' && issue && article?.dataset.renderKey !== issuePageRenderKey(issue)) renderIssuePageKeepingFocus();
  updateAges();
}

const RENDER_BY_CHANGE: Record<IssuesChange, () => void> = {
  status: render,
  detail: renderIssuePageKeepingFocus,
  'session-state': refreshIssuesSessionState,
};

function applyIssuesChange(change: IssuesChange): void {
  RENDER_BY_CHANGE[change]();
}

export const view: ViewModule<HTMLElement> = { mount: mountIssuesView, refresh: refreshIssuesViewOnShow };
