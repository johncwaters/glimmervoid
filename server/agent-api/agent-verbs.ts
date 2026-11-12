import fs from 'node:fs';
import path from 'node:path';
import { describeSessionLimits } from '../../session/core/session-routes.ts';
import type { SessionRoleFacts } from '../../session/core/session-routes.ts';
import type { Session } from '../../session/sessions.ts';
import type { AgentAnswerRequest, AgentCheckoutRequest, AgentAttentionReply, AgentAttentionRequest, AgentBoardRow, AgentCloseRequest, AgentCommentsRequest, AgentEditRequest, AgentLimitsReply, AgentPacksRequest, AgentReadRequest, AgentSendRequest, AgentSettingsRequest, AgentSpawnRequest } from '../../shared/contracts/session.ts';
import { manualPrLink } from '../../session/core/session-pr-links-core.ts';
import { REMOTE_URL_PATTERN, describePushLanding, describeUnpushedCloseRefusal, projectMyPrs, projectReviewDetail, projectReviews } from '../core/agent-api-core.ts';
import { openComments } from '../review/review-state-core.ts';
import type { AgentRefusalReply, AgentReplyOf } from '../core/agent-api-core.ts';
import { isRecord } from '../../shared/coerce.ts';
import { AGENT_LANE_TAG } from './agent-api-context.ts';
import type { AgentApiRuntime, AgentVerbHandlers } from './agent-api-context.ts';
import type { ChildChannels } from './child-channels.ts';
import type { AgentSpawner } from './agent-spawn.ts';
import type { WakeWiring } from '../wakes/wake-wiring.ts';
import { configuredWorktreeRoot } from '../core/integration-branch-core.ts';
import { RaceSpec } from '../../shared/contracts/race.ts';
import type { AgentArenaRequest } from '../../shared/contracts/race.ts';
import { clock } from '../../shared/clock.ts';
import { githubRepoSlugFromRemote } from '../github/core/team-review-core.ts';
import { repoParts } from '../../shared/contracts/github-ids.ts';
import { createKeyedSerialQueue } from '../spawn-gate.ts';

const SAFE_LAUNCH_ARGUMENT_PATTERN = /^[A-Za-z0-9._:/[\]-]+$/;
const CHECKOUT_DEADLINE_MS = 240_000;
const CLONE_BY_HAND_HINT = 'clone it by hand, then run glimmervoid checkout <absolute path>';

type CheckoutTarget =
  | { kind: 'local'; repo: string }
  | { kind: 'github'; slug: string; name: string; cloneUrl: string }
  | { kind: 'unsupported' };

type CheckoutResolution = { ok: true; repoPath: string } | { ok: false; error: string };

function githubCheckoutTarget(slug: string, cloneUrl: string): CheckoutTarget {
  return { kind: 'github', slug, name: slug.split('/')[1] ?? slug, cloneUrl };
}

function parseCheckoutTarget(repo: string): CheckoutTarget {
  if (path.isAbsolute(repo)) return { kind: 'local', repo };
  const slugFromUrl = githubRepoSlugFromRemote(repo);
  if (slugFromUrl) return githubCheckoutTarget(slugFromUrl, repo.trim());
  if (REMOTE_URL_PATTERN.test(repo)) return { kind: 'unsupported' };
  if (repoParts(repo)) return githubCheckoutTarget(repo, `https://github.com/${repo}.git`);
  return { kind: 'local', repo };
}

function isSameGithubRepo(originUrl: string | null, slug: string): boolean {
  return originUrl !== null && githubRepoSlugFromRemote(originUrl)?.toLowerCase() === slug.toLowerCase();
}

function pathExists(candidatePath: string): Promise<boolean> {
  return fs.promises.stat(candidatePath).then(() => true, () => false);
}

function hasGitFolder(folder: string): Promise<boolean> {
  return pathExists(path.join(folder, '.git'));
}

