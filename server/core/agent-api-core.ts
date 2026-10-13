import crypto from 'node:crypto';

import { AGENT_API_VERBS, AgentDispatchRequest, AgentAttentionRequest, AgentEditRequest, AgentSpawnRequest, ORCHESTRATOR_AGENT_VERBS } from '../../shared/contracts/session.ts';
import type { AgentApiVerb, OrchestratorAgentVerb, TicketAgentVerb } from '../../shared/contracts/session.ts';

const MAX_LIVE_CHILDREN = 3;
const MAX_LIFETIME_SPAWNS = 10;
const MAX_SPAWNS_IN_FLIGHT = 1;
const SPAWNABLE_DEPTH = 0;

const REFUSAL_STATUS = 404;
const REFUSAL_REASON = 'unknown session';

interface AgentRequestInput {
  sessionId: string | null | undefined;
  presentedToken: string | null | undefined;
  expectedToken: string | null | undefined;
  isLoopback: boolean;
}

interface SpawnBudget {
  liveChildren: number;
  lifetimeSpawns: number;
  inFlight: number;
  depth: number;
}

type AgentVerdict = { ok: true } | { ok: false; status: number; reason: string };

type AgentVerbRequest =
  | { ok: true; verb: 'board' }
  | { ok: true; verb: 'push' }
  | { ok: true; verb: 'dispatch'; request: AgentDispatchRequest }
  | { ok: true; verb: 'attention'; request: AgentAttentionRequest }
  | { ok: true; verb: 'edit'; request: AgentEditRequest }
  | { ok: true; verb: 'spawn'; request: AgentSpawnRequest }
  | { ok: false; status: number; error: string };

const INVALID_BODY_STATUS = 400;
const PUSH_REFUSED_STATUS = 409;
const PUSH_UNAVAILABLE_REASON = 'not-operator-session';

interface PushLanding {
  merged: boolean;
  reason?: string | null;
  base?: string | null;
  pushed?: boolean;
  conflicts?: string[];
}

interface AgentPushReply {
  status: number;
  body: Record<string, unknown>;
}

const PUSH_REFUSAL_COPY: Readonly<Record<string, (landing: PushLanding) => string>> = Object.freeze({
  [PUSH_UNAVAILABLE_REASON]: () => 'only an operator session or a session it spawned can push',
  'no-worktree': () => 'this session has no worktree of its own, so there is nothing of its own to land',
  'merge-in-progress': () => 'a merge for this session is already running, so try again when it ends',
  'not-continuable': () => 'this session cannot be merged in its current state',
  destroyed: () => 'this session is ending',
  'nothing-to-commit': () => 'no commit on this branch is missing from the integration branch, so commit your work first',
  'rebase-conflict': ({ base, conflicts = [] }) => `this branch conflicts with ${base} in ${conflicts.join(', ') || 'one or more files'}, so rebase onto ${base}, resolve the conflicts, commit, then push again`,
  'not-fast-forward': ({ base }) => `${base} could not be fast-forwarded to this branch, and a push is never forced`,
  'base-diverged': ({ base }) => `the local ${base} and origin/${base} have diverged, which the operator has to reconcile`,
});

