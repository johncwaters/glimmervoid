import crypto from 'node:crypto';

import type { z } from 'zod';

import { pullRequestKeyFromReference } from '../../shared/contracts/control-messages.ts';
import {
  AGENT_API_VERBS, AGENT_REPLY_SCHEMAS, AgentAnswerRequest, AgentAttentionRequest, AgentCloseRequest, AgentEditRequest, AgentPullRequestRequest, AgentReadRequest, AgentReviewsRequest, AgentSendRequest, AgentSettingsRequest, AgentSpawnRequest,
} from '../../shared/contracts/session.ts';
import type { AgentApiVerb, AgentPrsReply, AgentRefusal, AgentReplyBodyOf, AgentReviewDetailReply, AgentReviewsReply } from '../../shared/contracts/session.ts';
import type { MyPrsSnapshot } from '../../shared/contracts/my-prs.ts';
import { WhiteboardAgentRequest } from '../../shared/contracts/whiteboard.ts';
import { renderOverviewLine } from './cli-spec-core.ts';
import type { CommandSpec, OptionSpec, PositionalSpec } from './cli-spec-core.ts';
import type { TeamReviewStatus } from '../../shared/contracts/team-review.ts';
import { COMMAND_ROUTES, NO_OWN_WORKTREE_REASON } from '../../session/core/session-routes.ts';
import { extractPromptTaskTitle } from '../../session/core/task-title-core.ts';
import type { SessionRoleFacts } from '../../session/core/session-routes.ts';

const MAX_LIVE_CHILDREN = 3;
const MAX_LIFETIME_SPAWNS = 100;
const MAX_SPAWNS_IN_FLIGHT = 1;

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
}

type AgentVerdict = { ok: true } | { ok: false; status: number; reason: string };

type EmptyRequest = Record<string, never>;

interface PullRequestKeyRequest {
  pullRequestKey: string;
}

interface ReviewsRequest {
  pullRequestKey: string | null;
}

interface AgentRequestByVerb {
  spawn: AgentSpawnRequest;
  send: AgentSendRequest;
  read: AgentReadRequest;
  close: AgentCloseRequest;
  answer: AgentAnswerRequest;
  attention: AgentAttentionRequest;
  board: EmptyRequest;
  push: EmptyRequest;
  edit: AgentEditRequest;
  show: EmptyRequest;
  limits: EmptyRequest;
  review: PullRequestKeyRequest;
  reviews: ReviewsRequest;
  prs: EmptyRequest;
  'link-pr': PullRequestKeyRequest;
  settings: AgentSettingsRequest;
  whiteboard: WhiteboardAgentRequest;
}

type AgentRequestOf<V extends AgentApiVerb> = AgentRequestByVerb[V];
type AgentRequestRefusal = { ok: false; status: number; error: string };
type AgentVerbRequest = { ok: true; verb: AgentApiVerb; request: AgentRequestOf<AgentApiVerb> } | AgentRequestRefusal;
type RequestParser<Request> = (payload: Record<string, unknown>) => { ok: true; request: Request } | AgentRequestRefusal;

interface AgentRefusalReply {
  status: number;
  body: AgentRefusal;
}

interface AgentReplyOf<V extends AgentApiVerb> {
  status: number;
  body: AgentReplyBodyOf<V>;
}

const BROKEN_REPLY_STATUS = 500;

const INVALID_BODY_STATUS = 400;
const ROLE_REFUSED_STATUS = 403;
const PUSH_REFUSED_STATUS = 409;

