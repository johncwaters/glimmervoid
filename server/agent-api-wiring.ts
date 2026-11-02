import crypto from 'node:crypto';

import { isKnownAgentId } from '../session/adapters/index.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { describeSessionLimits } from '../session/core/session-routes.ts';
import type { SessionRoleFacts } from '../session/core/session-routes.ts';
import type { Session } from '../session/sessions.ts';
import type {
  AgentAnswerRequest, AgentApiVerb, AgentAttentionReply, AgentAttentionRequest, AgentBoardRow, AgentCloseRequest, AgentEditRequest, AgentLimitsReply, AgentReadReply, AgentReadRequest, ConversationApproval,
  AgentSendRequest, AgentSettingsReply, AgentSettingsRequest, AgentSpawnRequest, SessionLimits,
} from '../shared/contracts/session.ts';
import type { MyPrsSnapshot } from '../shared/contracts/my-prs.ts';
import type { TeamReviewStatus } from '../shared/contracts/team-review.ts';
import { manualPrLink } from '../session/core/session-pr-links-core.ts';
import type { GlimmervoidConfig, ProjectEntry } from './config-store.ts';
import type { ControlMessageRecord } from './core/control-replay-core.ts';
import {
  checkAgentReply, decideSpawnAllowance, deriveChildSessionName, describeChildEndNote, describeKeptChildAttention, describePushLanding, describeRoleRefusal,
  describeUnpushedCloseRefusal, parseAgentVerb, projectMyPrs, projectReviewDetail, projectReviews,
} from './core/agent-api-core.ts';
import type { AgentRefusalReply, AgentReplyOf, AgentRequestOf, ChildEndCause, ChildWorktree } from './core/agent-api-core.ts';
import {
  canSubmitWake, decideWake, describeQuestionNote, describeStopNote, describeWakeCapNote, describeWakeLine, drainChannel, findOwnedChild, hasWakingUnread,
  openChannel, postToChannel, readLastAssistantMessage, shouldPostStopNote, shouldStopNoteWake, withdrawUnreadNote,
} from './core/child-channel-core.ts';
import type { AgentChannel, ChannelEntry, ChannelSide } from './core/child-channel-core.ts';
import { registerEphemeralSession } from './lanes/ephemeral-session.ts';
import type { RecordLane, SpawnGate } from './lanes/ephemeral-session.ts';
import type { SessionSpawnOverrides } from './session/session-factory.ts';
import type { SessionDocsPort } from './session/session-docs-wiring.ts';
import type { MemoryAdmission } from './spawn-gate.ts';
import type { WhiteboardPort } from './whiteboard/whiteboard-wiring.ts';
import { errorMessage } from '../shared/text.ts';
import { STATES } from '../shared/states.ts';
import type { SessionState } from '../shared/states.ts';
import { DEFAULT_TIMER_FNS, unrefTimer } from '../shared/timer-deps.ts';
import type { ClearTimeoutFn, SetTimeoutFn, TimerHandle } from '../shared/timer-deps.ts';

const AGENT_LANE_TAG = 'agent-spawn';
const SPAWN_FAILED_MESSAGE = 'could not spawn the session';
const PARENT_ENDED_MESSAGE = 'this session ended before its child could start, so nothing was spawned';
const BYTES_PER_MEGABYTE = 1024 * 1024;
const WAKE_SUBMIT_DELAY_MS = 150;

type MakeSession = (
  project: ProjectEntry,
  config: GlimmervoidConfig,
  overrides?: SessionSpawnOverrides,
) => Session;

type ReviewRequestReply = { ok: true; key: string; status: 'queued' | 'running' } | { ok: false; error: string };

interface AgentOperatorStatePort {
  requestReview(reference: { repo: string; number: number }): Promise<ReviewRequestReply>;
  teamReviewStatus(): TeamReviewStatus;
  myPrsStatus(): MyPrsSnapshot | null;
  readSettings(request: AgentSettingsRequest): AgentSettingsReply;
}

