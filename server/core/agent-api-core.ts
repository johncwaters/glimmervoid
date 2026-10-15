import crypto from 'node:crypto';

import { AGENT_API_VERBS, AgentDispatchRequest, AgentAttentionRequest, AgentEditRequest, AgentFactoryRetryRequest, AgentFactoryStatusRequest, AgentSpawnRequest, ORCHESTRATOR_AGENT_VERBS } from '../../shared/contracts/session.ts';
import type { AgentApiVerb, OrchestratorAgentVerb, TicketAgentVerb } from '../../shared/contracts/session.ts';
import type { FactoryProjectState } from '../../shared/contracts/factory.ts';
import { attentionRoute, editRoute, NO_OWN_WORKTREE_REASON, pushRoute, spawnRoute } from '../../session/core/session-routes.ts';
import type { RouteVerdict, SessionRoleFacts } from '../../session/core/session-routes.ts';

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
  isFactoryWorker: boolean;
  isEphemeral: boolean;
}

type AgentVerdict = { ok: true } | { ok: false; status: number; reason: string };

type AgentVerbRequest =
  | { ok: true; verb: 'board' }
  | { ok: true; verb: 'push' }
  | { ok: true; verb: 'limits' }
  | { ok: true; verb: 'factory-status'; request: AgentFactoryStatusRequest }
  | { ok: true; verb: 'factory-retry'; request: AgentFactoryRetryRequest }
  | { ok: true; verb: 'dispatch'; request: AgentDispatchRequest }
  | { ok: true; verb: 'attention'; request: AgentAttentionRequest }
  | { ok: true; verb: 'edit'; request: AgentEditRequest }
  | { ok: true; verb: 'spawn'; request: AgentSpawnRequest }
  | { ok: false; status: number; error: string };

const INVALID_BODY_STATUS = 400;
const PUSH_REFUSED_STATUS = 409;

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
  'no-worktree': () => NO_OWN_WORKTREE_REASON,
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

function refuseByRole(route: RouteVerdict): AgentVerdict {
  if (route.answers) return { ok: true };
  return { ok: false, status: 403, reason: route.reason };
}

