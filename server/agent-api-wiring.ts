import type { Session } from '../session/sessions.ts';
import type { AgentApiVerb, SessionCommand } from '../shared/contracts/session.ts';
import { checkAgentReply, describeRoleRefusal, parseAgentVerb } from './core/agent-api-core.ts';
import type { AgentRefusalReply, AgentReplyOf, AgentRequestOf, ChildEndCause } from './core/agent-api-core.ts';
import type { AgentChannel } from './core/child-channel-core.ts';
import { DEFAULT_TIMER_FNS } from '../shared/timer-deps.ts';
import type { AgentApiRuntime, AgentApiWiringOptions, AgentVerbHandlers, ChannelLink } from './agent-api/agent-api-context.ts';
import { createChildChannels } from './agent-api/child-channels.ts';
import { createAgentSpawner } from './agent-api/agent-spawn.ts';
import { createAgentVerbHandlers } from './agent-api/agent-verbs.ts';

interface AgentWireReply {
  status: number;
  body: Record<string, unknown>;
}

interface AgentApiPort {
  handle(session: Session, verb: string, payload: Record<string, unknown>): Promise<AgentWireReply>;
  refuseRole(session: Session, verb: AgentApiVerb | SessionCommand): AgentRefusalReply | null;
  markChildWorktreeDiscard(childId: string): void;
}

function createAgentApiWiring({
  config, agentSessions, listAllSessions, listBoardSessions, makeSession, wireSessionEvents, closeSessionDataClients,
  broadcastControl, spawnGate, sessionDocs,
  recordLane = null,
  memoryAdmission = null,
  operatorState = null,
  whiteboards = null,
  lookupWhy = null,
  coderWorkspaceStatus = () => null,
  settleSessionCoherence = async () => {},
  secrets = null,
  logger = console,
  setTimeoutFn = DEFAULT_TIMER_FNS.setTimeoutFn,
  clearTimeoutFn = DEFAULT_TIMER_FNS.clearTimeoutFn,
  now = Date.now,
}: AgentApiWiringOptions): AgentApiPort {
  const runtime: AgentApiRuntime = {
    config, agentSessions, listAllSessions, listBoardSessions, makeSession, wireSessionEvents, closeSessionDataClients,
    broadcastControl, spawnGate, sessionDocs, recordLane, memoryAdmission, operatorState, whiteboards, lookupWhy, coderWorkspaceStatus, settleSessionCoherence, secrets,
    logger, setTimeoutFn, clearTimeoutFn, now,
    channelsByChildId: new Map<string, AgentChannel>(),
    linksByChildId: new Map<string, ChannelLink>(),
    parentsWithChannelCleanup: new WeakSet<Session>(),
    sessionsWithOperatorWatch: new WeakSet<Session>(),
    lastOperatorInputAtBySession: new WeakMap<Session, number>(),
    childIdsToDiscard: new Set<string>(),
    endCauseByChildId: new Map<string, ChildEndCause>(),
  };
  const { childIdsToDiscard } = runtime;
  const channels = createChildChannels(runtime);
  const { handlers, roleFactsOf } = createAgentVerbHandlers(runtime, channels, createAgentSpawner(runtime, channels));

  function dispatch<V extends AgentApiVerb>(session: Session, verb: V, request: AgentRequestOf<V>): AgentReplyOf<V> | Promise<AgentReplyOf<V>> {
    const handler: AgentVerbHandlers[V] = handlers[verb];
    return handler(session, request);
  }

  async function handle(session: Session, verb: string, payload: Record<string, unknown>): Promise<AgentWireReply> {
    const parsed = parseAgentVerb(verb, payload);
    if (!parsed.ok) return { status: parsed.status, body: { ok: false, error: parsed.error } };
    const roleRefusal = describeRoleRefusal(parsed.verb, roleFactsOf(session));
    if (roleRefusal) return roleRefusal;
    session.noteCommandRan(parsed.verb === 'whiteboard' && payload.sub === 'show' ? 'show' : parsed.verb);
    const checked = checkAgentReply(parsed.verb, await dispatch(session, parsed.verb, parsed.request));
    if (!checked.ok) logger.warn(`[agent-api] ${parsed.verb} reply broke its contract: ${checked.issue}`);
    return checked.reply;
  }

  function markChildWorktreeDiscard(childId: string): void {
    childIdsToDiscard.add(childId);
  }

  function refuseRole(session: Session, verb: AgentApiVerb | SessionCommand): AgentRefusalReply | null {
    return describeRoleRefusal(verb, roleFactsOf(session));
  }

  return { handle, refuseRole, markChildWorktreeDiscard };
}

export { createAgentApiWiring };
export type { AgentApiPort };
