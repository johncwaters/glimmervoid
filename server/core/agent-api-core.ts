import crypto from 'node:crypto';

import { pullRequestKeyFromReference } from '../../shared/contracts/control-messages.ts';
import { AGENT_API_VERBS, AgentAttentionRequest, AgentEditRequest, AgentPullRequestRequest, AgentSettingsRequest, AgentSpawnRequest } from '../../shared/contracts/session.ts';
import type { AgentApiVerb, AgentPrsReply, AgentReviewsReply } from '../../shared/contracts/session.ts';
import type { MyPrsSnapshot } from '../../shared/contracts/my-prs.ts';
import type { TeamReviewStatus } from '../../shared/contracts/team-review.ts';
import { attentionRoute, editRoute, linkPrRoute, NO_OWN_WORKTREE_REASON, operatorStateRoute, pushRoute, spawnRoute } from '../../session/core/session-routes.ts';
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
  isEphemeral: boolean;
}

type AgentVerdict = { ok: true } | { ok: false; status: number; reason: string };

type AgentVerbRequest =
  | { ok: true; verb: 'board' }
  | { ok: true; verb: 'push' }
  | { ok: true; verb: 'limits' }
  | { ok: true; verb: 'attention'; request: AgentAttentionRequest }
  | { ok: true; verb: 'edit'; request: AgentEditRequest }
  | { ok: true; verb: 'spawn'; request: AgentSpawnRequest }
  | { ok: true; verb: 'reviews' }
  | { ok: true; verb: 'prs' }
  | { ok: true; verb: 'review'; pullRequestKey: string }
  | { ok: true; verb: 'link-pr'; pullRequestKey: string }
  | { ok: true; verb: 'settings'; request: AgentSettingsRequest }
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

function decideSpawnAllowance({ liveChildren, lifetimeSpawns, inFlight, depth, isEphemeral }: SpawnBudget): AgentVerdict {
  const role = refuseByRole(spawnRoute({ isEphemeral, isSpawnedChild: depth !== SPAWNABLE_DEPTH }));
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

function decideOperatorStateAllowance(caller: SessionRoleFacts): AgentVerdict {
  return refuseByRole(operatorStateRoute(caller));
}

function decideLinkPrAllowance(caller: SessionRoleFacts): AgentVerdict {
  return refuseByRole(linkPrRoute(caller));
}

function describePushRouteRefusal(caller: SessionRoleFacts): AgentPushReply | null {
  const route = pushRoute(caller);
  if (route.answers) return null;
  return { status: PUSH_REFUSED_STATUS, body: { ok: false, reason: route.code, error: route.reason } };
}

function isAgentApiVerb(verb: string): verb is AgentApiVerb {
  return (AGENT_API_VERBS as readonly string[]).includes(verb);
}

function refuseInvalidBody(issues: readonly { message?: string }[]): AgentVerbRequest {
  return { ok: false, status: INVALID_BODY_STATUS, error: issues[0]?.message || 'invalid request' };
}

function parsePullRequestVerb(verb: 'review' | 'link-pr', payload: Record<string, unknown>): AgentVerbRequest {
  const parsed = AgentPullRequestRequest.safeParse(payload);
  if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
  const pullRequestKey = pullRequestKeyFromReference(parsed.data.pr);
  if (!pullRequestKey) return { ok: false, status: INVALID_BODY_STATUS, error: 'pr must be a GitHub pull request url or owner/repo#number' };
  return { ok: true, verb, pullRequestKey };
}

function parseAgentVerb(verb: string, payload: Record<string, unknown>): AgentVerbRequest {
  if (!isAgentApiVerb(verb)) return { ok: false, status: REFUSAL_STATUS, error: REFUSAL_REASON };
  if (verb === 'board' || verb === 'push' || verb === 'limits' || verb === 'reviews' || verb === 'prs') return { ok: true, verb };
  if (verb === 'review' || verb === 'link-pr') return parsePullRequestVerb(verb, payload);
  if (verb === 'settings') {
    const parsed = AgentSettingsRequest.safeParse(payload);
    if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
    return { ok: true, verb, request: parsed.data };
  }
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

function projectReviews({ configured, reason, inFlight, queued, drafts }: TeamReviewStatus): AgentReviewsReply {
  const identity = ({ key, title, url, author }: { key: string; title: string; url: string; author: string }) => ({ key, title, url, author });
  return {
    ok: true,
    configured,
    reason: reason ?? null,
    reviewing: inFlight.map((review) => ({ ...identity(review), phase: review.phase })),
    queued: queued.map(identity),
    drafts: drafts.map((draft) => ({
      ...identity(draft),
      status: draft.status,
      verdict: draft.verdict,
      summary: draft.summary,
      comments: draft.comments.length,
      isOutOfDate: draft.liveHead !== undefined && draft.liveHead !== draft.reviewedHead,
    })),
  };
}

function projectMyPrs(snapshot: MyPrsSnapshot | null): AgentPrsReply {
  if (!snapshot) return { ok: true, configured: false, prs: [] };
  return {
    ok: true,
    configured: snapshot.configured,
    prs: snapshot.prs.map((pr) => ({
      key: pr.key, title: pr.title, url: pr.url, state: pr.state, isDraft: pr.isDraft, stage: pr.stage, reviewDecision: pr.reviewDecision,
      approvals: pr.approvals, unresolvedThreads: pr.unresolvedThreads, behindBy: pr.behindBy, mergeable: pr.mergeable,
      isInMergeQueue: pr.isInMergeQueue, checks: { state: pr.checks.state, failing: pr.checks.failing },
    })),
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
  decideAgentRequest, decideAttentionAllowance, decideEditAllowance, decideLinkPrAllowance, decideOperatorStateAllowance, decideSpawnAllowance, deriveChildSessionName, describePushLanding,
  describePushRouteRefusal, isAgentApiVerb, parseAgentVerb, projectMyPrs, projectReviews, tokensMatch, MAX_LIFETIME_SPAWNS, MAX_LIVE_CHILDREN,
  REFUSAL_REASON, REFUSAL_STATUS,
};