function decideSpawnAllowance({ liveChildren, lifetimeSpawns, inFlight, depth, isFactoryWorker, isEphemeral }: SpawnBudget): AgentVerdict {
  const role = refuseByRole(spawnRoute({ isEphemeral, isSpawnedChild: depth !== SPAWNABLE_DEPTH, factoryRole: isFactoryWorker ? 'worker' : null }));
  if (!role.ok) return role;
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

function decideAttentionAllowance(caller: SessionRoleFacts): AgentVerdict {
  return refuseByRole(attentionRoute(caller));
}

function decideEditAllowance(caller: SessionRoleFacts): AgentVerdict {
  return refuseByRole(editRoute(caller));
}

function factoryControlRoute({ factoryRole, isEphemeral, isSpawnedChild }: Pick<SessionRoleFacts, 'factoryRole' | 'isEphemeral' | 'isSpawnedChild'>): RouteVerdict {
  const isFactoryOrLaneSession = factoryRole !== null || (isEphemeral && !isSpawnedChild);
  if (!isFactoryOrLaneSession) return { answers: true };
  return { answers: false, reason: 'only an operator session or a session it spawned may read factory status or retry parked work, so factory and lane sessions stay on their own task' };
}

function decideFactoryControlAllowance(caller: SessionRoleFacts): AgentVerdict {
  return refuseByRole(factoryControlRoute(caller));
}

function describePushRouteRefusal(caller: SessionRoleFacts): AgentPushReply | null {
  const route = pushRoute(caller);
  if (route.answers) return null;
  return { status: PUSH_REFUSED_STATUS, body: { ok: false, reason: route.code, error: route.reason } };
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
  if (verb === 'factory-status') {
    const parsed = AgentFactoryStatusRequest.safeParse(payload);
    if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
    return { ok: true, verb, request: parsed.data };
  }
  if (verb === 'factory-retry') {
    const parsed = AgentFactoryRetryRequest.safeParse(payload);
    if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
    return { ok: true, verb, request: parsed.data };
  }
  if (verb === 'dispatch') {
    const parsed = AgentDispatchRequest.safeParse(payload);
    if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
    return { ok: true, verb, request: parsed.data };
  }
  if (verb === 'reopen' || verb === 'cancel') return { ok: false, status: 403, error: `${verb} requires a live factory orchestrator` };
  if (verb === 'board' || verb === 'push' || verb === 'limits') return { ok: true, verb };
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

type FactoryOrder = FactoryProjectState['orders'][number];

type FactoryDigestBuilder = (project: FactoryProjectState, intentId: string) => {
  merged: readonly { id: string }[];
  parked: readonly { id: string }[];
  confirmedFlakes: readonly string[];
  isPartial: boolean;
};

function factoryTicketNextAction(ticket: Pick<FactoryOrder, 'state' | 'parked'>, intentId: string): string {
  if (ticket.state === 'completed' || ticket.state === 'cancelled') return 'none';
  if (ticket.parked) return `glimmervoid factory retry ${intentId}`;
  if (ticket.state === 'blocked') return 'orchestrator reopens';
  return 'in progress';
}

function describeFactoryProjectUnavailability(project: Pick<FactoryProjectState, 'error' | 'heading'>): string | null {
  if (project.error !== null) return project.error;
  if (project.heading.action === 'refuse') return `orientation refused: ${project.heading.reasons.join('; ') || 'no reason given'}`;
  return null;
}

function describeUnavailableFactoryState(projects: readonly FactoryProjectState[]): string | null {
  for (const project of projects) {
    const unavailability = describeFactoryProjectUnavailability(project);
    if (unavailability !== null) return `Factory state for ${project.projectId} is unavailable: ${unavailability}`;
  }
  return null;
}

function describeSpentToday(spentTodayUsd: number | undefined): string {
  if (spentTodayUsd === undefined) return 'unknown';
  return `$${spentTodayUsd.toFixed(2)}`;
}

function describeDailyBudget(dailyBudgetUsd: number | null | undefined): string {
  if (dailyBudgetUsd === null) return 'unlimited';
  if (dailyBudgetUsd === undefined) return 'unknown';
  return `$${dailyBudgetUsd.toFixed(2)}`;
}

function formatFactoryStatus(projects: readonly FactoryProjectState[], buildDigest: FactoryDigestBuilder): string {
  const lines: string[] = [];
  for (const project of projects) {
    lines.push(`Project ${project.projectId}: ${project.projectName}`);
    lines.push(`Project spend today: ${describeSpentToday(project.spentTodayUsd)} of ${describeDailyBudget(project.dailyBudgetUsd)} budget`);
    const unavailability = describeFactoryProjectUnavailability(project);
    if (unavailability !== null) lines.push(`Factory state unavailable: ${unavailability}`);
    const ticketsByIntentId = new Map<string, FactoryOrder[]>();
    const partialIntentIds = new Set(project.partialIntentIds ?? []);
    for (const order of project.orders) {
      if (order.parent === null) continue;
      const tickets = ticketsByIntentId.get(order.parent) ?? [];
      tickets.push(order);
      ticketsByIntentId.set(order.parent, tickets);
    }
    let intentCount = 0;
    for (const intent of project.orders) {
      if (intent.parent !== null || intent.state === 'cancelled') continue;
      intentCount += 1;
      const tickets = ticketsByIntentId.get(intent.id) ?? [];
      const digest = buildDigest({ ...project, orders: [intent, ...tickets], partialIntentIds: partialIntentIds.has(intent.id) ? [intent.id] : [] }, intent.id);
      const outcome = intent.state === 'completed' ? 'completed' : digest.isPartial ? 'partial' : 'in progress';
      lines.push(`Intent ${intent.id}: ${intent.objective}`, `Outcome: ${outcome}; merged: ${digest.merged.length}; parked: ${digest.parked.length}`);
      for (const ticket of tickets) {
        lines.push(`  ${ticket.id} | state: ${ticket.parked ? 'parked' : ticket.state} | blocks: ${ticket.blockCount ?? 0} | last reason: ${ticket.blockReason ?? 'none'} | next action: ${factoryTicketNextAction(ticket, intent.id)}`);
      }
      lines.push('Confirmed flakes:');
      for (const flake of digest.confirmedFlakes) lines.push(`  ${flake}`);
      if (digest.confirmedFlakes.length === 0) lines.push('  none');
    }
    if (intentCount === 0 && unavailability === null) lines.push('No intents.');
  }
  return lines.join('\n') || 'No factory projects.';
}

export {
  decideAgentRequest, decideAttentionAllowance, decideEditAllowance, decideSpawnAllowance, decideTicketAction, deriveChildSessionName, describePushLanding,
  describePushRouteRefusal, isAgentApiVerb, isOrchestratorAgentVerb, parseAgentVerb, tokensMatch, MAX_LIFETIME_SPAWNS, MAX_LIVE_CHILDREN,
  decideFactoryControlAllowance, describeUnavailableFactoryState, formatFactoryStatus, REFUSAL_REASON, REFUSAL_STATUS,
};
