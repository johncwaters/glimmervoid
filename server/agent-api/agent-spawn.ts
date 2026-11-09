import crypto from 'node:crypto';
import { isKnownAgentId } from '../../session/adapters/index.ts';
import { projectSessionCard } from '../../session/core/snapshot-projection.ts';
import type { Session } from '../../session/sessions.ts';
import type { AgentSpawnRequest } from '../../shared/contracts/session.ts';
import type { ProjectEntry } from '../config-store.ts';
import { decideSpawnAllowance, deriveChildSessionName } from '../core/agent-api-core.ts';
import type { ChildWorktree } from '../core/agent-api-core.ts';
import { registerEphemeralSession } from '../lanes/ephemeral-session.ts';
import { errorMessage } from '../../shared/text.ts';
import { AGENT_LANE_TAG } from './agent-api-context.ts';
import type { AgentApiRuntime } from './agent-api-context.ts';
import type { ChildChannels } from './child-channels.ts';

const SPAWN_FAILED_MESSAGE = 'could not spawn the session';

const PARENT_ENDED_MESSAGE = 'this session ended before its child could start, so nothing was spawned';

const BYTES_PER_MEGABYTE = 1024 * 1024;

type SpawnOutcome =
  | { ok: true; sessionId: string; name: string }
  | { ok: false; status: number; error: string };

function createAgentSpawner(runtime: AgentApiRuntime, channels: ChildChannels) {
  const { config, agentSessions, listAllSessions, makeSession, wireSessionEvents, closeSessionDataClients, broadcastControl, spawnGate, recordLane, memoryAdmission, logger } = runtime;
  const { noteEndCause, forgetLink, openChildChannel, settleChildWorktree } = channels;

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


  return { spawn, describeMemoryShortfall };
}

type AgentSpawner = ReturnType<typeof createAgentSpawner>;

export { createAgentSpawner };
export type { AgentSpawner };
