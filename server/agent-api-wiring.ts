import crypto from 'node:crypto';

import { getAdapter, isKnownAgentId } from '../session/adapters/index.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { describeSessionLimits } from '../session/core/session-routes.ts';
import type { SessionRoleFacts } from '../session/core/session-routes.ts';
import type { Session } from '../session/sessions.ts';
import type {
  AgentAttentionReply, AgentAttentionRequest, AgentBoardRow, AgentLimitsReply, AgentSpawnRequest,
} from '../shared/contracts/session.ts';
import type { GlimmervoidConfig, ProjectEntry } from './config-store.ts';
import type { ControlMessageRecord } from './core/control-replay-core.ts';
import {
  decideAttentionAllowance, decideEditAllowance, decideSpawnAllowance, deriveChildSessionName, describePushLanding, describePushRouteRefusal, parseAgentVerb,
} from './core/agent-api-core.ts';
import { isConfinedSessionVendor } from './sandbox/core/sandbox-roles-core.ts';
import { registerEphemeralSession } from './lanes/ephemeral-session.ts';
import type { RecordLane, SpawnGate } from './lanes/ephemeral-session.ts';
import type { SessionSpawnOverrides } from './session/session-factory.ts';
import type { SessionDocsPort } from './session/session-docs-wiring.ts';
import { errorMessage } from '../shared/text.ts';

const AGENT_LANE_TAG = 'agent-spawn';
const SPAWN_FAILED_MESSAGE = 'could not spawn the session';

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
  broadcastControl, spawnGate, sessionDocs,
  recordLane = null,
  logger = console,
}: AgentApiWiringOptions): AgentApiPort {
  async function spawn(parent: Session, request: AgentSpawnRequest): Promise<SpawnOutcome> {
    const budget = parent.agentSpawnBudget();
    const allowance = decideSpawnAllowance({ ...budget, isFactoryWorker: parent.factoryRole === 'worker', isEphemeral: parent.ephemeral });
    if (!allowance.ok) return { ok: false, status: allowance.status, error: allowance.reason };
    if (request.agent && !isKnownAgentId(request.agent)) {
      return { ok: false, status: 400, error: `unknown agent ${request.agent}` };
    }
    const agentId = request.agent || parent.agentId;
    if (parent.isConfined && !isConfinedSessionVendor(getAdapter(agentId)?.usageVendor ?? null)) {
      return { ok: false, status: 403, error: `a sandboxed session can only spawn a sandboxed agent, and ${agentId} does not run inside the sandbox` };
    }

    const name = deriveChildSessionName(request.name || parent.name, listAllSessions().map((session) => session.name));
    const id = `${AGENT_LANE_TAG}-${crypto.randomUUID()}`;
    const project: ProjectEntry = {
      id,
      name,
      path: parent.path,
      dangerouslySkipPermissions: parent.dangerouslySkipPermissions,
      unguarded: !parent.isConfined,
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
    return { ok: true, ...describeSessionLimits({ ...roleFactsOf(session), isSandboxed: session.isConfined }) };
  }

  async function push(session: Session): Promise<AgentApiReply> {
    const routeRefusal = describePushRouteRefusal(roleFactsOf(session));
    if (routeRefusal) return routeRefusal;
    return describePushLanding(await session.mergeAndContinue({ force: true }));
  }

  async function handle(session: Session, verb: string, payload: Record<string, unknown>): Promise<AgentApiReply> {
    const parsed = parseAgentVerb(verb, payload);
    if (!parsed.ok) return { status: parsed.status, body: { ok: false, error: parsed.error } };
    if (parsed.verb === 'dispatch') return { status: 403, body: { ok: false, reason: 'dispatch requires a live factory orchestrator' } };
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
export type { AgentApiPort, AgentApiReply };
