import crypto from 'node:crypto';

import { getAdapter, isKnownAgentId } from '../session/adapters/index.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { describeSessionLimits } from '../session/core/session-routes.ts';
import type { SessionRoleFacts } from '../session/core/session-routes.ts';
import type { Session } from '../session/sessions.ts';
import type {
  AgentApiVerb, AgentAttentionReply, AgentAttentionRequest, AgentBoardRow, AgentCloseRequest, AgentEditRequest, AgentLimitsReply, AgentReadReply, AgentReadRequest,
  AgentSendRequest, AgentSettingsReply, AgentSettingsRequest, AgentSpawnRequest,
} from '../shared/contracts/session.ts';
import type { MyPrsSnapshot } from '../shared/contracts/my-prs.ts';
import type { TeamReviewStatus } from '../shared/contracts/team-review.ts';
import { manualPrLink } from '../session/core/session-pr-links-core.ts';
import type { GlimmervoidConfig, ProjectEntry } from './config-store.ts';
import type { ControlMessageRecord } from './core/control-replay-core.ts';
import {
  decideSpawnAllowance, deriveChildSessionName, describePushLanding, describeRoleRefusal, parseAgentVerb, projectMyPrs, projectReviews,
} from './core/agent-api-core.ts';
import type { AgentRequestOf } from './core/agent-api-core.ts';
import { drainChannel, findOwnedChild, openChannel, postToChannel } from './core/child-channel-core.ts';
import type { AgentChannel, ChannelEntry, ChannelSide } from './core/child-channel-core.ts';
import { isGuardedSessionVendor } from './guardrails/core/guardrails-roles-core.ts';
import { registerEphemeralSession } from './lanes/ephemeral-session.ts';
import type { RecordLane, SpawnGate } from './lanes/ephemeral-session.ts';
import type { SessionSpawnOverrides } from './session/session-factory.ts';
import type { SessionDocsPort } from './session/session-docs-wiring.ts';
import type { MemoryAdmission } from './spawn-gate.ts';
import { errorMessage } from '../shared/text.ts';

const AGENT_LANE_TAG = 'agent-spawn';
const SPAWN_FAILED_MESSAGE = 'could not spawn the session';
const PARENT_ENDED_MESSAGE = 'this session ended before its child could start, so nothing was spawned';
const BYTES_PER_MEGABYTE = 1024 * 1024;

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
  logger?: Pick<Console, 'warn'>;
}

type SpawnOutcome =
  | { ok: true; sessionId: string; name: string }
  | { ok: false; status: number; error: string };

interface AgentApiReply {
  status: number;
  body: Record<string, unknown>;
}

type AgentVerbHandlers = { readonly [V in AgentApiVerb]: (session: Session, request: AgentRequestOf<V>) => AgentApiReply | Promise<AgentApiReply> };

interface AgentApiPort {
  handle(session: Session, verb: string, payload: Record<string, unknown>): Promise<AgentApiReply>;
}