function tokensMatch(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

function refused(): AgentVerdict {
  return { ok: false, status: REFUSAL_STATUS, reason: REFUSAL_REASON };
}

function decideAgentRequest({
  sessionId, presentedToken, expectedToken, isLoopback,
}: AgentRequestInput): AgentVerdict {
  if (!isLoopback) return refused();
  if (!sessionId) return refused();
  if (!expectedToken) return refused();
  if (!presentedToken) return refused();
  if (!tokensMatch(presentedToken, expectedToken)) return refused();
  return { ok: true };
}

function decideSpawnAllowance({ liveChildren, lifetimeSpawns, inFlight, depth }: SpawnBudget): AgentVerdict {
  if (depth !== SPAWNABLE_DEPTH) {
    return { ok: false, status: 403, reason: 'a spawned session may not spawn another' };
  }
  if (inFlight >= MAX_SPAWNS_IN_FLIGHT) {
    return { ok: false, status: 429, reason: 'a spawn is already in flight' };
  }
  if (liveChildren >= MAX_LIVE_CHILDREN) {
    return { ok: false, status: 429, reason: `at most ${MAX_LIVE_CHILDREN} spawned sessions may be live at once` };
  }
  if (lifetimeSpawns >= MAX_LIFETIME_SPAWNS) {
    return { ok: false, status: 429, reason: `this session has used its ${MAX_LIFETIME_SPAWNS} spawns` };
  }
  return { ok: true };
}

function isAgentApiVerb(verb: string): verb is AgentApiVerb {
  return (AGENT_API_VERBS as readonly string[]).includes(verb);
}

function isOrchestratorAgentVerb(verb: string): verb is OrchestratorAgentVerb {
  return (ORCHESTRATOR_AGENT_VERBS as readonly string[]).includes(verb);
}

interface TicketActionInput {
  verb: TicketAgentVerb;
  intentId: string;
  ticket: { parent: string | null; state: string } | null;
}

type TicketAction =
  | { ok: true; kind: 'transition'; to: 'open' }
  | { ok: true; kind: 'close'; outcome: 'cancelled' }
  | { ok: false; reason: string };

const TICKET_ACTION_STATES: Readonly<Record<TicketAgentVerb, readonly string[]>> = Object.freeze({
  reopen: Object.freeze(['blocked']),
  cancel: Object.freeze(['open', 'blocked']),
});

function decideTicketAction({ verb, intentId, ticket }: TicketActionInput): TicketAction {
  if (!ticket) return { ok: false, reason: 'no such ticket' };
  if (ticket.parent !== intentId) return { ok: false, reason: 'the ticket is not a child of the active intent' };
  const allowed = TICKET_ACTION_STATES[verb];
  if (!allowed.includes(ticket.state)) {
    return { ok: false, reason: `only a ${allowed.join(' or ')} ticket can be ${verb === 'reopen' ? 'reopened' : 'cancelled'}, and this one is ${ticket.state}` };
  }
  if (verb === 'reopen') return { ok: true, kind: 'transition', to: 'open' };
  return { ok: true, kind: 'close', outcome: 'cancelled' };
}

function refuseInvalidBody(issues: readonly { message?: string }[]): AgentVerbRequest {
  return { ok: false, status: INVALID_BODY_STATUS, error: issues[0]?.message || 'invalid request' };
}

function parseAgentVerb(verb: string, payload: Record<string, unknown>): AgentVerbRequest {
  if (!isAgentApiVerb(verb)) return { ok: false, status: REFUSAL_STATUS, error: REFUSAL_REASON };
  if (verb === 'dispatch') {
    const parsed = AgentDispatchRequest.safeParse(payload);
    if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
    return { ok: true, verb, request: parsed.data };
  }
  if (verb === 'reopen' || verb === 'cancel') return { ok: false, status: 403, error: `${verb} requires a live factory orchestrator` };
  if (verb === 'board' || verb === 'push') return { ok: true, verb };
  if (verb === 'attention') {
    const parsed = AgentAttentionRequest.safeParse(payload);
    if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
    return { ok: true, verb, request: parsed.data };
  }
  if (verb === 'edit') {
    const parsed = AgentEditRequest.safeParse(payload);
    if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
    return { ok: true, verb, request: parsed.data };
  }
  const parsed = AgentSpawnRequest.safeParse(payload);
  if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
  return { ok: true, verb, request: parsed.data };
}

function describePushLanding(landing: PushLanding): AgentPushReply {
  if (!landing.merged) {
    const reason = landing.reason || 'unknown';
    const explain = PUSH_REFUSAL_COPY[reason];
    return { status: PUSH_REFUSED_STATUS, body: { ok: false, reason, error: explain ? explain(landing) : `the merge stopped: ${reason}` } };
  }
  if (landing.pushed) return { status: 200, body: { ok: true, landedOn: landing.base ?? null, pushed: true } };
  return {
    status: 200,
    body: { ok: true, landedOn: landing.base ?? null, pushed: false, note: 'landed locally and nothing was pushed, because the repository has no origin remote or origin did not take a fast-forward' },
  };
}

function deriveChildSessionName(parentName: string, existingNames: readonly string[]): string {
  const base = `${String(parentName || '').trim() || 'session'} agent`;
  const taken = new Set(existingNames);
  let candidate = base;
  let suffix = 1;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `${base} ${suffix}`;
  }
  return candidate;
}

export {
  decideAgentRequest, decideSpawnAllowance, decideTicketAction, deriveChildSessionName, describePushLanding, isAgentApiVerb, isOrchestratorAgentVerb,
  parseAgentVerb, tokensMatch, PUSH_UNAVAILABLE_REASON, MAX_LIFETIME_SPAWNS, MAX_LIVE_CHILDREN, REFUSAL_REASON, REFUSAL_STATUS,
};
export type { AgentVerbRequest, SpawnBudget, TicketAction, TicketActionInput };