interface AgentApiWiringOptions {
  config: GlimmervoidConfig;
  agentSessions: Map<string, Session>;
  listAllSessions: () => Session[];
  listBoardSessions: () => Session[];
  makeSession: MakeSession;
  wireSessionEvents: (session: Session) => void;
  closeSessionDataClients: (id: string) => void;
  broadcastControl: (message: ControlMessageRecord) => void;
  spawnGate: SpawnGate;
  recordLane?: RecordLane | null;
  sessionDocs: SessionDocsPort;
  memoryAdmission?: Pick<MemoryAdmission, 'describeShortfallNow'> | null;
  operatorState?: AgentOperatorStatePort | null;
  whiteboards?: Pick<WhiteboardPort, 'handleAgent'> | null;
  coderWorkspaceStatus?: (workspace: string) => string | null;
  logger?: Pick<Console, 'warn'>;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  now?: () => number;
}

interface ChannelLink {
  parent: Session;
  child: Session;
  lastChildMessage: string | null;
  waitingStopNoteText: string | null;
  hasParentRead: boolean;
  wakesSinceOperatorInput: number;
  isOperatorFlagged: boolean;
  pendingWakeSides: Set<ChannelSide>;
  retryTimersBySide: Map<ChannelSide, TimerHandle>;
}

interface StateChange {
  from: SessionState;
  to: SessionState;
}

interface HookEvent {
  event: string;
  payload: Record<string, unknown>;
}

type SpawnOutcome =
  | { ok: true; sessionId: string; name: string }
  | { ok: false; status: number; error: string };

interface AgentWireReply {
  status: number;
  body: Record<string, unknown>;
}

type AgentVerbHandlers = { readonly [V in AgentApiVerb]: (session: Session, request: AgentRequestOf<V>) => AgentReplyOf<V> | Promise<AgentReplyOf<V>> };

interface AgentApiPort {
  handle(session: Session, verb: string, payload: Record<string, unknown>): Promise<AgentWireReply>;
  refuseRole(session: Session, verb: AgentApiVerb): AgentRefusalReply | null;
  markChildWorktreeDiscard(childId: string): void;
}

