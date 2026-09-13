import crypto from 'node:crypto';

import { AGENT_API_VERBS, AgentAttentionRequest, AgentSpawnRequest } from '../../shared/contracts/session.ts';
import type { AgentApiVerb } from '../../shared/contracts/session.ts';

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
  enabled: boolean;
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
  | { ok: true; verb: 'attention'; request: AgentAttentionRequest }
  | { ok: true; verb: 'spawn'; request: AgentSpawnRequest }
  | { ok: false; status: number; error: string };

const INVALID_BODY_STATUS = 400;

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
  sessionId, presentedToken, expectedToken, isLoopback, enabled,
}: AgentRequestInput): AgentVerdict {
  if (!enabled) return refused();
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

function refuseInvalidBody(issues: readonly { message?: string }[]): AgentVerbRequest {
  return { ok: false, status: INVALID_BODY_STATUS, error: issues[0]?.message || 'invalid request' };
}

function parseAgentVerb(verb: string, payload: Record<string, unknown>): AgentVerbRequest {
  if (!isAgentApiVerb(verb)) return { ok: false, status: REFUSAL_STATUS, error: REFUSAL_REASON };
  if (verb === 'board') return { ok: true, verb };
  if (verb === 'attention') {
    const parsed = AgentAttentionRequest.safeParse(payload);
    if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
    return { ok: true, verb, request: parsed.data };
  }
  const parsed = AgentSpawnRequest.safeParse(payload);
  if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
  return { ok: true, verb, request: parsed.data };
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
  decideAgentRequest, decideSpawnAllowance, deriveChildSessionName, isAgentApiVerb, parseAgentVerb, tokensMatch,
  MAX_LIFETIME_SPAWNS, MAX_LIVE_CHILDREN, REFUSAL_REASON, REFUSAL_STATUS,
};
export type { AgentVerbRequest, SpawnBudget };