function createAgentVerbHandlers(runtime: AgentApiRuntime, channels: ChildChannels, { spawn, describeMemoryShortfall }: AgentSpawner, wakes: WakeWiring) {
  const { config, agentSessions, listAllSessions, listBoardSessions, sessionDocs, operatorState, whiteboards, lookupWhy, channelsByChildId, childIdsToDiscard, secrets, races, startRace, reviewComments, repoClones } = runtime;
  const clonesByFolder = createKeyedSerialQueue();
  const { noteEndCause, post, drain, ownedChannels, findChildOf } = channels;

  function roleFactsOf(session: Session): SessionRoleFacts {
    return {
      isEphemeral: session.ephemeral,
      isSpawnedChild: agentSessions.has(session.id) && session.id.startsWith(`${AGENT_LANE_TAG}-`),
      hasOwnWorktree: session.hasOwnWorktree,
      isRaceContestant: config.projects.some((project) => (project.id === session.id || project.id === session.ownerId) && project.raceId !== undefined),
    };
  }

  function attention(session: Session, request: AgentAttentionRequest): AgentReplyOf<'attention'> {
    const reply: AgentAttentionReply = session.raiseAttention('agent', request.note);
    return { status: reply.ok ? 200 : 429, body: reply };
  }

  function liveSessionRows(): AgentBoardRow[] {
    return listBoardSessions().map((session) => ({
      id: session.id,
      name: session.name,
      agent: session.agentId,
      state: session.state,
      ephemeral: session.ephemeral,
    }));
  }

  function limits(session: Session): AgentLimitsReply {
    return { ok: true, ...describeSessionLimits(roleFactsOf(session)) };
  }

  async function push(session: Session): Promise<AgentReplyOf<'push'>> {
    return describePushLanding(await session.mergeAndContinue({ force: true }));
  }

  function refusal(status: number, error: string): AgentRefusalReply {
    return { status, body: { ok: false, error } };
  }

  async function review(pullRequestKey: string): Promise<AgentReplyOf<'review'>> {
    if (!operatorState) return refusal(503, 'team review is not available in this Glimmervoid');
    const separatorIndex = pullRequestKey.lastIndexOf('#');
    const outcome = await operatorState.requestReview({ repo: pullRequestKey.slice(0, separatorIndex), number: Number(pullRequestKey.slice(separatorIndex + 1)) });
    if (!outcome.ok) return refusal(409, outcome.error);
    return { status: 200, body: { ...outcome, note: 'the review lands as a draft in the Reviews tab, and only the operator can post it' } };
  }

  function reviews(pullRequestKey: string | null): AgentReplyOf<'reviews'> {
    if (!operatorState) return githubLanesUnavailable();
    const status = operatorState.teamReviewStatus();
    if (pullRequestKey === null) return { status: 200, body: projectReviews(status) };
    const detail = projectReviewDetail(status, pullRequestKey);
    if (!detail) return refusal(404, `${pullRequestKey} is not in the Reviews tab, so queue one with review action review for pr ${pullRequestKey}`);
    return { status: 200, body: detail };
  }

  function linkPr(session: Session, pullRequestKey: string): AgentReplyOf<'link-pr'> {
    const link = manualPrLink(pullRequestKey, operatorState?.myPrsStatus()?.prs ?? [], clock.nowMs());
    if (!link) return refusal(400, `not a GitHub pull request: ${pullRequestKey}`);
    session.linkPrManually(link);
    return { status: 200, body: { ok: true, key: `${link.repo}#${link.number}`, url: link.url } };
  }

  function settings(request: AgentSettingsRequest): AgentReplyOf<'settings'> {
    if (!operatorState) return refusal(503, 'settings are not available in this Glimmervoid');
    const reply = operatorState.readSettings(request);
    return { status: reply.ok ? 200 : 400, body: reply };
  }

  async function packs(session: Session, request: AgentPacksRequest): Promise<AgentReplyOf<'packs'>> {
    if (!operatorState) return refusal(503, 'packs are not available in this Glimmervoid');
    const packPath = request.path === undefined ? undefined : path.resolve(session.effectiveCwd(), request.path);
    const reply = await operatorState.readPacks({ command: request.command, ...(packPath === undefined ? {} : { path: packPath }) });
    return { status: 200, body: { ok: true, ...reply } };
  }

  async function comments(session: Session, request: AgentCommentsRequest): Promise<AgentReplyOf<'comments'>> {
    if (!reviewComments) return refusal(503, 'review comments are not available in this Glimmervoid');
    if (request.command === 'list') {
      const state = await reviewComments.read(session.id);
      if (!state) return refusal(503, 'the saved review for this session could not be read');
      const rows = openComments(state).map(({ id, path, line, side, text }) => ({ id, path, line, side, text }));
      return { status: 200, body: { ok: true, comments: rows } };
    }
    const commentId = request.commentId ?? '';
    const outcome = request.command === 'reply'
      ? await reviewComments.reply(session.id, commentId, request.text ?? '')
      : await reviewComments.resolve(session.id, commentId, 'agent');
    return outcome.ok ? { status: 200, body: { ok: true } } : refusal(409, outcome.error);
  }

  async function why(session: Session, target: string): Promise<AgentReplyOf<'why'>> {
    if (!lookupWhy) return refusal(503, 'why is not available in this Glimmervoid');
    const lookup = await lookupWhy({ target, cwd: session.effectiveCwd() });
    if (!lookup.ok) return refusal(lookup.status, lookup.error);
    return { status: 200, body: { ok: true, text: lookup.text } };
  }

  async function edit(session: Session, request: AgentEditRequest): Promise<AgentReplyOf<'edit'>> {
    const reply = await sessionDocs.surface(session, request);
    if (!reply.ok) return { status: 400, body: reply };
    return { status: 200, body: { ok: true, path: reply.doc.path, name: reply.doc.name } };
  }

  async function spawnReply(session: Session, request: AgentSpawnRequest): Promise<AgentReplyOf<'spawn'>> {
    const outcome = await spawn(session, request);
    if (!outcome.ok) return { status: outcome.status, body: { ok: false, error: outcome.error } };
    const note = `this session owns ${outcome.name} until the task is done: glimmervoid read ${outcome.sessionId} reads its messages, glimmervoid send ${outcome.sessionId} <text> steers it, and glimmervoid close ${outcome.sessionId} ends it and discards its worktree, refusing while it holds work that is not on the integration branch unless you add --discard`;
    return { status: 200, body: { ok: true, sessionId: outcome.sessionId, name: outcome.name, note } };
  }

  function send(session: Session, { words }: AgentSendRequest): AgentReplyOf<'send'> {
    const at = clock.nowMs();
    if (channelsByChildId.has(session.id)) {
      post(session.id, 'toParent', { author: 'child', text: words.join(' '), at, wakes: true });
      return { status: 200, body: { ok: true } };
    }
    const [target = '', ...textWords] = words;
    const text = textWords.join(' ').trim();
    if (!text) return refusal(400, 'send needs the spawned session and the text, for example glimmervoid send <child> fix the failing test');
    const owned = findChildOf(session, target);
    if (!owned.ok) return refusal(404, owned.error);
    if (!agentSessions.has(owned.channel.childId)) return refusal(409, `${owned.channel.childName} has ended, so nothing was sent`);
    post(owned.channel.childId, 'toChild', { author: 'parent', text, at, wakes: true });
    return { status: 200, body: { ok: true } };
  }

  function read(session: Session, { child }: AgentReadRequest): AgentReplyOf<'read'> {
    if (channelsByChildId.has(session.id)) {
      const fromParent = drain(session.id, 'toChild');
      return { status: 200, body: { ok: true, channels: fromParent ? [fromParent] : [] } };
    }
    if (child === undefined) {
      const channels = ownedChannels(session).flatMap((channel) => drain(channel.childId, 'toParent') ?? []);
      return { status: 200, body: { ok: true, channels } };
    }
    const owned = findChildOf(session, child);
    if (!owned.ok) return refusal(404, owned.error);
    const fromChild = drain(owned.channel.childId, 'toParent');
    return { status: 200, body: { ok: true, channels: fromChild ? [fromChild] : [] } };
  }

  function answer(session: Session, request: AgentAnswerRequest): AgentReplyOf<'answer'> {
    const owned = findChildOf(session, request.child);
    if (!owned.ok) return refusal(404, owned.error);
    const child = agentSessions.get(owned.channel.childId);
    if (!child) return refusal(409, `${owned.channel.childName} has already ended`);
    const approval = child._conversationApproval;
    if (approval?.kind !== 'question') return refusal(409, `${owned.channel.childName} has no held question`);
    if ('toOperator' in request) {
      if (typeof approval.requestId !== 'string' || !child.releaseQuestionHold(approval.requestId)) return refusal(409, 'the question is no longer held');
      return { status: 200, body: { ok: true } };
    }
    if (approval.isSummaryTruncated) return refusal(409, `${owned.channel.childName}'s question is too large to answer here; pass it to the operator with session answer, child ${request.child} and toOperator set`);
    if (!child.answerConversationApproval(approval.requestId, request.answers)) {
      const expectedQuestions = (approval.questions ?? []).map((question) => question.question);
      return refusal(409, `answers must match the expected question texts: ${JSON.stringify(expectedQuestions)}`);
    }
    return { status: 200, body: { ok: true } };
  }

  async function close(session: Session, { child, discard = false }: AgentCloseRequest): Promise<AgentReplyOf<'close'>> {
    const owned = findChildOf(session, child);
    if (!owned.ok) return refusal(404, owned.error);
    const childSession = agentSessions.get(owned.channel.childId);
    const alreadyEnded = refusal(409, `${owned.channel.childName} has already ended`);
    if (!childSession) return alreadyEnded;
    const worktree = childSession.getWorktreeCarry();
    if (!discard && worktree && await childSession.hasUnmergedWork()) {
      return refusal(409, describeUnpushedCloseRefusal(owned.channel.childName, owned.channel.childId, worktree));
    }
    if (agentSessions.get(owned.channel.childId) !== childSession) return alreadyEnded;
    if (discard) childIdsToDiscard.add(childSession.id);
    noteEndCause(childSession.id, 'parent-closed');
    childSession.destroy();
    return { status: 200, body: { ok: true, closed: owned.channel.childId } };
  }

  async function resolveLocalCheckoutRepo(repo: string): Promise<CheckoutResolution> {
    const configuredPaths = path.isAbsolute(repo)
      ? [repo]
      : config.projects.filter((project) => project.name === repo || path.basename(project.path || '') === repo).map((project) => project.path || '');
    for (const candidatePath of configuredPaths) {
      if (await hasGitFolder(candidatePath)) return { ok: true, repoPath: path.resolve(candidatePath) };
    }
    if (path.isAbsolute(repo)) return { ok: false, error: `${repo} is not a git repository` };
    return { ok: false, error: `no configured project is named ${repo}; pass a project name, an absolute path to a git repository, or a GitHub owner/repo` };
  }

  async function claimRepoRootFolder(folder: string, slug: string, clones: NonNullable<typeof repoClones>): Promise<CheckoutResolution> {
    if (!(await hasGitFolder(folder))) return { ok: false, error: `${folder} exists but is not a git repository, so ${slug} cannot be cloned there; move it, or ${CLONE_BY_HAND_HINT}` };
    const originUrl = await clones.originUrl({ projectPath: folder });
    if (isSameGithubRepo(originUrl, slug)) return { ok: true, repoPath: folder };
    return { ok: false, error: `${folder} holds ${originUrl ?? 'a repository with no origin'}, not ${slug}; move it, or ${CLONE_BY_HAND_HINT}` };
  }

  async function findOrCloneInRepoRoots(target: Extract<CheckoutTarget, { kind: 'github' }>, repoRoots: string[], cloneFolder: string, deadlineMs: number, clones: NonNullable<typeof repoClones>): Promise<CheckoutResolution> {
    for (const root of repoRoots) {
      const folder = path.join(root, target.name);
      if (await pathExists(folder)) return claimRepoRootFolder(folder, target.slug, clones);
    }
    const remainingMs = deadlineMs - clock.nowMs();
    if (remainingMs <= 0) return { ok: false, error: `another checkout of ${target.slug} used up this request's time and its clone failed; try again, or ${CLONE_BY_HAND_HINT}` };
    const cloned = await clones.cloneRepository({ url: target.cloneUrl, targetPath: cloneFolder, timeoutMs: remainingMs });
    if (!cloned.ok) return { ok: false, error: `cloning ${target.cloneUrl} into ${cloneFolder} failed: ${cloned.error}; ${CLONE_BY_HAND_HINT}` };
    return { ok: true, repoPath: cloneFolder };
  }

  async function resolveGithubCheckoutRepo(target: Extract<CheckoutTarget, { kind: 'github' }>): Promise<CheckoutResolution> {
    if (!repoClones) return { ok: false, error: `this Glimmervoid cannot clone repositories; ${CLONE_BY_HAND_HINT}` };
    const deadlineMs = clock.nowMs() + CHECKOUT_DEADLINE_MS;
    const projectPaths = config.projects.map((project) => project.path || '').filter((projectPath) => projectPath !== '');
    for (const projectPath of projectPaths) {
      if (!(await hasGitFolder(projectPath))) continue;
      if (isSameGithubRepo(await repoClones.originUrl({ projectPath }), target.slug)) return { ok: true, repoPath: path.resolve(projectPath) };
    }
    const repoRoots = (config.repoRoots ?? []).map((root) => path.resolve(root));
    if (repoRoots.length === 0) return { ok: false, error: `${target.slug} is not on this machine and no repo root is set to clone it into; add a folder to repoRoots in Settings, or ${CLONE_BY_HAND_HINT}` };
    const cloneFolder = path.join(repoRoots[0] ?? '', target.name);
    return clonesByFolder.run(cloneFolder.toLowerCase(), () => findOrCloneInRepoRoots(target, repoRoots, cloneFolder, deadlineMs, repoClones));
  }

  function resolveCheckoutRepo(repo: string): Promise<CheckoutResolution> {
    const target = parseCheckoutTarget(repo);
    if (target.kind === 'unsupported') return Promise.resolve({ ok: false, error: `checkout clones GitHub repositories only; ${CLONE_BY_HAND_HINT}` });
    if (target.kind === 'github') return resolveGithubCheckoutRepo(target);
    return resolveLocalCheckoutRepo(target.repo);
  }

  async function checkout(session: Session, { repo }: AgentCheckoutRequest): Promise<AgentReplyOf<'checkout'>> {
    const resolved = await resolveCheckoutRepo(repo);
    if (!resolved.ok) return refusal(404, resolved.error);
    const checkoutRoot = configuredWorktreeRoot(config, resolved.repoPath);
    const added = await session.addCheckout({ repoPath: resolved.repoPath, checkoutRoot });
    if (!added.ok) return refusal(409, added.error);
    return { status: 200, body: added };
  }

  let isAgentRaceStarting = false;

  function hasContestantOutsideOperatorHome(spec: Record<string, unknown>): boolean {
    if (!Array.isArray(spec.contestants)) return false;
    return spec.contestants.some((contestant) => isRecord(contestant) && contestant.home !== undefined && contestant.home !== 'operator');
  }

  function unsafeLaunchArgumentOf(candidateSpec: Record<string, unknown>): string | null {
    const parsed = RaceSpec.safeParse(candidateSpec);
    if (!parsed.success) return null;
    const setups = [...parsed.data.contestants, ...parsed.data.judges].map((entry) => entry.setup);
    const launchValues = setups.flatMap((setup) => [...(setup.model === null ? [] : [setup.model]), ...setup.options.map((option) => option.value)]);
    return launchValues.find((value) => !SAFE_LAUNCH_ARGUMENT_PATTERN.test(value)) ?? null;
  }

  function refuseUnfinishedRace(): AgentRefusalReply | null {
    if (isAgentRaceStarting) return refusal(409, 'another agent is starting an Arena race, and an agent may start a race only when none is unfinished');
    const liveSessionIds = new Set(listAllSessions().map((session) => session.id));
    const unfinishedRace = races?.status().races.find((race) => race.winnerContestantId === null && Object.values(race.sessionIdByContestant).some((sessionId) => liveSessionIds.has(sessionId)));
    if (!unfinishedRace) return null;
    return refusal(409, `race ${unfinishedRace.id} still has contestant sessions open and no winner, and an agent may start a race only when none is unfinished`);
  }

  async function startArenaRace(session: Session, spec: Record<string, unknown>): Promise<AgentReplyOf<'arena'>> {
    if (roleFactsOf(session).isSpawnedChild) return refusal(403, 'a spawned session cannot start an Arena race, because every contestant is a new operator session');
    if (spec.check !== undefined && spec.check !== null) return refusal(403, 'an agent cannot set a race check, because Glimmervoid runs it outside every session\'s permission prompts; the operator can add one in the Arena tab');
    if (hasContestantOutsideOperatorHome(spec)) return refusal(403, 'an agent cannot race a contestant in a clean home, because a clean home drops the operator\'s own denied tools and hooks; the operator can choose one in the Arena tab');
    const raceSpec = { ...spec, version: 1, repoPath: session.path };
    const unsafeLaunchArgument = unsafeLaunchArgumentOf(raceSpec);
    if (unsafeLaunchArgument !== null) return refusal(400, `an agent cannot race the model or option value "${unsafeLaunchArgument}", because it reaches the agent's command line; use letters, digits and . _ : / [ ] -`);
    if (!startRace) return refusal(503, 'Arena is not running in this Glimmervoid');
    const unfinishedRefusal = refuseUnfinishedRace();
    if (unfinishedRefusal) return unfinishedRefusal;
    isAgentRaceStarting = true;
    try {
      const memoryShortfall = await describeMemoryShortfall();
      if (memoryShortfall) return refusal(503, memoryShortfall);
      const started = await startRace(raceSpec, { dangerouslySkipPermissions: session.dangerouslySkipPermissions, saneYolo: session.saneYolo });
      return started.ok ? { status: 200, body: { ok: true, raceId: started.raceId, warning: started.error } } : refusal(409, started.error);
    } finally {
      isAgentRaceStarting = false;
    }
  }

  async function arena(session: Session, request: AgentArenaRequest): Promise<AgentReplyOf<'arena'>> {
    if (!races) return refusal(503, 'Arena is not running in this Glimmervoid');
    if (request.sub === 'start') return startArenaRace(session, request.spec);
    if (request.sub === 'races') return { status: 200, body: { ok: true, races: races.status().races } };
    if (request.sub === 'race') {
      const race = races.status().races.find((candidate) => candidate.id === request.race);
      return race ? { status: 200, body: { ok: true, race } } : refusal(404, `no loaded race is named ${request.race}`);
    }
    if (request.sub === 'judge') {
      const judged = await races.judge(request.race);
      return judged.ok ? { status: 200, body: { ok: true } } : refusal(409, judged.error);
    }
    const diff = await races.contestantDiffText(request.race, request.contestant);
    return diff.ok ? { status: 200, body: { ok: true, diff: diff.diff } } : refusal(404, diff.error);
  }

  function githubLanesUnavailable(): AgentRefusalReply {
    return refusal(503, 'GitHub lanes are not available in this Glimmervoid');
  }

  const handlers: AgentVerbHandlers = {
    spawn: spawnReply,
    send,
    read,
    close,
    answer,
    attention,
    sessions: () => ({ status: 200, body: { ok: true, sessions: liveSessionRows() } }),
    push,
    edit,
    limits: (session) => ({ status: 200, body: limits(session) }),
    review: (_session, { pullRequestKey }) => review(pullRequestKey),
    reviews: (_session, { pullRequestKey }) => reviews(pullRequestKey),
    prs: () => (operatorState ? { status: 200, body: projectMyPrs(operatorState.myPrsStatus()) } : githubLanesUnavailable()),
    'link-pr': (session, { pullRequestKey }) => linkPr(session, pullRequestKey),
    settings: (_session, request) => settings(request),
    why: (session, { target }) => why(session, target),
    comments,
    checkout,
    packs,
    need: async (session, { names }) => (secrets ? { status: 200, body: await secrets.need({ id: session.id, project: session.path, cwd: session.effectiveCwd() }, names) } : refusal(503, 'secrets are not available in this Glimmervoid')),
    arena,
    wake: (session, request) => wakes.handleAgent(session, request),
    whiteboard: (session, request) => (whiteboards ? whiteboards.handleAgent({ id: session.id, name: session.name, project: session.path, cwd: session.effectiveCwd() }, request) : refusal(503, 'whiteboards are not available in this Glimmervoid')),
  };

  return { handlers, roleFactsOf };
}

export { createAgentVerbHandlers };
