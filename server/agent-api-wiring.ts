import crypto from 'node:crypto';

import { isKnownAgentId } from '../session/adapters/index.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import type { Session } from '../session/sessions.ts';
import type { AgentAttentionRequest, AgentBoardRow, AgentSpawnRequest } from '../shared/contracts/session.ts';
import type { GlimmervoidConfig, ProjectEntry } from './config-store.ts';
import type { ControlMessageRecord } from './control-replay-core.ts';
import { decideSpawnAllowance, deriveChildSessionName, parseAgentVerb } from './core/agent-api-core.ts';
import { registerEphemeralSession } from './ephemeral-session.ts';
import type { RecordLane, SpawnGate } from './ephemeral-session.ts';
import type { SessionSpawnOverrides } from './session-factory.ts';

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
  enabled(): boolean;
  handle(session: Session, verb: string, payload: Record<string, unknown>): Promise<AgentApiReply>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createAgentApiWiring({
  config, agentSessions, listAllSessions, listBoardSessions, makeSession, wireSessionEvents, closeSessionDataClients,
  broadcastControl, spawnGate,
  recordLane = null,
  logger = console,
}: AgentApiWiringOptions): AgentApiPort {
  async function spawn(parent: Session, request: AgentSpawnRequest): Promise<SpawnOutcome> {
    const budget = parent.agentSpawnBudget();
    const allowance = decideSpawnAllowance(budget);
    if (!allowance.ok) return { ok: false, status: allowance.status, error: allowance.reason };
    if (request.agent && !isKnownAgentId(request.agent)) {
      return { ok: false, status: 400, error: `unknown agent ${request.agent}` };
    }
    const agentId = request.agent || parent.agentId;

    const name = deriveChildSessionName(request.name || parent.name, listAllSessions().map((session) => session.name));
    const id = `${AGENT_LANE_TAG}-${crypto.randomUUID()}`;
    const project: ProjectEntry = {
      id,
      name,
      path: parent.path,
      dangerouslySkipPermissions: parent.dangerouslySkipPermissions,
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

  function attention(parent: Session, request: AgentAttentionRequest): void {
    parent.noteAttention(request.note);
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

  async function handle(session: Session, verb: string, payload: Record<string, unknown>): Promise<AgentApiReply> {
    const parsed = parseAgentVerb(verb, payload);
    if (!parsed.ok) return { status: parsed.status, body: { ok: false, error: parsed.error } };
    if (parsed.verb === 'board') return { status: 200, body: { ok: true, sessions: board() } };
    if (parsed.verb === 'attention') {
      attention(session, parsed.request);
      return { status: 200, body: { ok: true } };
    }
    const outcome = await spawn(session, parsed.request);
    if (!outcome.ok) return { status: outcome.status, body: { ok: false, error: outcome.error } };
    return { status: 200, body: { ok: true, sessionId: outcome.sessionId, name: outcome.name } };
  }

  return {
    enabled: () => config.agentApi?.enabled === true,
    handle,
  };
}

export { createAgentApiWiring };
export type { AgentApiPort, AgentApiReply };
