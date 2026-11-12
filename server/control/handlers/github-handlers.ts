import { configIssueMessage } from '../../../shared/contracts/index.ts';
import type { ClientMessageOf, OperatorActionOf } from '../../../shared/contracts/index.ts';
import type { GithubTeam } from '../../../shared/contracts/control-messages.ts';
import { MyPrKeepMergeableRequest, MyPrMergeRequest, MyPrMergeWhenReadyRequest } from '../../../shared/contracts/my-prs.ts';
import type { MyPrKeepMergeableResult, MyPrMergeResult, MyPrMergeWhenReadyResult } from '../../../shared/contracts/my-prs.ts';
import { PrActionRunRequest, PrFlowApproveRequest, PrFlowDisposeRequest, PrFlowItemRequest, PrFlowSaveRuleRequest } from '../../../shared/contracts/pr-flows.ts';
import type { PrFlowDisposeResult, PrFlowDisposition } from '../../../shared/contracts/pr-flows.ts';
import { TeamReviewActionRequest } from '../../../shared/contracts/team-review.ts';
import type { TeamReviewActionResult } from '../../../shared/contracts/team-review.ts';
import { errorMessage } from '../../../shared/text.ts';
import { manualPrLink } from '../../../session/core/session-pr-links-core.ts';
import type { Session } from '../../../session/sessions.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { toMyPrsWireStatus } from '../../github/core/my-prs-core.ts';
import { prKey, prSessionName, prSessionPrompt, sessionLinkedToPr } from '../../github/core/team-review-core.ts';
import { githubStoreRateLimitedError } from '../../github/github-store-poller.ts';
import { createKeyedSerialQueue } from '../../spawn-gate.ts';
import type { ControlContext, RequestWithId } from '../control-context.ts';
import { replyTo } from '../control-context.ts';
import type { ConnectFrames, ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable, RawControlRequest } from '../core/control-dispatch-core.ts';
import { clock } from '../../../shared/clock.ts';

type TeamReviewActionOutcome = Omit<TeamReviewActionResult, 'key'>;

function prFlowOperatorAction(action: PrFlowDisposition): 'pr-flow-dismiss' | 'pr-flow-fix-local' | 'pr-flow-run' {
  if (action === 'dismiss' || action === 'fix-local') return `pr-flow-${action}`;
  return 'pr-flow-run';
}

function myPrMergeKey(msg: RawControlRequest): string {
  return typeof msg?.repo === 'string' && typeof msg.number === 'number' ? prKey(msg.repo, msg.number) : '';
}

interface GithubHandlerGroup extends ControlHandlerGroup {
  lateConnectFrames: ConnectFrames;
}