interface PushLanding {
  merged: boolean;
  reason?: string | null;
  base?: string | null;
  pushed?: boolean;
  conflicts?: string[];
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

function decideSpawnAllowance({ liveChildren, lifetimeSpawns, inFlight }: SpawnBudget): AgentVerdict {
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

function describeRoleRefusal(verb: AgentApiVerb, caller: SessionRoleFacts): AgentRefusalReply | null {
  const route = COMMAND_ROUTES[verb](caller);
  if (route.answers) return null;
  if (route.code) return { status: PUSH_REFUSED_STATUS, body: { ok: false, reason: route.code, error: route.reason } };
  return { status: ROLE_REFUSED_STATUS, body: { ok: false, error: route.reason } };
}

function isAgentApiVerb(verb: string): verb is AgentApiVerb {
  return (AGENT_API_VERBS as readonly string[]).includes(verb);
}

function refuseInvalidBody(issues: readonly { message?: string }[]): AgentRequestRefusal {
  return { ok: false, status: INVALID_BODY_STATUS, error: issues[0]?.message || 'invalid request' };
}

function bodyParser<Request>(schema: z.ZodType<Request>): RequestParser<Request> {
  return (payload) => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
    return { ok: true, request: parsed.data };
  };
}

const parseEmptyBody: RequestParser<EmptyRequest> = () => ({ ok: true, request: {} });

const parsePullRequestBody: RequestParser<PullRequestKeyRequest> = (payload) => {
  const parsed = AgentPullRequestRequest.safeParse(payload);
  if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
  const pullRequestKey = pullRequestKeyFromReference(parsed.data.pr);
  if (!pullRequestKey) return { ok: false, status: INVALID_BODY_STATUS, error: 'pr must be a GitHub pull request url or owner/repo#number' };
  return { ok: true, request: { pullRequestKey } };
};

const parseReviewsBody: RequestParser<ReviewsRequest> = (payload) => {
  const parsed = AgentReviewsRequest.safeParse(payload);
  if (!parsed.success) return refuseInvalidBody(parsed.error.issues);
  if (parsed.data.pr === undefined) return { ok: true, request: { pullRequestKey: null } };
  const pullRequest = parsePullRequestBody({ pr: parsed.data.pr });
  if (!pullRequest.ok) return pullRequest;
  return { ok: true, request: { pullRequestKey: pullRequest.request.pullRequestKey } };
};

const REQUEST_PARSERS: { readonly [V in AgentApiVerb]: RequestParser<AgentRequestOf<V>> } = Object.freeze({
  spawn: bodyParser(AgentSpawnRequest),
  send: bodyParser(AgentSendRequest),
  read: bodyParser(AgentReadRequest),
  close: bodyParser(AgentCloseRequest),
  answer: bodyParser(AgentAnswerRequest),
  attention: bodyParser(AgentAttentionRequest),
  board: parseEmptyBody,
  push: parseEmptyBody,
  edit: bodyParser(AgentEditRequest),
  show: parseEmptyBody,
  limits: parseEmptyBody,
  review: parsePullRequestBody,
  reviews: parseReviewsBody,
  prs: parseEmptyBody,
  'link-pr': parsePullRequestBody,
  settings: bodyParser(AgentSettingsRequest),
  whiteboard: bodyParser(WhiteboardAgentRequest),
});

type CheckedAgentReply = { ok: true; reply: AgentReplyOf<AgentApiVerb> } | { ok: false; reply: AgentRefusalReply; issue: string };

function checkAgentReply(verb: AgentApiVerb, reply: { status: number; body: unknown }): CheckedAgentReply {
  const checked = AGENT_REPLY_SCHEMAS[verb].safeParse(reply.body);
  if (checked.success) return { ok: true, reply: { status: reply.status, body: checked.data } };
  const issue = checked.error.issues[0]?.message ?? 'unknown issue';
  return { ok: false, issue, reply: { status: BROKEN_REPLY_STATUS, body: { ok: false, error: `glimmervoid built a ${verb} reply that breaks its contract` } } };
}

function parseAgentVerb(verb: string, payload: Record<string, unknown>): AgentVerbRequest {
  if (!isAgentApiVerb(verb)) return { ok: false, status: REFUSAL_STATUS, error: REFUSAL_REASON };
  const parsed = REQUEST_PARSERS[verb](payload);
  if (!parsed.ok) return parsed;
  return { ok: true, verb, request: parsed.request };
}

interface ChildWorktree {
  worktreeDir: string;
  branch: string | null;
}

function describeChildWorktree({ worktreeDir, branch }: ChildWorktree): string {
  return branch ? `branch ${branch} at ${worktreeDir}` : worktreeDir;
}

function describeUnpushedCloseRefusal(childName: string, childId: string, worktree: ChildWorktree): string {
  return `${childName} holds work that is not on the integration branch (${describeChildWorktree(worktree)}), so it was not closed. Ask it to land the work with glimmervoid push (glimmervoid send ${childId} <text>), or run glimmervoid close ${childId} --discard to end it and throw the work away`;
}

type ChildEndCause = 'exited' | 'operator' | 'parent-closed' | 'parent-ended';

const CHILD_END_CAUSE_COPY: Readonly<Record<ChildEndCause, string>> = {
  exited: 'exited by itself',
  operator: 'closed by the operator',
  'parent-closed': 'closed by this session',
  'parent-ended': 'closed because this session ended',
};

function describeChildEndNote(
  childName: string, cause: ChildEndCause, outcome: { kind: 'discarded' | 'none' } | { kind: 'kept'; worktree: ChildWorktree },
): string {
  const ending = `${childName} ended: ${CHILD_END_CAUSE_COPY[cause]}`;
  if (outcome.kind === 'kept') return `${ending}, holding work that is not on the integration branch, so its worktree was kept: ${describeChildWorktree(outcome.worktree)}. The operator decides whether to merge or discard it`;
  if (outcome.kind === 'discarded') return `${ending}, and its worktree was discarded`;
  return ending;
}

function describeKeptChildAttention(childName: string, worktree: ChildWorktree): string {
  return `${childName}, a session this one spawned, ended holding unpushed work: ${describeChildWorktree(worktree)}`;
}

function describePushLanding(landing: PushLanding): AgentReplyOf<'push'> {
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

const UNTRUSTED_DRAFT_NOTE = 'the draft was written by a model that read the untrusted pull request, so verify each point before acting on it';

function projectReviewDetail({ drafts, inFlight, queued }: TeamReviewStatus, pullRequestKey: string): AgentReviewDetailReply | null {
  const requestedKey = pullRequestKey.toLowerCase();
  const isRequested = (review: { key: string }) => review.key.toLowerCase() === requestedKey;
  const running = inFlight.find(isRequested);
  const draft = drafts.find(isRequested);
  if (draft) return { ok: true, key: draft.key, state: 'drafted', phase: running?.phase ?? null, note: UNTRUSTED_DRAFT_NOTE, draft };
  if (running) return { ok: true, key: running.key, state: 'reviewing', phase: running.phase, note: null, draft: null };
  const waiting = queued.find(isRequested);
  if (!waiting) return null;
  return { ok: true, key: waiting.key, state: 'queued', phase: null, note: null, draft: null };
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

function deriveChildSessionName(
  { requestedName, brief, parentName }: { requestedName?: string; brief: string; parentName: string },
  existingNames: readonly string[],
): string {
  const briefTitle = requestedName ? null : extractPromptTaskTitle(brief);
  const base = briefTitle ?? `${String(requestedName || parentName || '').trim() || 'session'} agent`;
  const taken = new Set(existingNames);
  let candidate = base;
  let suffix = 1;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `${base} ${suffix}`;
  }
  return candidate;
}



interface AgentCommandHelp {
  usage: string;
  summary: string;
  whenToUse: string;
  missingArgumentHint: string | null;
  positionals?: PositionalSpec;
  options?: readonly OptionSpec[];
  subcommands?: readonly CommandSpec[];
  isPassthrough?: boolean;
}

function requiredText(usage: string): PositionalSpec {
  return { usage, min: 1, max: null };
}

function optionalText(usage: string): PositionalSpec {
  return { usage, min: 0, max: null };
}

const BOARD_REFERENCE = requiredText('<board>');

const PLAN_SUBCOMMANDS: readonly CommandSpec[] = [
  {
    name: 'add',
    summary: 'Add a unit of work to the plan on a board; a unit is any size, from one ticket to a whole pull request',
    positionals: { usage: '<board> <title>', min: 2, max: null },
    options: [
      { name: 'after', type: 'string', valueName: 'units', summary: 'Comma-separated ids of the units this one comes after' },
      { name: 'link', type: 'string', valueName: 'board', summary: 'Another board, by id or title, that holds this unit\'s detail' },
      { name: 'id', type: 'string', valueName: 'id', summary: 'The unit id, when the one made from its title is taken' },
    ],
    missingArgumentHint: 'plan add needs a board and a title, for example "glimmervoid whiteboard plan add release-plan Diff index schema"',
  },
  { name: 'after', summary: 'Set which units a unit comes after; naming none clears them. A dependency cycle is refused', positionals: { usage: '<board> <unit> [<unit>...]', min: 2, max: null }, missingArgumentHint: 'plan after needs a board and a unit' },
  { name: 'status', summary: 'Mark a unit planned, building or landed; Glimmervoid checks the mark against the code session changes', positionals: { usage: '<board> <unit> <planned|building|landed>', min: 3, max: 3 }, missingArgumentHint: 'plan status needs a board, a unit and a status, for example "glimmervoid whiteboard plan status release-plan diff-index landed"' },
  { name: 'show', summary: 'Print the plan on a board in dependency order; units that can run in parallel share a number, as 2a and 2b', positionals: BOARD_REFERENCE },
];

const WHITEBOARD_SUBCOMMANDS: readonly CommandSpec[] = [
  { name: 'new', summary: 'Create a board; this session is its creator and gets summaries of its changes', positionals: requiredText('<title>'), missingArgumentHint: 'a new board needs a title, for example "glimmervoid whiteboard new release plan"' },
  { name: 'list', summary: 'List the boards with their connected sessions' },
  { name: 'connect', summary: 'Get summaries of changes to a board in this session', positionals: BOARD_REFERENCE },
  { name: 'disconnect', summary: 'Stop getting summaries of changes to a board', positionals: BOARD_REFERENCE },
  {
    name: 'get',
    summary: 'Read a board and the changes since this session last read it; --layout prints where every box, wire and label landed instead',
    positionals: BOARD_REFERENCE,
    options: [{ name: 'layout', type: 'boolean', summary: 'Print the laid-out positions and layout warnings instead of the stored board' }],
  },
  {
    name: 'put',
    summary: 'Apply a JSON op or array of ops to a board; - reads them from stdin and --file reads them from a file',
    positionals: { usage: '<board> [<ops-json|->]', min: 1, max: null },
    options: [{ name: 'file', type: 'string', valueName: 'path', summary: 'A file holding the JSON op or array of ops' }],
    missingArgumentHint: 'put needs a board and ops, for example "glimmervoid whiteboard put flow --file ops.json"',
  },
  {
    name: 'render',
    summary: 'Draw a board as the dashboard does and write it to an SVG file',
    positionals: BOARD_REFERENCE,
    options: [{ name: 'out', type: 'string', valueName: 'path', summary: 'The SVG file to write' }],
    missingArgumentHint: 'render needs a board and --out, for example "glimmervoid whiteboard render flow --out flow.svg"',
  },
  { name: 'resolve', summary: 'Mark a note on a board resolved', positionals: { usage: '<board> <note>', min: 2, max: null } },
  { name: 'delete', summary: 'Delete a board this session created; the operator deletes any board from the dashboard', positionals: BOARD_REFERENCE },
  { name: 'plan', summary: 'Lay out units of work on a board in dependency order, beside its free drawing', subcommands: PLAN_SUBCOMMANDS, missingArgumentHint: null },
];

const AGENT_COMMAND_HELP: { readonly [V in AgentApiVerb]: AgentCommandHelp } = Object.freeze({
  spawn: {
    whenToUse: 'Use it for work that edits files or runs long; an in-process subagent stays fine for a quick read-only lookup',
    usage: 'spawn <prompt>',
    positionals: requiredText('<prompt>'),
    summary: 'Start a session on that prompt, with its own dashboard card, that this session owns until its task is done',
    missingArgumentHint: 'this command needs text, for example "glimmervoid spawn check the failing test"',
  },
  send: {
    whenToUse: 'Use it to steer a spawned session, or to report back to the parent',
    usage: 'send [child] <text>',
    positionals: requiredText('[child] <text>'),
    summary: 'Message a session this one spawned; a spawned session messages its parent with send <text>',
    missingArgumentHint: 'this command needs text, for example "glimmervoid send the tests pass" or, to a spawned session, "glimmervoid send <child> fix the failing test"',
  },
  read: {
    whenToUse: 'Use it when a spawned session or the parent has messaged this session',
    usage: 'read [child]',
    positionals: optionalText('[child]'),
    summary: "Read what this session's spawned sessions sent; a spawned session reads its parent's messages",
    missingArgumentHint: null,
  },
  close: {
    whenToUse: "Use it once a spawned session's work has landed or is no longer wanted",
    usage: 'close <child>',
    positionals: requiredText('<child>'),
    options: [{ name: 'discard', type: 'boolean', summary: 'Close it even though it holds unpushed work, which is lost' }],
    summary: 'End a session this one spawned and discard its worktree; refused while it holds unpushed work unless --discard',
    missingArgumentHint: 'this command needs the spawned session, for example "glimmervoid close <child>"',
  },
  answer: {
    whenToUse: 'Use it when a spawned session waits on a question this session can settle',
    usage: 'answer <child> <json>|--operator',
    positionals: { usage: '<child> [json]', min: 1, max: 2 },
    options: [{ name: 'operator', type: 'boolean', summary: 'Pass the question to the operator instead of answering it' }],
    summary: "Answer a spawned session's held question, or pass it to the operator with --operator",
    missingArgumentHint: 'this command needs a child and a JSON object of answers, or --operator',
  },
  attention: {
    whenToUse: 'Use it when the task is blocked on the operator, such as a refused call a retry will not change',
    usage: 'attention <note>',
    positionals: requiredText('<note>'),
    summary: 'Flag this session as needing the operator',
    missingArgumentHint: 'this command needs text, for example "glimmervoid attention check the failing test"',
  },
  board: { usage: 'board', whenToUse: 'Use it to see what other sessions are working on before touching shared code', summary: 'List the live sessions', missingArgumentHint: null },
  push: { usage: 'push', whenToUse: "Use it when this session's commits are ready to land", summary: "Land this session's commits on the integration branch and push it", missingArgumentHint: null },
  edit: {
    whenToUse: 'Use it when the operator should write or correct text, such as a plan or a prompt',
    usage: 'edit <path>',
    positionals: requiredText('<path>'),
    summary: 'Open a text file for the operator to edit in the dashboard',
    missingArgumentHint: 'this command needs a file path, for example "glimmervoid edit drafts/post.md"',
  },
  show: {
    whenToUse: 'Use it after making a screenshot, chart, recording or HTML page the operator should see',
    usage: 'show <path>... [--caption <text>]',
    positionals: requiredText('<path>...'),
    options: [{ name: 'caption', type: 'string', valueName: 'text', summary: 'A caption shown with the files' }],
    summary: "Show the operator an image, video or HTML page on this session's card",
    missingArgumentHint: 'this command needs a file path, for example "glimmervoid show out/diagram.png --caption \'the new layout\'"',
  },
  review: {
    whenToUse: 'Use it instead of gh pr review when a pull request needs a review the operator posts',
    usage: 'review <pr>',
    positionals: requiredText('<pr>'),
    summary: 'Queue a team review of a pull request; the draft waits in the Reviews tab for the operator to post',
    missingArgumentHint: 'this command needs a pull request, for example "glimmervoid review https://github.com/acme/app/pull/12" or "glimmervoid review acme/app#12"',
  },
  reviews: { usage: 'reviews [pr]', whenToUse: 'Use it to follow a queued review or read its draft', positionals: optionalText('[pr]'), summary: 'List the Reviews tab: reviews running, queued and drafted; with a pull request, read its draft in full', missingArgumentHint: null },
  prs: { usage: 'prs', whenToUse: "Use it to find which of the operator's pull requests need work", summary: "List the operator's open pull requests with their checks, reviews and merge state", missingArgumentHint: null },
  'link-pr': {
    whenToUse: "Use it after opening a pull request for this session's work",
    usage: 'link-pr <pr>',
    positionals: requiredText('<pr>'),
    summary: "Link a pull request to this session's card",
    missingArgumentHint: 'this command needs a pull request, for example "glimmervoid link-pr acme/app#12"',
  },
  settings: { usage: 'settings list|get', whenToUse: 'Use it instead of reading config.json', summary: "Read Glimmervoid's settings; a secret shows only as configured or not", missingArgumentHint: null, isPassthrough: true },
  whiteboard: {
    whenToUse: 'Use it to plan or explain a design with the operator or other sessions',
    usage: 'whiteboard new|list|connect|disconnect|get|put|render|resolve|delete|plan',
    subcommands: WHITEBOARD_SUBCOMMANDS,
    summary: 'Create, connect to, read, edit, plan on and delete a shared whiteboard the operator and connected sessions edit together',
    missingArgumentHint: null,
  },
  limits: { usage: 'limits', whenToUse: 'Use it when a command is refused, to see why', summary: 'List which of these commands answer here and why the rest do not', missingArgumentHint: null },
});

function agentCommandHelpLines(): string[] {
  return Object.values(AGENT_COMMAND_HELP).map(({ usage, summary, whenToUse }) => renderOverviewLine(usage, `${summary}. ${whenToUse}`));
}

function agentCommandSpec(verb: AgentApiVerb): CommandSpec {
  const { summary, missingArgumentHint, positionals, options, subcommands, isPassthrough } = AGENT_COMMAND_HELP[verb];
  return { name: verb, summary, missingArgumentHint, positionals, options, subcommands, isPassthrough };
}

export { checkAgentReply, decideAgentRequest, decideSpawnAllowance, deriveChildSessionName, describeChildEndNote, describeKeptChildAttention, describePushLanding, describeUnpushedCloseRefusal, describeRoleRefusal, isAgentApiVerb, parseAgentVerb, projectMyPrs, projectReviewDetail, projectReviews, MAX_LIVE_CHILDREN, REFUSAL_REASON, REFUSAL_STATUS, AGENT_COMMAND_HELP, agentCommandHelpLines, agentCommandSpec };
export type { AgentRefusalReply, AgentReplyOf, AgentRequestOf, ChildEndCause, ChildWorktree };