function createAgentApiWiring({
  config, agentSessions, listAllSessions, listBoardSessions, makeSession, wireSessionEvents, closeSessionDataClients,
  broadcastControl, spawnGate, sessionDocs,
  recordLane = null,
  memoryAdmission = null,
  operatorState = null,
  whiteboards = null,
  coderWorkspaceStatus = () => null,
  logger = console,
  setTimeoutFn = DEFAULT_TIMER_FNS.setTimeoutFn,
  clearTimeoutFn = DEFAULT_TIMER_FNS.clearTimeoutFn,
  now = Date.now,
}: AgentApiWiringOptions): AgentApiPort {
  const channelsByChildId = new Map<string, AgentChannel>();
  const linksByChildId = new Map<string, ChannelLink>();
  const parentsWithChannelCleanup = new WeakSet<Session>();
  const sessionsWithOperatorWatch = new WeakSet<Session>();
  const lastOperatorInputAtBySession = new WeakMap<Session, number>();
  const childIdsToDiscard = new Set<string>();
  const endCauseByChildId = new Map<string, ChildEndCause>();

  function noteEndCause(childId: string, cause: ChildEndCause): void {
    if (!endCauseByChildId.has(childId)) endCauseByChildId.set(childId, cause);
  }

  function forgetLink(childId: string): void {
    const link = linksByChildId.get(childId);
    if (link) for (const timer of link.retryTimersBySide.values()) clearTimeoutFn(timer);
    linksByChildId.delete(childId);
    channelsByChildId.delete(childId);
  }

  function forgetChannelsOf(parent: Session): void {
    for (const [childId, channel] of channelsByChildId) {
      if (channel.parentId === parent.id) forgetLink(childId);
    }
  }

  function recipientOf(link: ChannelLink, side: ChannelSide): Session {
    return side === 'toParent' ? link.parent : link.child;
  }

  function scheduleWakeRetry(childId: string, link: ChannelLink, side: ChannelSide, retryInMs: number): void {
    const earlierTimer = link.retryTimersBySide.get(side);
    if (earlierTimer) clearTimeoutFn(earlierTimer);
    link.retryTimersBySide.set(side, unrefTimer(setTimeoutFn(() => {
      link.retryTimersBySide.delete(side);
      wakeRecipient(childId, side);
    }, retryInMs)));
  }

  function typeWakeLine(link: ChannelLink, channel: AgentChannel, side: ChannelSide, recipient: Session): void {
    if (!recipient.pasteText(describeWakeLine(channel, side)).ok) return;
    const pastedAt = now();
    link.pendingWakeSides.add(side);
    unrefTimer(setTimeoutFn(() => {
      link.pendingWakeSides.delete(side);
      if (recipient._destroyed) return;
      const lastOperatorInputAt = lastOperatorInputAtBySession.get(recipient) ?? Number.NEGATIVE_INFINITY;
      if (!canSubmitWake({ recipientState: recipient.state, pastedAt, lastOperatorInputAt })) return;
      recipient.write('\r');
      link.wakesSinceOperatorInput += 1;
    }, WAKE_SUBMIT_DELAY_MS));
  }

  function wakeRecipient(childId: string, side: ChannelSide): void {
    const link = linksByChildId.get(childId);
    const channel = channelsByChildId.get(childId);
    if (!link || !channel) return;
    const recipient = recipientOf(link, side);
    if (recipient._destroyed) return;
    const decision = decideWake({
      recipientState: recipient.state,
      hasUnread: hasWakingUnread(channel[side]),
      isWakePending: link.pendingWakeSides.has(side),
      isOperatorFlagged: link.isOperatorFlagged,
      wakesSinceOperatorInput: link.wakesSinceOperatorInput,
      msSinceOperatorInput: now() - (lastOperatorInputAtBySession.get(recipient) ?? Number.NEGATIVE_INFINITY),
    });
    switch (decision.kind) {
      case 'none':
        return;
      case 'hold':
        scheduleWakeRetry(childId, link, side, decision.retryInMs);
        return;
      case 'flag-operator':
        link.isOperatorFlagged = true;
        recipient.noteAttention(describeWakeCapNote(channel));
        return;
      case 'wake':
        typeWakeLine(link, channel, side, recipient);
        return;
    }
  }

  function linksOf(session: Session): ChannelLink[] {
    return [...linksByChildId.values()].filter((link) => link.parent === session || link.child === session);
  }

  function watchOperatorInput(session: Session): void {
    if (sessionsWithOperatorWatch.has(session)) return;
    sessionsWithOperatorWatch.add(session);
    session.on('operator-input', () => {
      lastOperatorInputAtBySession.set(session, now());
      for (const link of linksOf(session)) {
        link.wakesSinceOperatorInput = 0;
        link.isOperatorFlagged = false;
      }
    });
  }

  function withdrawWaitingStopNote(childId: string, link: ChannelLink): void {
    const channel = channelsByChildId.get(childId);
    if (!channel || link.waitingStopNoteText === null) return;
    channelsByChildId.set(childId, withdrawUnreadNote(channel, 'toParent', link.waitingStopNoteText));
    link.waitingStopNoteText = null;
  }

  function watchChild(link: ChannelLink, childId: string): void {
    let lastRelayedQuestionId: ConversationApproval['requestId'] | null = null;
    link.child.on('conversation-change', ({ conversationApproval }: { conversationApproval: ConversationApproval | null }) => {
      if (conversationApproval?.kind !== 'question' || conversationApproval.requestId === lastRelayedQuestionId) return;
      lastRelayedQuestionId = conversationApproval.requestId;
      withdrawWaitingStopNote(childId, link);
      const text = describeQuestionNote(link.child.name, childId, conversationApproval);
      post(childId, 'toParent', { author: 'glimmervoid', text, at: now(), wakes: true });
    });
    link.child.on('hook-event', ({ event, payload }: HookEvent) => {
      if (event.toLowerCase() !== 'stop') return;
      link.lastChildMessage = readLastAssistantMessage(payload);
    });
    link.child.on('state-change', ({ from, to }: StateChange) => {
      const isHeldQuestionWaiting = to === STATES.WAITING && link.child._conversationApproval?.kind === 'question';
      if (!isHeldQuestionWaiting && shouldPostStopNote(from, to)) {
        const text = describeStopNote({ childName: link.child.name, state: to, lastMessage: link.lastChildMessage });
        post(childId, 'toParent', { author: 'glimmervoid', text, at: now(), wakes: shouldStopNoteWake(to, link.hasParentRead) });
        link.lastChildMessage = null;
        link.waitingStopNoteText = to === STATES.WAITING ? text : null;
      }
      wakeRecipient(childId, 'toParent');
      wakeRecipient(childId, 'toChild');
    });
  }

  function openChildChannel(parent: Session, child: Session, childName: string): () => void {
    channelsByChildId.set(child.id, openChannel({ parentId: parent.id, childId: child.id, childName }));
    const link: ChannelLink = {
      parent, child, lastChildMessage: null, waitingStopNoteText: null, hasParentRead: false, wakesSinceOperatorInput: 0, isOperatorFlagged: false, pendingWakeSides: new Set(), retryTimersBySide: new Map(),
    };
    linksByChildId.set(child.id, link);
    watchChild(link, child.id);
    watchOperatorInput(parent);
    watchOperatorInput(child);
    if (!parentsWithChannelCleanup.has(parent)) {
      parentsWithChannelCleanup.add(parent);
      parent.once('teardown', () => forgetChannelsOf(parent));
    }
    const closeChildWithParent = () => {
      noteEndCause(child.id, 'parent-ended');
      child.destroy();
    };
    const wakeParent = () => wakeRecipient(child.id, 'toParent');
    parent.on('exit', closeChildWithParent);
    parent.on('teardown', closeChildWithParent);
    parent.on('state-change', wakeParent);
    return () => {
      parent.off('exit', closeChildWithParent);
      parent.off('teardown', closeChildWithParent);
    };
  }

  async function keepOrDiscardChildWorktree(child: Session, worktree: ChildWorktree | null, isParentRemoved: boolean): Promise<boolean> {
    const isDiscardRequested = childIdsToDiscard.delete(child.id);
    if (!worktree) return false;
    if (isDiscardRequested || isParentRemoved) {
      await child.discardWorktree();
      return false;
    }
    return !(await child.discardWorktreeIfClean());
  }

  async function settleChildWorktree(
    parentId: string, child: Session, childName: string, startAttempt: Promise<unknown>, worktreeAtStart: ChildWorktree | null,
  ): Promise<void> {
    try {
      await startAttempt.catch(() => {});
      await child._awaitPendingReaps();
      const worktree = child.getWorktreeCarry();
      const registeredParent = listAllSessions().find((session) => session.id === parentId);
      const isKept = await keepOrDiscardChildWorktree(child, worktree, !registeredParent);
      const cause = endCauseByChildId.get(child.id) ?? 'operator';
      endCauseByChildId.delete(child.id);
      if (registeredParent && worktree && isKept) {
        logger.warn(`[${AGENT_LANE_TAG} ${childName}] kept a worktree with unpushed work: ${worktree.worktreeDir}`);
        registeredParent.noteAttention(describeKeptChildAttention(childName, worktree));
        post(child.id, 'toParent', { author: 'glimmervoid', text: describeChildEndNote(childName, cause, { kind: 'kept', worktree }), at: now(), wakes: true });
        return;
      }
      if (cause === 'parent-closed') return;
      const kind = worktree || worktreeAtStart ? 'discarded' : 'none';
      const hasParentRead = linksByChildId.get(child.id)?.hasParentRead ?? false;
      post(child.id, 'toParent', { author: 'glimmervoid', text: describeChildEndNote(childName, cause, { kind }), at: now(), wakes: !hasParentRead });
    } catch (error) {
      logger.warn(`[${AGENT_LANE_TAG} ${childName}] could not settle the worktree: ${errorMessage(error)}`);
    }
  }

  function post(childId: string, side: ChannelSide, entry: ChannelEntry): void {
    const channel = channelsByChildId.get(childId);
    if (!channel) return;
    channelsByChildId.set(childId, postToChannel(channel, side, entry));
    wakeRecipient(childId, side);
  }

  function drain(childId: string, side: ChannelSide): AgentReadReply['channels'][number] | null {
    const channel = channelsByChildId.get(childId);
    if (!channel) return null;
    const { channel: drainedChannel, drained } = drainChannel(channel, side);
    channelsByChildId.set(childId, drainedChannel);
    const link = linksByChildId.get(childId);
    if (link && side === 'toParent' && drained.entries.length > 0) link.hasParentRead = true;
    const peerId = side === 'toParent' ? channel.childId : channel.parentId;
    const peerName = side === 'toParent' ? channel.childName : (listAllSessions().find((session) => session.id === channel.parentId)?.name ?? channel.parentId);
    return {
      sessionId: peerId,
      name: peerName,
      entries: drained.entries.map(({ author, at, text }) => ({ from: author, at, text })),
      dropped: drained.droppedCount,
    };
  }

  function ownedChannels(parent: Session): AgentChannel[] {
    return [...channelsByChildId.values()].filter((channel) => channel.parentId === parent.id);
  }

  function findChildOf(parent: Session, target: string) {
    return findOwnedChild(ownedChannels(parent), parent.id, target);
  }

  async function describeMemoryShortfall(): Promise<string | null> {
    const shortfall = await memoryAdmission?.describeShortfallNow('session') ?? null;
    if (shortfall === null) return null;
    const toMegabytes = (bytes: number) => Math.round(bytes / BYTES_PER_MEGABYTE);
    const heldDetails = [
      ...(shortfall.heldBytes > 0 ? [`${toMegabytes(shortfall.heldBytes)} MB held for recent starts`] : []),
      ...(shortfall.waitingStartCount > 0 ? [`${shortfall.waitingStartCount} ${shortfall.waitingStartCount === 1 ? 'start' : 'starts'} already waiting for memory`] : []),
    ];
    const heldClause = heldDetails.length > 0 ? ` (${heldDetails.join(', ')})` : '';
    return `memory is low: ${toMegabytes(shortfall.headroomBytes)} MB free${heldClause}, and a new session needs ${toMegabytes(shortfall.reserveBytes)} MB. Try again once other work finishes`;
  }

  function refuseByBudget(parent: Session): SpawnOutcome | null {
    const allowance = decideSpawnAllowance(parent.agentSpawnBudget());
    if (allowance.ok) return null;
    return { ok: false, status: allowance.status, error: allowance.reason };
  }

  async function describeMemoryShortfallWhileParentLives(parent: Session): Promise<{ hasParentEnded: boolean; memoryShortfall: string | null }> {
    let hasParentEnded = parent._destroyed;
    const noteParentEnded = () => { hasParentEnded = true; };
    parent.on('exit', noteParentEnded);
    parent.on('teardown', noteParentEnded);
    try {
      const memoryShortfall = await describeMemoryShortfall();
      return { hasParentEnded: hasParentEnded || parent._destroyed, memoryShortfall };
    } finally {
      parent.off('exit', noteParentEnded);
      parent.off('teardown', noteParentEnded);
    }
  }

  async function spawn(parent: Session, request: AgentSpawnRequest): Promise<SpawnOutcome> {
    const budgetRefusal = refuseByBudget(parent);
    if (budgetRefusal) return budgetRefusal;
    if (request.agent && !isKnownAgentId(request.agent)) {
      return { ok: false, status: 400, error: `unknown agent ${request.agent}` };
    }
    const agentId = request.agent || parent.agentId;
    const { hasParentEnded, memoryShortfall } = await describeMemoryShortfallWhileParentLives(parent);
    if (hasParentEnded) return { ok: false, status: 409, error: PARENT_ENDED_MESSAGE };
    if (memoryShortfall) return { ok: false, status: 503, error: memoryShortfall };
    const budgetRefusalAfterMemoryRead = refuseByBudget(parent);
    if (budgetRefusalAfterMemoryRead) return budgetRefusalAfterMemoryRead;
    const budget = parent.agentSpawnBudget();

    const existingNames = listAllSessions().map((session) => session.name);
    const name = deriveChildSessionName({ requestedName: request.name, brief: request.prompt, parentName: parent.name }, existingNames);
    const id = `${AGENT_LANE_TAG}-${crypto.randomUUID()}`;
    const project: ProjectEntry = {
      id,
      name,
      path: parent.path,
      dangerouslySkipPermissions: parent.dangerouslySkipPermissions,
      saneYolo: parent.saneYolo,
    };

    let child: Session | null = null;
    let worktreeAtStart: ChildWorktree | null = null;
    let startAttempt: Promise<unknown> = Promise.resolve();
    let released = false;
    let detachFromParent = () => {};
    const releaseChildSlot = () => {
      if (released) return;
      released = true;
      detachFromParent();
      parent.noteAgentChildExit();
      broadcastControl({ type: 'session-removed', id, session: name });
      if (child) void settleChildWorktree(parent.id, child, name, startAttempt, worktreeAtStart);
    };
    const abandonChild = (reason: string): SpawnOutcome => {
      logger.warn(`[${AGENT_LANE_TAG} ${name}] ${reason}`);
      child?.destroy();
      releaseChildSlot();
      forgetLink(id);
      return { ok: false, status: 500, error: SPAWN_FAILED_MESSAGE };
    };

    parent.beginAgentSpawn();
    try {
      const spawned = makeSession(project, config, {
        agent: agentId,
        agentDepth: budget.depth + 1,
        ownerId: parent.id,
        holdsQuestionsForParent: true,
        ephemeral: true,
        initialPrompt: request.prompt,
      });
      child = spawned;
      detachFromParent = openChildChannel(parent, spawned, name);
      wireSessionEvents(spawned);
      registerEphemeralSession({
        map: agentSessions, id, sess: spawned, closeSessionDataClients, logPrefix: AGENT_LANE_TAG, name, recordLane,
      });
      spawned.on('exit', () => { if (!released) noteEndCause(id, 'exited'); });
      spawned.on('teardown', () => { if (!released) noteEndCause(id, 'operator'); });
      spawned.on('exit', releaseChildSlot);
      spawned.on('teardown', releaseChildSlot);
      startAttempt = spawnGate.run(() => {
        if (spawned._destroyed) return undefined;
        broadcastControl({
          type: 'session-added',
          ...projectSessionCard(spawned, { id, name }),
        });
        return spawned.start();
      });
      await startAttempt;
      if (!spawned.hasLivePty) return abandonChild('the child never reached a live terminal');
      worktreeAtStart = spawned.getWorktreeCarry();
      return { ok: true, sessionId: id, name };
    } catch (error) {
      return abandonChild(`spawn failed: ${errorMessage(error)}`);
    } finally {
      parent.finishAgentSpawn();
    }
  }

  function roleFactsOf(session: Session): SessionRoleFacts {
    return {
      isEphemeral: session.ephemeral,
      isSpawnedChild: agentSessions.has(session.id) && session.id.startsWith(`${AGENT_LANE_TAG}-`),
      hasOwnWorktree: session.hasOwnWorktree,
    };
  }

  function attention(session: Session, request: AgentAttentionRequest): AgentReplyOf<'attention'> {
    const reply: AgentAttentionReply = session.noteAttention(request.note);
    return { status: reply.ok ? 200 : 429, body: reply };
  }

  function board(): AgentBoardRow[] {
    return listBoardSessions().map((session) => ({
      id: session.id,
      name: session.name,
      agent: session.agentId,
      state: session.state,
      ephemeral: session.ephemeral,
    }));
  }

  function limits(session: Session): AgentLimitsReply {
    return { ok: true, ...describeSessionLimits({ ...roleFactsOf(session), environment: environmentOf(session) }) };
  }

  function environmentOf(session: Session): SessionLimits['environment'] {
    const mapping = config.projects.find((project) => project.id === session.id)?.environment;
    if (!mapping) return null;
    return { name: mapping.name, workspace: mapping.workspace, state: coderWorkspaceStatus(mapping.workspace) ?? 'unknown' };
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
    const link = manualPrLink(pullRequestKey, operatorState?.myPrsStatus()?.prs ?? [], Date.now());
    if (!link) return refusal(400, `not a GitHub pull request: ${pullRequestKey}`);
    session.linkPrManually(link);
    return { status: 200, body: { ok: true, key: `${link.repo}#${link.number}`, url: link.url } };
  }

  function settings(request: AgentSettingsRequest): AgentReplyOf<'settings'> {
    if (!operatorState) return refusal(503, 'settings are not available in this Glimmervoid');
    const reply = operatorState.readSettings(request);
    return { status: reply.ok ? 200 : 400, body: reply };
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
    const at = Date.now();
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
    board: () => ({ status: 200, body: { ok: true, sessions: board() } }),
    push,
    edit,
    show: () => refusal(400, 'show sends the file itself; run glimmervoid show <path>'),
    limits: (session) => ({ status: 200, body: limits(session) }),
    review: (_session, { pullRequestKey }) => review(pullRequestKey),
    reviews: (_session, { pullRequestKey }) => reviews(pullRequestKey),
    prs: () => (operatorState ? { status: 200, body: projectMyPrs(operatorState.myPrsStatus()) } : githubLanesUnavailable()),
    'link-pr': (session, { pullRequestKey }) => linkPr(session, pullRequestKey),
    settings: (_session, request) => settings(request),
    whiteboard: (session, request) => (whiteboards ? whiteboards.handleAgent({ id: session.id, name: session.name }, request) : refusal(503, 'whiteboards are not available in this Glimmervoid')),
  };

  function dispatch<V extends AgentApiVerb>(session: Session, verb: V, request: AgentRequestOf<V>): AgentReplyOf<V> | Promise<AgentReplyOf<V>> {
    const handler: AgentVerbHandlers[V] = handlers[verb];
    return handler(session, request);
  }

  async function handle(session: Session, verb: string, payload: Record<string, unknown>): Promise<AgentWireReply> {
    const parsed = parseAgentVerb(verb, payload);
    if (!parsed.ok) return { status: parsed.status, body: { ok: false, error: parsed.error } };
    const roleRefusal = describeRoleRefusal(parsed.verb, roleFactsOf(session));
    if (roleRefusal) return roleRefusal;
    session.noteCommandRan(parsed.verb);
    const checked = checkAgentReply(parsed.verb, await dispatch(session, parsed.verb, parsed.request));
    if (!checked.ok) logger.warn(`[agent-api] ${parsed.verb} reply broke its contract: ${checked.issue}`);
    return checked.reply;
  }

  function markChildWorktreeDiscard(childId: string): void {
    childIdsToDiscard.add(childId);
  }

  function refuseRole(session: Session, verb: AgentApiVerb): AgentRefusalReply | null {
    return describeRoleRefusal(verb, roleFactsOf(session));
  }

  return { handle, refuseRole, markChildWorktreeDiscard };
}

export { createAgentApiWiring };
export type { AgentApiPort };
