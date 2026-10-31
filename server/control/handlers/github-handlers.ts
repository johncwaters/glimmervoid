import { configIssueMessage } from '../../../shared/contracts/index.ts';
import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import type { GithubTeam } from '../../../shared/contracts/control-messages.ts';
import { MyPrKeepMergeableRequest, MyPrMergeRequest, MyPrMergeWhenReadyRequest } from '../../../shared/contracts/my-prs.ts';
import type { MyPrKeepMergeableResult, MyPrMergeResult, MyPrMergeWhenReadyResult } from '../../../shared/contracts/my-prs.ts';
import { TeamReviewActionRequest } from '../../../shared/contracts/team-review.ts';
import type { TeamReviewActionResult } from '../../../shared/contracts/team-review.ts';
import { errorMessage } from '../../../shared/text.ts';
import { manualPrLink } from '../../../session/core/session-pr-links-core.ts';
import type { Session } from '../../../session/sessions.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { buildGithubIssuePrompt, deriveIssueSessionName } from '../../github/core/github-issues-core.ts';
import { toMyPrsWireStatus } from '../../github/core/my-prs-core.ts';
import { prKey, prSessionName, prSessionPrompt } from '../../github/core/team-review-core.ts';
import { githubStoreRateLimitedError } from '../../github/github-store-poller.ts';
import { createKeyedSerialQueue } from '../../spawn-gate.ts';
import type { ControlContext } from '../control-context.ts';
import { replyTo } from '../control-context.ts';
import type { ConnectFrames, ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable, RawControlRequest } from '../core/control-dispatch-core.ts';

type TeamReviewActionOutcome = Omit<TeamReviewActionResult, 'key'>;

function myPrMergeKey(msg: RawControlRequest): string {
  return typeof msg?.repo === 'string' && typeof msg.number === 'number' ? prKey(msg.repo, msg.number) : '';
}

interface GithubHandlerGroup extends ControlHandlerGroup {
  lateConnectFrames: ConnectFrames;
}