function createAgentApiWiring({
  config, agentSessions, listAllSessions, listBoardSessions, makeSession, wireSessionEvents, closeSessionDataClients,
  broadcastControl, spawnGate, sessionDocs,
  recordLane = null,
  memoryAdmission = null,
  operatorState = null,
  logger = console,
}: AgentApiWiringOptions): AgentApiPort {
  const channelsByChildId = new Map<string, AgentChannel>();
  const parentsWithChannelCleanup = new WeakSet<Session>();

  function forgetChannelsOf(parent: Session): void {
    for (const [childId, channel] of channelsByChildId) {
      if (channel.parentId === parent.id) channelsByChildId.delete(childId);
    }
  }

  function openChildChannel(parent: Session, child: Session, childName: string): () => void {
    channelsByChildId.set(child.id, openChannel({ parentId: parent.id, childId: child.id, childName }));
    if (!parentsWithChannelCleanup.has(parent)) {
      parentsWithChannelCleanup.add(parent);
      parent.once('teardown', () => forgetChannelsOf(parent));
    }
    const closeChildWithParent = () => child.destroy();
    parent.on('exit', closeChildWithParent);
    parent.on('teardown', closeChildWithParent);
    return () => {
      parent.off('exit', closeChildWithParent);
      parent.off('teardown', closeChildWithParent);
    };
  }

  function post(childId: string, side: ChannelSide, entry: ChannelEntry): void {
    const channel = channelsByChildId.get(childId);
    if (!channel) return;
    channelsByChildId.set(childId, postToChannel(channel, side, entry));
  }

  function drain(childId: string, side: ChannelSide): AgentReadReply['channels'][number] | null {
    const channel = channelsByChildId.get(childId);
    if (!channel) return null;
    const { channel: drainedChannel, drained } = drainChannel(channel, side);
    channelsByChildId.set(childId, drainedChannel);
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
    if (parent.isGuarded && !isGuardedSessionVendor(getAdapter(agentId)?.usageVendor ?? null)) {
      return { ok: false, status: 403, error: `a guarded session can only spawn a guarded agent, and ${agentId} does not run inside the guardrails` };
    }
    const { hasParentEnded, memoryShortfall } = await describeMemoryShortfallWhileParentLives(parent);
    if (hasParentEnded) return { ok: false, status: 409, error: PARENT_ENDED_MESSAGE };
    if (memoryShortfall) return { ok: false, status: 503, error: memoryShortfall };
    const budgetRefusalAfterMemoryRead = refuseByBudget(parent);
    if (budgetRefusalAfterMemoryRead) return budgetRefusalAfterMemoryRead;
    const budget = parent.agentSpawnBudget();

    const name = deriveChildSessionName(request.name || parent.name, listAllSessions().map((session) => session.name));
    const id = `${AGENT_LANE_TAG}-${crypto.randomUUID()}`;
    const project: ProjectEntry = {
      id,
      name,
      path: parent.path,
      dangerouslySkipPermissions: parent.dangerouslySkipPermissions,
      unguarded: !parent.isGuarded,
    };

    let child: Session | null = null;
    let released = false;
    let detachFromParent = () => {};
    const releaseChildSlot = () => {
      if (released) return;
      released = true;
      detachFromParent();
      parent.noteAgentChildExit();
      broadcastControl({ type: 'session-removed', id, session: name });
    };
    const abandonChild = (reason: string): SpawnOutcome => {
      logger.warn(`[${AGENT_LANE_TAG} ${name}] ${reason}`);
      child?.destroy();
      releaseChildSlot();
      channelsByChildId.delete(id);
      return { ok: false, status: 500, error: SPAWN_FAILED_MESSAGE };
    };

    parent.beginAgentSpawn();
    try {
      const spawned = makeSession(project, config, {
        agent: agentId,
        agentDepth: budget.depth + 1,
        ephemeral: true,
        initialPrompt: request.prompt,
      });
      child = spawned;
      detachFromParent = openChildChannel(parent, spawned, name);
      wireSessionEvents(spawned);
      registerEphemeralSession({
        map: agentSessions, id, sess: spawned, closeSessionDataClients, logPrefix: AGENT_LANE_TAG, name, recordLane,
      });
      spawned.on('exit', releaseChildSlot);
      spawned.on('teardown', releaseChildSlot);
      await spawnGate.run(() => {
        if (spawned._destroyed) return undefined;
        broadcastControl({
          type: 'session-added',
          ...projectSessionCard(spawned, { id, name }),
        });
        return spawned.start();
      });
      if (!spawned.hasLivePty) return abandonChild('the child never reached a live terminal');
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

  function attention(session: Session, request: AgentAttentionRequest): AgentApiReply {
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
    return { ok: true, ...describeSessionLimits({ ...roleFactsOf(session), isGuarded: session.isGuarded }) };
  }

  async function push(session: Session): Promise<AgentApiReply> {
    return describePushLanding(await session.mergeAndContinue({ force: true }));
  }

  function refusal(status: number, error: string): AgentApiReply {
    return { status, body: { ok: false, error } };
  }

  async function review(pullRequestKey: string): Promise<AgentApiReply> {
    if (!operatorState) return refusal(503, 'team review is not available in this Glimmervoid');
    const separatorIndex = pullRequestKey.lastIndexOf('#');
    const outcome = await operatorState.requestReview({ repo: pullRequestKey.slice(0, separatorIndex), number: Number(pullRequestKey.slice(separatorIndex + 1)) });
    if (!outcome.ok) return refusal(409, outcome.error);
    return { status: 200, body: { ...outcome, note: 'the review lands as a draft in the Reviews tab, and only the operator can post it' } };
  }

  function linkPr(session: Session, pullRequestKey: string): AgentApiReply {
    const link = manualPrLink(pullRequestKey, operatorState?.myPrsStatus()?.prs ?? [], Date.now());
    if (!link) return refusal(400, `not a GitHub pull request: ${pullRequestKey}`);
    session.linkPrManually(link);
    return { status: 200, body: { ok: true, key: `${link.repo}#${link.number}`, url: link.url } };
  }

  function settings(request: AgentSettingsRequest): AgentApiReply {
    if (!operatorState) return refusal(503, 'settings are not available in this Glimmervoid');
    const reply = operatorState.readSettings(request);
    return { status: reply.ok ? 200 : 400, body: reply };
  }

  async function edit(session: Session, request: AgentEditRequest): Promise<AgentApiReply> {
    const reply = await sessionDocs.surface(session, request);
    if (!reply.ok) return { status: 400, body: reply };
    return { status: 200, body: { ok: true, path: reply.doc.path, name: reply.doc.name } };
  }

  async function spawnReply(session: Session, request: AgentSpawnRequest): Promise<AgentApiReply> {
    const outcome = await spawn(session, request);
    if (!outcome.ok) return { status: outcome.status, body: { ok: false, error: outcome.error } };
    const note = `this session owns ${outcome.name} until the task is done: glimmervoid read ${outcome.sessionId} reads its messages, glimmervoid send ${outcome.sessionId} <text> steers it, and glimmervoid close ${outcome.sessionId} ends it`;
    return { status: 200, body: { ok: true, sessionId: outcome.sessionId, name: outcome.name, note } };
  }

  function send(session: Session, { words }: AgentSendRequest): AgentApiReply {
    const at = Date.now();
    if (channelsByChildId.has(session.id)) {
      post(session.id, 'toParent', { author: 'child', text: words.join(' '), at });
      return { status: 200, body: { ok: true } };
    }
    const [target = '', ...textWords] = words;
    const text = textWords.join(' ').trim();
    if (!text) return refusal(400, 'send needs the spawned session and the text, for example glimmervoid send <child> fix the failing test');
    const owned = findChildOf(session, target);
    if (!owned.ok) return refusal(404, owned.error);
    if (!agentSessions.has(owned.channel.childId)) return refusal(409, `${owned.channel.childName} has ended, so nothing was sent`);
    post(owned.channel.childId, 'toChild', { author: 'parent', text, at });
    return { status: 200, body: { ok: true } };
  }

  function read(session: Session, { child }: AgentReadRequest): AgentApiReply {
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

  function close(session: Session, { child }: AgentCloseRequest): AgentApiReply {
    const owned = findChildOf(session, child);
    if (!owned.ok) return refusal(404, owned.error);
    const childSession = agentSessions.get(owned.channel.childId);
    if (!childSession) return refusal(409, `${owned.channel.childName} has already ended`);
    childSession.destroy();
    return { status: 200, body: { ok: true, closed: owned.channel.childId } };
  }

  function githubLanesUnavailable(): AgentApiReply {
    return refusal(503, 'GitHub lanes are not available in this Glimmervoid');
  }

  const handlers: AgentVerbHandlers = {
    spawn: spawnReply,
    send,
    read,
    close,
    attention,
    board: () => ({ status: 200, body: { ok: true, sessions: board() } }),
    push,
    edit,
    limits: (session) => ({ status: 200, body: limits(session) }),
    review: (_session, { pullRequestKey }) => review(pullRequestKey),
    reviews: () => (operatorState ? { status: 200, body: projectReviews(operatorState.teamReviewStatus()) } : githubLanesUnavailable()),
    prs: () => (operatorState ? { status: 200, body: projectMyPrs(operatorState.myPrsStatus()) } : githubLanesUnavailable()),
    'link-pr': (session, { pullRequestKey }) => linkPr(session, pullRequestKey),
    settings: (_session, request) => settings(request),
  };

  function dispatch<V extends AgentApiVerb>(session: Session, verb: V, request: AgentRequestOf<V>): AgentApiReply | Promise<AgentApiReply> {
    const handler: AgentVerbHandlers[V] = handlers[verb];
    return handler(session, request);
  }

  async function handle(session: Session, verb: string, payload: Record<string, unknown>): Promise<AgentApiReply> {
    const parsed = parseAgentVerb(verb, payload);
    if (!parsed.ok) return { status: parsed.status, body: { ok: false, error: parsed.error } };
    const roleRefusal = describeRoleRefusal(parsed.verb, roleFactsOf(session));
    if (roleRefusal) return roleRefusal;
    return dispatch(session, parsed.verb, parsed.request);
  }

  return { handle };
}

export { createAgentApiWiring };
export type { AgentApiPort };
