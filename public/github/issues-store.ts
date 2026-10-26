import type { ActionStatusTone } from '../action-status.ts';
import type { OperatorActionOf, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { IssuesStatus } from '#shared/contracts/issues.ts';
import { nextRequestId } from '../control-ws.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import type { IssueRow } from './issues-view-core.ts';

type IssuesRequestSender = (message: Record<string, unknown>) => boolean;
export type IssuesChange = 'status' | 'detail' | 'session-state';

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
const ISSUES_NO_REPLY_TEXT = `The server did not answer within ${ISSUES_REQUEST_TIMEOUT_MS / 1000} s.`;
const RELOAD_DESCRIPTION_HINT = 'Select the issue to load its description.';

let selectedKey: string | null = null;
let latestStatus: IssuesStatus | null = null;
let issueByKey = new Map<string, IssueRow>();
let requestSender: IssuesRequestSender | null = null;
const openRequestById = new Map<string, PendingOpenRequest>();
const openOutcomeByIssue = new Map<string, { text: string; tone: ActionStatusTone }>();
const detailRequestById = new Map<string, PendingDetailRequest>();
const bodyByCacheKey = new Map<string, string>();
const bodyErrorByCacheKey = new Map<string, string>();
const subscribers = new Set<(change: IssuesChange) => void>();

function notifySubscribers(change: IssuesChange): void {
  for (const subscriber of subscribers) subscriber(change);
}

function issueBodyCacheKey(issue: IssueRow): string {
  return `${issue.key}:${issue.updatedAt}`;
}

function abandonOpenRequest(requestId: string): void {
  const request = openRequestById.get(requestId);
  if (!request) return;
  openRequestById.delete(requestId);
  openOutcomeByIssue.set(request.issueKey, { text: ISSUES_NO_REPLY_TEXT, tone: 'error' });
  notifySubscribers('detail');
}

function resolveOpenRequest(requestId: string): PendingOpenRequest | null {
  const request = openRequestById.get(requestId);
  if (!request) return null;
  clearTimeout(request.timeoutHandle);
  openRequestById.delete(requestId);
  return request;
}

export function issuesSnapshot(): { latestStatus: IssuesStatus | null; issueByKey: ReadonlyMap<string, IssueRow>; selectedKey: string | null } {
  return { latestStatus, issueByKey, selectedKey };
}

export function subscribeIssues(subscriber: (change: IssuesChange) => void): void {
  subscribers.add(subscriber);
}

export function selectIssue(issueKey: string | null): void {
  selectedKey = issueKey;
}

export function isOpeningIssue(issue: IssueRow): boolean {
  return [...openRequestById.values()].some((request) => request.issueKey === issue.key);
}

export function openOutcomeOfIssue(issue: IssueRow): { text: string; tone: ActionStatusTone } | undefined {
  return openOutcomeByIssue.get(issue.key);
}

export function issueBodyText(issue: IssueRow): string {
  const cacheKey = issueBodyCacheKey(issue);
  const body = bodyByCacheKey.get(cacheKey);
  if (body === '') return 'No description.';
  return body ?? bodyErrorByCacheKey.get(cacheKey) ?? 'Loading description.';
}

export function requestIssueBody(issue: IssueRow): void {
  const cacheKey = issueBodyCacheKey(issue);
  if (bodyByCacheKey.has(cacheKey) || [...detailRequestById.values()].some((request) => request.cacheKey === cacheKey)) return;
  const requestId = nextRequestId('issue-detail');
  bodyErrorByCacheKey.delete(cacheKey);
  if (!requestSender?.({ type: 'issue-detail', requestId, repo: issue.repo, issueNumber: issue.number })) {
    bodyErrorByCacheKey.set(cacheKey, `${NOT_CONNECTED_TEXT} ${RELOAD_DESCRIPTION_HINT}`);
    return;
  }
  detailRequestById.set(requestId, {
    cacheKey,
    timeoutHandle: setTimeout(() => {
      detailRequestById.delete(requestId);
      bodyErrorByCacheKey.set(cacheKey, `${ISSUES_NO_REPLY_TEXT} ${RELOAD_DESCRIPTION_HINT}`);
      notifySubscribers('detail');
    }, ISSUES_REQUEST_TIMEOUT_MS),
  });
}

export function openIssueSession(issue: IssueRow): void {
  const projectId = issue.projectId;
  if (!projectId || isOpeningIssue(issue)) return;
  const requestId = nextRequestId('open-issue-session');
  if (!requestSender?.({ type: 'open-issue-session', requestId, projectId, repo: issue.repo, issueNumber: issue.number })) {
    openOutcomeByIssue.set(issue.key, { text: NOT_CONNECTED_TEXT, tone: 'error' });
    notifySubscribers('detail');
    return;
  }
  openRequestById.set(requestId, {
    issueKey: issue.key,
    issueNumber: issue.number,
    timeoutHandle: setTimeout(() => abandonOpenRequest(requestId), ISSUES_REQUEST_TIMEOUT_MS),
  });
  openOutcomeByIssue.set(issue.key, { text: 'Opening session.', tone: 'busy' });
  notifySubscribers('detail');
}

export function reportIssuesAction(action: OperatorActionOf<'issues'>): void {
  requestSender?.({ type: 'dashboard-telemetry', event: 'operator_action', properties: { surface: 'issues', action } });
}

export function setIssuesRequestSender(sender: IssuesRequestSender): void {
  requestSender = sender;
}

export function refreshIssuesSessionState(): void {
  notifySubscribers('session-state');
}

export function applyIssuesConnectionState(connected: boolean): void {
  if (connected) return;
  for (const request of openRequestById.values()) {
    clearTimeout(request.timeoutHandle);
    openOutcomeByIssue.set(request.issueKey, { text: NOT_CONNECTED_TEXT, tone: 'error' });
  }
  openRequestById.clear();
  for (const request of detailRequestById.values()) {
    clearTimeout(request.timeoutHandle);
    bodyErrorByCacheKey.set(request.cacheKey, `${NOT_CONNECTED_TEXT} ${RELOAD_DESCRIPTION_HINT}`);
  }
  detailRequestById.clear();
  notifySubscribers('status');
}

export function applyIssuesStatus(message: IssuesStatus): void {
  const previousSelected = latestStatus?.issues.find((issue) => issue.key === selectedKey);
  latestStatus = message;
  issueByKey = new Map(message.issues.map((issue) => [issue.key, issue]));
  const selected = message.issues.find((issue) => issue.key === selectedKey);
  if (selected && selected.updatedAt !== previousSelected?.updatedAt) requestIssueBody(selected);
  notifySubscribers('status');
}

export function applyIssueDetailResult(message: ServerMessageOf<'issue-detail-result'>): void {
  const request = detailRequestById.get(message.requestId);
  if (!request) return;
  clearTimeout(request.timeoutHandle);
  detailRequestById.delete(message.requestId);
  if (message.ok && message.body !== null) bodyByCacheKey.set(request.cacheKey, message.body);
  if (!message.ok || message.body === null) bodyErrorByCacheKey.set(request.cacheKey, message.error || 'Could not load description. Select the issue to try again.');
  notifySubscribers('detail');
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
    openOutcomeByIssue.set(key, { text: `Session "${name}" ${outcome}.${suffix}`, tone: 'ok' });
    const issue = latestStatus?.issues.find((candidate) => candidate.key === key);
    if (issue && typeof message.sessionId === 'string') issue.sessionId = message.sessionId;
    notifySubscribers('status');
    return;
  }
  const error = typeof message.error === 'string' && message.error ? message.error : 'Could not open session.';
  openOutcomeByIssue.set(key, { text: error, tone: 'error' });
  notifySubscribers('detail');
}
