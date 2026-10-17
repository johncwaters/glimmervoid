import crypto from 'node:crypto';

import { getAdapter, isKnownAgentId } from '../session/adapters/index.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { describeSessionLimits } from '../session/core/session-routes.ts';
import type { SessionRoleFacts } from '../session/core/session-routes.ts';
import type { Session } from '../session/sessions.ts';
import type { FactoryState } from '../shared/contracts/factory.ts';
import type {
  AgentAttentionReply, AgentAttentionRequest, AgentBoardRow, AgentLimitsReply, AgentSpawnRequest,
} from '../shared/contracts/session.ts';
import type { GlimmervoidConfig, ProjectEntry } from './config-store.ts';
import type { ControlMessageRecord } from './core/control-replay-core.ts';
import {
  decideAttentionAllowance, decideEditAllowance, decideFactoryControlAllowance, decideSpawnAllowance, deriveChildSessionName, describePushLanding, describePushRouteRefusal,
  describeUnavailableFactoryState, formatFactoryStatus, parseAgentVerb,
} from './core/agent-api-core.ts';
import { buildFactoryIntentDigest } from './factory/core/factory-core.ts';
import { isGuardedSessionVendor } from './guardrails/core/guardrails-roles-core.ts';
import { registerEphemeralSession } from './lanes/ephemeral-session.ts';
import type { RecordLane, SpawnGate } from './lanes/ephemeral-session.ts';
import type { SessionSpawnOverrides } from './session/session-factory.ts';
import type { SessionDocsPort } from './session/session-docs-wiring.ts';
import type { MemoryAdmission } from './spawn-gate.ts';
import { errorMessage } from '../shared/text.ts';

const AGENT_LANE_TAG = 'agent-spawn';
const SPAWN_FAILED_MESSAGE = 'could not spawn the session';
const BYTES_PER_MEGABYTE = 1024 * 1024;

type MakeSession = (
  project: ProjectEntry,
  config: GlimmervoidConfig,
  overrides?: SessionSpawnOverrides,
) => Session;

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
  factory?: {
    getState: () => FactoryState | null;
    retryParked: (projectId: string, intentId: string) => Promise<{ ok: true; reopenedWorkIds: string[] } | { ok: false; error: string }>;
  };
  memoryAdmission?: Pick<MemoryAdmission, 'describeShortfallNow'> | null;
  logger?: Pick<Console, 'warn'>;
}

type SpawnOutcome =
  | { ok: true; sessionId: string; name: string }
  | { ok: false; status: number; error: string };

interface AgentApiReply {
  status: number;
  body: Record<string, unknown>;
}

interface AgentApiPort {
  handle(session: Session, verb: string, payload: Record<string, unknown>): Promise<AgentApiReply>;
}

function createAgentApiWiring({
  config, agentSessions, listAllSessions, listBoardSessions, makeSession, wireSessionEvents, closeSessionDataClients,
  broadcastControl, spawnGate, sessionDocs, factory,
  recordLane = null,
  memoryAdmission = null,
  logger = console,
}: AgentApiWiringOptions): AgentApiPort {
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
    const allowance = decideSpawnAllowance({ ...parent.agentSpawnBudget(), isFactoryWorker: parent.factoryRole === 'worker', isEphemeral: parent.ephemeral });
    if (allowance.ok) return null;
    return { ok: false, status: allowance.status, error: allowance.reason };
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
    const memoryShortfall = await describeMemoryShortfall();
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
    const releaseChildSlot = () => {
      if (released) return;
      released = true;
      parent.noteAgentChildExit();
      broadcastControl({ type: 'session-removed', id, session: name });
    };
    const abandonChild = (reason: string): SpawnOutcome => {
      logger.warn(`[${AGENT_LANE_TAG} ${name}] ${reason}`);
      child?.destroy();
      releaseChildSlot();
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
      factoryRole: session.factoryRole,
      hasOwnWorktree: session.hasOwnWorktree,
    };
  }

  function attention(session: Session, request: AgentAttentionRequest): AgentApiReply {
    const allowance = decideAttentionAllowance(roleFactsOf(session));
    if (!allowance.ok) return { status: allowance.status, body: { ok: false, error: allowance.reason } };
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
    const routeRefusal = describePushRouteRefusal(roleFactsOf(session));
    if (routeRefusal) return routeRefusal;
    return describePushLanding(await session.mergeAndContinue({ force: true }));
  }

  async function handle(session: Session, verb: string, payload: Record<string, unknown>): Promise<AgentApiReply> {
    const parsed = parseAgentVerb(verb, payload);
    if (!parsed.ok) return { status: parsed.status, body: { ok: false, error: parsed.error } };
    if (parsed.verb === 'factory-status' || parsed.verb === 'factory-retry') {
      const allowance = decideFactoryControlAllowance(roleFactsOf(session));
      if (!allowance.ok) return { status: allowance.status, body: { ok: false, error: allowance.reason } };
      const projects = factory?.getState()?.projects;
      if (!projects || !factory) return { status: 409, body: { ok: false, error: 'Factory is not running' } };
      if (parsed.verb === 'factory-status') {
        const selectedProjects = parsed.request.projectId === undefined ? projects : projects.filter((project) => project.projectId === parsed.request.projectId);
        if (parsed.request.projectId !== undefined && selectedProjects.length === 0) {
          return { status: 404, body: { ok: false, error: `Unknown factory project: ${parsed.request.projectId}` } };
        }
        return { status: 200, body: { ok: true, text: formatFactoryStatus(selectedProjects, buildFactoryIntentDigest) } };
      }
      const intentId = parsed.request.intentId;
      const project = projects.find((project) => project.orders.some((order) => order.parent === null && order.id === intentId));
      if (!project) {
        const unavailableState = describeUnavailableFactoryState(projects);
        if (unavailableState !== null) return { status: 503, body: { ok: false, error: unavailableState } };
        return { status: 404, body: { ok: false, error: `Unknown factory intent: ${intentId}` } };
      }
      const reply = await factory.retryParked(project.projectId, intentId);
      if (!reply.ok) return { status: 409, body: reply };
      return { status: 200, body: { ...reply, text: `Reopened parked tickets: ${reply.reopenedWorkIds.join(', ') || 'none'}` } };
    }
    if (parsed.verb === 'board') return { status: 200, body: { ok: true, sessions: board() } };
    if (parsed.verb === 'push') return push(session);
    if (parsed.verb === 'limits') return { status: 200, body: limits(session) };
    if (parsed.verb === 'attention') return attention(session, parsed.request);
    if (parsed.verb === 'edit') {
      const allowance = decideEditAllowance(roleFactsOf(session));
      if (!allowance.ok) return { status: allowance.status, body: { ok: false, error: allowance.reason } };
      const reply = await sessionDocs.surface(session, parsed.request);
      if (!reply.ok) return { status: 400, body: reply };
      return { status: 200, body: { ok: true, path: reply.doc.path, name: reply.doc.name } };
    }
    const outcome = await spawn(session, parsed.request);
    if (!outcome.ok) return { status: outcome.status, body: { ok: false, error: outcome.error } };
    return { status: 200, body: { ok: true, sessionId: outcome.sessionId, name: outcome.name } };
  }

  return { handle };
}

export { createAgentApiWiring };
export type { AgentApiPort };