function createGithubHandlers(context: ControlContext, deps: ControlHandlerDeps): GithubHandlerGroup {
  const { sessions, findConfiguredProject, createProjectSession, captureOperatorAction } = context;
  const {
    config,
    getTeamReviewStatus = null,
    getMyPrsStatus = null,
    getIssuesStatus = null,
    githubStore = null,
    issues = null,
    teamReview = null,
    myPrs = null,
    requestIssue = async () => ({ isRateLimited: false, value: { ok: false, issue: null, error: 'Issues polling is not running.' } }),
    requestViewer = async () => ({ isRateLimited: false, value: null }),
    requestViewerTeams = async () => ({ isRateLimited: false, value: null }),
    issueProjectRepos = null,
  } = deps;

  const issueOpenQueue = createKeyedSerialQueue();
  const prSessionOpenQueue = createKeyedSerialQueue();

  async function handleListGithubTeams(request: ClientMessageOf<'list-github-teams'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: { viewer: string | null; teams: GithubTeam[]; error: string | null }) => replyTo(ws, request, 'github-teams-listed', payload);
    const viewerRead = await requestViewer('priority');
    if (viewerRead.isRateLimited) { reply({ viewer: null, teams: [], error: githubStoreRateLimitedError(viewerRead.waitMs, 'your GitHub login') }); return; }
    if (!viewerRead.value) { reply({ viewer: null, teams: [], error: null }); return; }
    const teamsRead = await requestViewerTeams('priority');
    if (teamsRead.isRateLimited) { reply({ viewer: viewerRead.value, teams: [], error: githubStoreRateLimitedError(teamsRead.waitMs, 'your GitHub teams') }); return; }
    if (!teamsRead.value) { reply({ viewer: viewerRead.value, teams: [], error: 'GitHub did not list your teams.' }); return; }
    reply({ viewer: viewerRead.value, teams: teamsRead.value, error: null });
  }

  async function handleIssueDetail(request: ClientMessageOf<'issue-detail'>, ws: ControlSocket): Promise<void> {
    try {
      const issueRead = await requestIssue(request.issueNumber, request.repo, 'priority');
      if (issueRead.isRateLimited) {
        replyTo(ws, request, 'issue-detail-result', { ok: false, body: null, error: githubStoreRateLimitedError(issueRead.waitMs, 'the issue') });
        return;
      }
      const viewed = issueRead.value;
      if (!viewed.ok || !viewed.issue) {
        replyTo(ws, request, 'issue-detail-result', { ok: false, body: null, error: viewed.error || 'Issue not found.' });
        return;
      }
      replyTo(ws, request, 'issue-detail-result', { ok: true, body: viewed.issue.body, error: null });
    } catch (error: unknown) {
      replyTo(ws, request, 'issue-detail-result', { ok: false, body: null, error: errorMessage(error) });
    }
  }

  async function handleSetIssueState(request: ClientMessageOf<'set-issue-state'>, ws: ControlSocket): Promise<void> {
    captureOperatorAction('issues', request.state === 'closed' ? 'close' : 'reopen');
    const setIssueState = issues?.setIssueState;
    if (!setIssueState) { replyTo(ws, request, 'set-issue-state-result', { ok: false, error: 'Issues polling is not running.' }); return; }
    try {
      const applied = await setIssueState({ repo: request.repo, number: request.issueNumber, state: request.state });
      replyTo(ws, request, 'set-issue-state-result', { ok: applied.ok, error: applied.ok ? null : applied.err });
    } catch (error: unknown) {
      replyTo(ws, request, 'set-issue-state-result', { ok: false, error: errorMessage(error) });
    }
  }

  async function handleOpenIssueSession(msg: ClientMessageOf<'open-issue-session'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'open-issue-session-result', { ok: false, error: null, ...payload });
    const project = findConfiguredProject(msg.projectId);
    if (!project) { reply({ error: 'Project not found' }); return; }
    captureOperatorAction('issues', 'open-session');
    const issueNumber = msg.issueNumber ?? 0;
    const repo = msg.repo;
    try {
      if (!issueProjectRepos) { reply({ error: 'Issues polling is not running.' }); return; }
      const projectRepos = await issueProjectRepos(msg.projectId);
      if (!projectRepos.some((projectRepo) => projectRepo.toLowerCase() === repo.toLowerCase())) {
        reply({ error: `Repository ${repo} does not belong to project "${project.name}"` });
        return;
      }
      const issueKey = `${repo}#${issueNumber}`;
      const linkedSessionId = await issues?.getLinkedSessionId?.(issueKey);
      const linkedSession = linkedSessionId ? sessions.get(linkedSessionId) : null;
      if (linkedSession) {
        reply({ ok: true, sessionId: linkedSession.id, sessionName: linkedSession.name, existing: true });
        return;
      }
      const issueRead = await requestIssue(issueNumber, repo, 'priority');
      if (issueRead.isRateLimited) { reply({ error: githubStoreRateLimitedError(issueRead.waitMs, 'the issue') }); return; }
      const viewed = issueRead.value;
      if (!viewed.ok) { reply({ error: `Could not read GitHub issue #${issueNumber}: ${viewed.error}` }); return; }
      const issue = viewed.issue;
      if (!issue) { reply({ error: `Open issue #${issueNumber} was not found` }); return; }
      const sessionName = deriveIssueSessionName(issue);
      const created = createProjectSession({
        name: sessionName,
        path: project.path,
        agent: project.agent,
        dangerouslySkipPermissions: project.dangerouslySkipPermissions,
      });
      if (!created.ok) { reply({ error: created.error }); return; }
      const session = sessions.get(created.project.id);
      if (!session) { reply({ error: `Session "${sessionName}" is not loaded` }); return; }
      const prompt = buildGithubIssuePrompt({ issue, repoSlug: repo });
      const pasted = session.pasteTextWhenReady(prompt);
      if (!pasted.ok) { reply({ error: `Could not write to "${session.name}" (${pasted.reason})` }); return; }
      await issues?.linkSession?.(issueKey, session.id);
      reply({ ok: true, sessionId: session.id, sessionName: session.name, pending: pasted.deferred === true });
      console.log(`[control] open-issue-session: issue=${repo}#${issueNumber} -> session=${session.name}`);
    } catch (error) {
      reply({ error: `Could not open GitHub issue session: ${errorMessage(error)}` });
    }
  }

  function sessionLinkedToPr(pullRequestKey: string): Session | null {
    const comparableKey = pullRequestKey.toLowerCase();
    for (const [, session] of sessions) {
      if (session.linkedPrs.some((link) => prKey(link.repo, link.number).toLowerCase() === comparableKey)) return session;
    }
    return null;
  }

  async function handleOpenTeamReviewSession(msg: ClientMessageOf<'open-team-review-session'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'open-team-review-session-result', { ok: false, error: null, key: msg.key, ...payload });
    captureOperatorAction('reviews', 'open-session');
    try {
      const linkedSession = sessionLinkedToPr(msg.key);
      if (linkedSession) {
        reply({ ok: true, sessionId: linkedSession.id, sessionName: linkedSession.name, existing: true });
        return;
      }
      if (!teamReview?.preparePrSession) { reply({ error: 'Team review is not running' }); return; }
      const singleRepoProjects = config.projects.filter((project) => !project.repos);
      const checkout = await teamReview.preparePrSession(msg.key);
      if (!checkout.ok) { reply({ error: checkout.error }); return; }
      const sourceProject = checkout.isConfiguredProject ? singleRepoProjects.find((project) => project.path === checkout.checkoutPath) : undefined;
      const created = createProjectSession({
        name: prSessionName(checkout.repo, checkout.detail.number, checkout.detail.title),
        path: checkout.checkoutPath,
        baseBranch: checkout.baseBranch,
        agent: sourceProject?.agent,
        dangerouslySkipPermissions: false,
      });
      if (!created.ok) { reply({ error: created.error }); return; }
      const session = sessions.get(created.project.id);
      if (!session) { reply({ error: `Session "${created.project.name}" is not loaded` }); return; }
      const link = manualPrLink(msg.key, (typeof getMyPrsStatus === 'function' ? getMyPrsStatus() : null)?.prs ?? [], Date.now());
      if (link) session.linkPrManually(link);
      const pasted = session.pasteTextWhenReady(prSessionPrompt({ repo: checkout.repo, detail: checkout.detail, draft: checkout.draft }));
      if (!pasted.ok) { reply({ error: `Could not write to "${session.name}" (${pasted.reason})` }); return; }
      reply({ ok: true, sessionId: session.id, sessionName: session.name, pending: pasted.deferred === true });
      console.log(`[control] open-team-review-session: pr=${msg.key} -> session=${session.name}`);
    } catch (error) {
      reply({ error: `Could not open a session for ${msg.key}: ${errorMessage(error)}` });
    }
  }

  async function handleTeamReviewAction(msg: ClientMessageOf<'team-review-action'>, ws: ControlSocket): Promise<void> {
    const requestedKey = typeof msg.key === 'string' ? msg.key : '';
    const reply = (outcome: TeamReviewActionOutcome) => replyTo(ws, msg, 'team-review-action-result', { key: requestedKey, ...outcome });
    const parsed = TeamReviewActionRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    captureOperatorAction('reviews', parsed.data.action);
    if (!teamReview?.isRunning()) { reply({ ok: false, error: 'Team review is not running' }); return; }
    reply(await teamReview.submitAction(parsed.data));
  }

  async function handleGithubPollingRefresh(msg: ClientMessageOf<'github-polling-refresh'>, ws: ControlSocket): Promise<void> {
    captureOperatorAction(msg.lane === 'issues' ? 'issues' : 'reviews', 'refresh');
    const lane = { 'my-prs': myPrs, 'team-review': teamReview, issues }[msg.lane];
    if (!lane?.refresh) {
      replyTo(ws, msg, 'github-polling-refresh-result', { ok: false, error: 'Reviews polling is not running.' });
      return;
    }
    const refreshOutcome = await lane.refresh();
    replyTo(ws, msg, 'github-polling-refresh-result', {
      ...refreshOutcome,
      ...(githubStore ? { freshness: githubStore.getFreshness() } : {}),
    });
  }

  async function handleMyPrMerge(msg: ClientMessageOf<'my-pr-merge'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: Omit<MyPrMergeResult, 'key'>) => replyTo(ws, msg, 'my-pr-merge-result', { key: myPrMergeKey(msg), ...outcome });
    const parsed = MyPrMergeRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    captureOperatorAction('reviews', 'merge');
    if (!myPrs) { reply({ ok: false, error: 'My pull requests is not running' }); return; }
    reply(await myPrs.mergePr(parsed.data));
  }

  async function handleMyPrKeepMergeable(msg: ClientMessageOf<'my-pr-keep-mergeable'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: Omit<MyPrKeepMergeableResult, 'key'>) => replyTo(ws, msg, 'my-pr-keep-mergeable-result', { key: myPrMergeKey(msg), ...outcome });
    const parsed = MyPrKeepMergeableRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    captureOperatorAction('reviews', 'keep-mergeable');
    if (!myPrs?.setKeepMergeable) { reply({ ok: false, error: 'My pull requests is not running' }); return; }
    reply(await myPrs.setKeepMergeable(parsed.data));
  }

  async function handleMyPrMergeWhenReady(msg: ClientMessageOf<'my-pr-merge-when-ready'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: Omit<MyPrMergeWhenReadyResult, 'key'>) => replyTo(ws, msg, 'my-pr-merge-when-ready-result', { key: myPrMergeKey(msg), ...outcome });
    const parsed = MyPrMergeWhenReadyRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    captureOperatorAction('reviews', 'merge-when-ready');
    if (!myPrs?.setMergeWhenReady) { reply({ ok: false, error: 'My pull requests is not running' }); return; }
    reply(await myPrs.setMergeWhenReady(parsed.data));
  }

  function connectFrames(): readonly unknown[] {
    const frames: unknown[] = [];
    const teamReviewStatus = typeof getTeamReviewStatus === 'function' ? getTeamReviewStatus() : null;
    if (githubStore) frames.push(githubStore.snapshotMessage());
    if (teamReviewStatus) frames.push(teamReviewStatus);
    return frames;
  }

  function lateConnectFrames(): readonly unknown[] {
    const frames: unknown[] = [];
    const myPrsStatus = typeof getMyPrsStatus === 'function' ? getMyPrsStatus() : null;
    if (myPrsStatus) frames.push(toMyPrsWireStatus(myPrsStatus));
    const issuesStatus = getIssuesStatus?.();
    if (issuesStatus) frames.push(issuesStatus);
    return frames;
  }

  const handlers = {
    'list-github-teams': handleListGithubTeams,
    'issue-detail': handleIssueDetail,
    'set-issue-state': handleSetIssueState,
    'open-team-review-session': (msg: ClientMessageOf<'open-team-review-session'>, ws: ControlSocket) => prSessionOpenQueue.run(msg.key.toLowerCase(), () => handleOpenTeamReviewSession(msg, ws)),
    'open-issue-session': (msg: ClientMessageOf<'open-issue-session'>, ws: ControlSocket) => issueOpenQueue.run(`${msg.repo.toLowerCase()}#${msg.issueNumber}`, () => handleOpenIssueSession(msg, ws)),
    'team-review-action': handleTeamReviewAction,
    'my-pr-merge': handleMyPrMerge,
    'my-pr-keep-mergeable': handleMyPrKeepMergeable,
    'my-pr-merge-when-ready': handleMyPrMergeWhenReady,
    'github-polling-refresh': handleGithubPollingRefresh,
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'list-github-teams': (_msg, requestId, message) => ({ type: 'github-teams-listed', requestId, viewer: null, teams: [], error: message }),
    'issue-detail': (_msg, requestId, message) => ({ type: 'issue-detail-result', requestId, ok: false, body: null, error: message }),
    'set-issue-state': (_msg, requestId, message) => ({ type: 'set-issue-state-result', requestId, ok: false, error: message }),
    'open-issue-session': (_msg, requestId, message) => ({ type: 'open-issue-session-result', requestId, ok: false, error: message }),
    'open-team-review-session': (_msg, requestId, message) => ({ type: 'open-team-review-session-result', requestId, ok: false, error: message }),
    'team-review-action': (msg, requestId, message) => ({ type: 'team-review-action-result', requestId, key: typeof msg?.key === 'string' ? msg.key : '', ok: false, error: message }),
    'github-polling-refresh': (_msg, requestId, message) => ({ type: 'github-polling-refresh-result', requestId, ok: false, error: message }),
    'my-pr-merge': (msg, requestId, message) => ({ type: 'my-pr-merge-result', requestId, key: myPrMergeKey(msg), ok: false, error: message }),
    'my-pr-keep-mergeable': (msg, requestId, message) => ({ type: 'my-pr-keep-mergeable-result', requestId, key: myPrMergeKey(msg), ok: false, error: message }),
    'my-pr-merge-when-ready': (msg, requestId, message) => ({ type: 'my-pr-merge-when-ready-result', requestId, key: myPrMergeKey(msg), ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, connectFrames, lateConnectFrames };
}

export { createGithubHandlers };