function createGithubHandlers(context: ControlContext, deps: ControlHandlerDeps): GithubHandlerGroup {
  const { sessions, createProjectSession, captureOperatorAction } = context;
  const {
    config,
    getTeamReviewStatus = null,
    getMyPrsStatus = null,
    githubStore = null,
    teamReview = null,
    myPrs = null,
    prFlows = null,
    requestViewer = async () => ({ isRateLimited: false, value: null }),
    requestViewerTeams = async () => ({ isRateLimited: false, value: null }),
  } = deps;

  const prSessionOpenQueue = createKeyedSerialQueue();

  async function handleListGithubTeams(request: ClientMessageOf<'list-github-teams'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: { viewer: string | null; teams: GithubTeam[]; orgs: string[]; error: string | null }) => replyTo(ws, request, 'github-teams-listed', payload);
    const viewerRead = await requestViewer('priority');
    if (viewerRead.isRateLimited) { reply({ viewer: null, teams: [], orgs: [], error: githubStoreRateLimitedError(viewerRead.waitMs, 'your GitHub login') }); return; }
    if (!viewerRead.value) { reply({ viewer: null, teams: [], orgs: [], error: null }); return; }
    const teamsRead = await requestViewerTeams('priority');
    if (teamsRead.isRateLimited) { reply({ viewer: viewerRead.value, teams: [], orgs: [], error: githubStoreRateLimitedError(teamsRead.waitMs, 'your GitHub teams') }); return; }
    if (!teamsRead.value) { reply({ viewer: viewerRead.value, teams: [], orgs: [], error: 'GitHub did not list your teams.' }); return; }
    reply({ viewer: viewerRead.value, teams: teamsRead.value.teams, orgs: teamsRead.value.orgs, error: null });
  }

  function linkedSessionFor(pullRequestKey: string): Session | null {
    return sessionLinkedToPr(sessions.values(), pullRequestKey);
  }

  async function handleOpenTeamReviewSession(msg: ClientMessageOf<'open-team-review-session'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'open-team-review-session-result', { ok: false, error: null, key: msg.key, ...payload });
    captureOperatorAction('reviews', 'open-session');
    try {
      const linkedSession = linkedSessionFor(msg.key);
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
      const link = manualPrLink(msg.key, (typeof getMyPrsStatus === 'function' ? getMyPrsStatus() : null)?.prs ?? [], clock.nowMs());
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

  async function handleTeamReviewRefreshThreads(msg: ClientMessageOf<'team-review-refresh-threads'>): Promise<void> {
    await teamReview?.refreshThreads?.(msg.key);
  }

  async function handleGithubPollingRefresh(msg: ClientMessageOf<'github-polling-refresh'>, ws: ControlSocket): Promise<void> {
    captureOperatorAction('reviews', 'refresh');
    const lane = { 'my-prs': myPrs, 'team-review': teamReview }[msg.lane];
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

  async function answerPrFlowRequest<FlowRequest>(
    msg: RequestWithId,
    ws: ControlSocket,
    parsed: { success: true; data: FlowRequest } | { success: false; error: Parameters<typeof configIssueMessage>[0] },
    operatorActionOf: (request: FlowRequest) => OperatorActionOf<'reviews'>,
    runFlow: (flows: NonNullable<typeof prFlows>, request: FlowRequest) => Promise<PrFlowDisposeResult>,
  ): Promise<void> {
    const reply = (outcome: PrFlowDisposeResult) => replyTo(ws, msg, 'pr-flow-dispose-result', outcome);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    captureOperatorAction('reviews', operatorActionOf(parsed.data));
    if (!prFlows) { reply({ ok: false, error: 'My pull requests is not running' }); return; }
    reply(await runFlow(prFlows, parsed.data));
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
    if (prFlows) frames.push(prFlows.statusFrame());
    return frames;
  }

  const handlers = {
    'list-github-teams': handleListGithubTeams,
    'open-team-review-session': (msg: ClientMessageOf<'open-team-review-session'>, ws: ControlSocket) => prSessionOpenQueue.run(msg.key.toLowerCase(), () => handleOpenTeamReviewSession(msg, ws)),
    'team-review-action': handleTeamReviewAction,
    'team-review-refresh-threads': handleTeamReviewRefreshThreads,
    'my-pr-merge': handleMyPrMerge,
    'my-pr-keep-mergeable': handleMyPrKeepMergeable,
    'my-pr-merge-when-ready': handleMyPrMergeWhenReady,
    'github-polling-refresh': handleGithubPollingRefresh,
    'pr-flow-dispose': (msg: ClientMessageOf<'pr-flow-dispose'>, ws: ControlSocket) => answerPrFlowRequest(msg, ws, PrFlowDisposeRequest.safeParse({ prKey: msg.prKey, itemKey: msg.itemKey, action: msg.action, reason: msg.reason }), (request) => prFlowOperatorAction(request.action), (flows, request) => flows.dispose(request)),
    'pr-flow-undo': (msg: ClientMessageOf<'pr-flow-undo'>, ws: ControlSocket) => answerPrFlowRequest(msg, ws, PrFlowItemRequest.safeParse({ prKey: msg.prKey, itemKey: msg.itemKey }), () => 'pr-flow-undo', (flows, request) => flows.undo(request)),
    'pr-flow-save-rule': (msg: ClientMessageOf<'pr-flow-save-rule'>, ws: ControlSocket) => answerPrFlowRequest(msg, ws, PrFlowSaveRuleRequest.safeParse({ prKey: msg.prKey, itemKey: msg.itemKey, reason: msg.reason }), () => 'pr-flow-save-rule', (flows, request) => flows.saveRule(request)),
    'pr-flow-approve': (msg: ClientMessageOf<'pr-flow-approve'>, ws: ControlSocket) => answerPrFlowRequest(msg, ws, PrFlowApproveRequest.safeParse({ fingerprint: msg.fingerprint }), () => 'pr-flow-approve', (flows, request) => flows.approve(request)),
    'pr-action-run': (msg: ClientMessageOf<'pr-action-run'>, ws: ControlSocket) => answerPrFlowRequest(msg, ws, PrActionRunRequest.safeParse({ repo: msg.repo, number: msg.number, actionId: msg.actionId, head: msg.head }), () => 'pr-flow-run', (flows, request) => flows.runPrAction(request)),
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'list-github-teams': (_msg, requestId, message) => ({ type: 'github-teams-listed', requestId, viewer: null, teams: [], orgs: [], error: message }),
    'open-team-review-session': (_msg, requestId, message) => ({ type: 'open-team-review-session-result', requestId, ok: false, error: message }),
    'team-review-action': (msg, requestId, message) => ({ type: 'team-review-action-result', requestId, key: typeof msg?.key === 'string' ? msg.key : '', ok: false, error: message }),
    'github-polling-refresh': (_msg, requestId, message) => ({ type: 'github-polling-refresh-result', requestId, ok: false, error: message }),
    'my-pr-merge': (msg, requestId, message) => ({ type: 'my-pr-merge-result', requestId, key: myPrMergeKey(msg), ok: false, error: message }),
    'my-pr-keep-mergeable': (msg, requestId, message) => ({ type: 'my-pr-keep-mergeable-result', requestId, key: myPrMergeKey(msg), ok: false, error: message }),
    'my-pr-merge-when-ready': (msg, requestId, message) => ({ type: 'my-pr-merge-when-ready-result', requestId, key: myPrMergeKey(msg), ok: false, error: message }),
    'pr-flow-dispose': (_msg, requestId, message) => ({ type: 'pr-flow-dispose-result', requestId, ok: false, error: message }),
    'pr-flow-undo': (_msg, requestId, message) => ({ type: 'pr-flow-dispose-result', requestId, ok: false, error: message }),
    'pr-flow-save-rule': (_msg, requestId, message) => ({ type: 'pr-flow-dispose-result', requestId, ok: false, error: message }),
    'pr-flow-approve': (_msg, requestId, message) => ({ type: 'pr-flow-dispose-result', requestId, ok: false, error: message }),
    'pr-action-run': (_msg, requestId, message) => ({ type: 'pr-flow-dispose-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, connectFrames, lateConnectFrames };
}

export { createGithubHandlers };
