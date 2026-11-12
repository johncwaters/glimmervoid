
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { resolveHookTarget } from '../session/core/hook-relay-core.ts';
import { formatSessionLimits } from '../session/core/session-routes.ts';
import { AgentNeedReply } from '../shared/contracts/secrets.ts';
import { AgentLimitsReply, AGENT_URL_ENV } from '../shared/contracts/session.ts';
import type { AgentApiVerb } from '../shared/contracts/session.ts';
import { Op, STEP_STATUSES, WhiteboardAgentReply } from '../shared/contracts/whiteboard.ts';
import type { Board, BoardChange, BoardReview, Op as BoardOp } from '../shared/contracts/whiteboard.ts';
import { layoutBoard } from '../shared/whiteboard-layout-core.ts';
import type { BoardLayout } from '../shared/whiteboard-layout-core.ts';
import { dependencyWireId, dependencyWireIdsInto, planSteps, stepBoxesOf } from '../shared/whiteboard-plan-core.ts';
import { boardSvgDocument } from '../shared/whiteboard-svg-core.ts';
import { AGENT_COMMAND_HELP, agentCommandSpec, isAgentApiVerb } from './core/agent-api-core.ts';
import { parseCommand } from './core/cli-spec-core.ts';
import type { ParsedCommand } from './core/cli-spec-core.ts';
import { parseJsonOrNull } from './core/json-core.ts';
import { needExitCode } from './secrets/core/secrets-broker-core.ts';
import { clock } from '../shared/clock.ts';

const AGENT_PATH_PREFIX = '/agent/';
const HELP_LIMITS_TIMEOUT_MS = 2000;
const NEED_WAIT_LIMIT_MS = 5 * 60 * 1000;
const NEED_POLL_INTERVAL_MS = 3000;
const HELP_LIMITS_UNKNOWN_LINE = 'This session: Glimmervoid did not report its limits, so run glimmervoid limits to see why';

type ParsedArguments = Extract<ParsedCommand, { kind: 'run' }>;
type BodyBuilder = (parsed: ParsedArguments) => Record<string, unknown> | null;

function joinedText(words: readonly string[]): string {
  return words.join(' ').trim();
}

function absoluteWhyTarget(target: string): string {
  const separatorAt = target.lastIndexOf(':');
  if (separatorAt <= 0) return target;
  return `${path.resolve(target.slice(0, separatorAt))}${target.slice(separatorAt)}`;
}

function pullRequestBody({ positionals }: ParsedArguments): Record<string, unknown> | null {
  const pullRequest = joinedText(positionals);
  return pullRequest ? { pr: pullRequest } : null;
}

function readTextFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(path.resolve(filePath), 'utf8');
  } catch {
    return '';
  }
}

function readOpsArgument(opsText: string, opsFilePath: string | null): unknown {
  if (opsFilePath !== null) return opsText ? null : parseJsonOrNull(readTextFileOrEmpty(opsFilePath));
  if (opsText === '-') return parseJsonOrNull(fs.readFileSync(0, 'utf8'));
  return parseJsonOrNull(opsText);
}

function whiteboardBody({ commandPath, positionals, values }: ParsedArguments): Record<string, unknown> | null {
  const subcommand = commandPath[1];
  const joined = joinedText(positionals);
  if (subcommand === 'list') return values.all === true ? { sub: 'list', all: true } : { sub: 'list' };
  if (subcommand === 'new') return joined ? { sub: 'new', title: joined } : null;
  if (subcommand === 'connect' || subcommand === 'disconnect' || subcommand === 'get' || subcommand === 'delete') return joined ? { sub: subcommand, board: joined } : null;
  if (subcommand === 'attach') return joined ? { sub: 'attach', path: path.resolve(joined) } : null;
  const [board, ...argumentWords] = positionals;
  const opsFilePath = typeof values.file === 'string' ? values.file : null;
  if (!board || (argumentWords.length === 0 && opsFilePath === null)) return null;
  if (subcommand === 'doc') return { sub: 'doc', board, box: joinedText(argumentWords) };
  if (subcommand !== 'put') return null;
  const ops = readOpsArgument(argumentWords.join(' '), opsFilePath);
  if (ops === null) return null;
  return { sub: 'put', board, ops: Array.isArray(ops) ? ops : [ops] };
}

function answerBody({ values, positionals }: ParsedArguments): Record<string, unknown> | null {
  const [child, answerText, ...extra] = positionals;
  if (!child?.trim() || extra.length > 0) return null;
  if (values.operator === true) return answerText === undefined ? { child, toOperator: true } : null;
  if (answerText === undefined) return null;
  const answers: unknown = parseJsonOrNull(answerText);
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return null;
  if (!Object.values(answers).every((answer) => typeof answer === 'string')) return null;
  return { child, answers };
}

function arenaStartBody(specText: string | undefined): Record<string, unknown> | null {
  const spec = parseJsonOrNull(specText ?? '');
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return null;
  return { sub: 'start', spec };
}

function arenaBody({ positionals: [sub, ...actionArguments] }: ParsedArguments): Record<string, unknown> | null {
  if (!sub) return null;
  if (sub === 'start') return arenaStartBody(actionArguments[0]);
  const [race, contestant] = actionArguments;
  return { sub, ...(race === undefined ? {} : { race }), ...(contestant === undefined ? {} : { contestant }) };
}

function wakeBody({ positionals: [sub, ...actionArguments] }: ParsedArguments): Record<string, unknown> | null {
  if (!sub) return null;
  if (sub === 'list') return { sub };
  if (sub === 'cancel') return { sub, wake: actionArguments[0] ?? '' };
  const [when, ...textWords] = actionArguments;
  return { sub, when: when ?? '', text: joinedText(textWords) };
}

const BODY_BUILDERS: Record<AgentApiVerb, BodyBuilder> = {
  spawn: ({ positionals }) => {
    const prompt = joinedText(positionals);
    return prompt ? { prompt } : null;
  },
  send: ({ positionals }) => (joinedText(positionals) ? { words: positionals } : null),
  read: ({ positionals }) => {
    const child = joinedText(positionals);
    return child ? { child } : {};
  },
  close: ({ values, positionals }) => {
    const child = joinedText(positionals);
    if (!child) return null;
    return values.discard === true ? { child, discard: true } : { child };
  },
  answer: answerBody,
  attention: ({ positionals }) => {
    const note = joinedText(positionals);
    return note ? { note } : null;
  },
  sessions: () => ({}),
  push: () => ({}),
  edit: ({ positionals }) => {
    const docPath = joinedText(positionals);
    return docPath ? { path: path.resolve(docPath) } : null;
  },
  limits: () => ({}),
  review: pullRequestBody,
  reviews: (parsed) => pullRequestBody(parsed) ?? {},
  prs: () => ({}),
  'link-pr': pullRequestBody,
  settings: ({ positionals: [command, settingPath] }) => ({ command, ...(settingPath === undefined ? {} : { path: settingPath }) }),
  why: ({ positionals: [target] }) => (target ? { target: absoluteWhyTarget(target) } : null),
  whiteboard: whiteboardBody,
  packs: ({ positionals: [command, packPath] }) => ({ command, ...(packPath === undefined ? {} : { path: path.resolve(packPath) }) }),
  need: ({ positionals }) => (positionals.length > 0 ? { names: positionals } : null),
  arena: arenaBody,
  comments: ({ positionals: [command, commentId, ...words] }) => ({ command, ...(commentId === undefined ? {} : { commentId }), ...(words.length === 0 ? {} : { text: words.join(' ') }) }),
  wake: wakeBody,
  checkout: ({ positionals: [repo] }) => (repo ? { repo: /[\\/]|^\./.test(repo) ? path.resolve(repo) : repo } : null),
};

function bodySaysOk(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && (parsed as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

function limitsLines(replyText: string): string[] | null {
  const limits = AgentLimitsReply.safeParse(parseJsonOrNull(replyText));
  if (!limits.success) return null;
  return formatSessionLimits(limits.data);
}

type EndpointResolution = { ok: true; endpoint: URL; token: string } | { ok: false };

function verbEndpoint(rawUrl: string, verb: AgentApiVerb): EndpointResolution {
  const target = resolveHookTarget(rawUrl, verb, AGENT_PATH_PREFIX);
  if (!target.url) return { ok: false };
  const endpoint = new URL(target.url);
  const token = endpoint.searchParams.get('t') || '';
  endpoint.search = '';
  return { ok: true, endpoint, token };
}

interface AgentReply {
  hasSuccessStatus: boolean;
  text: string;
}

interface AgentPost {
  endpoint: URL;
  headers: Record<string, string>;
  bodyText: string;
  deadline: AbortSignal | null;
}

async function postDirectly({ endpoint, headers, bodyText, deadline }: AgentPost): Promise<AgentReply> {
  const response = await fetch(endpoint, { method: 'POST', headers, body: bodyText, signal: deadline });
  return { hasSuccessStatus: response.ok, text: await response.text() };
}

interface AgentIngressCall {
  endpoint: URL;
  token: string;
  body: Record<string, unknown>;
  deadline?: AbortSignal | null;
}

async function postToAgentIngress({ endpoint, token, body, deadline = null }: AgentIngressCall): Promise<AgentReply> {
  const post: AgentPost = {
    endpoint,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    bodyText: JSON.stringify(body),
    deadline,
  };
  return postDirectly(post);
}

async function sessionLimitsHelpLines({ timeoutMs = HELP_LIMITS_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string[]> {
  const rawUrl = process.env[AGENT_URL_ENV];
  if (!rawUrl) return [];
  const target = verbEndpoint(rawUrl, 'limits');
  if (!target.ok) return [HELP_LIMITS_UNKNOWN_LINE];
  try {
    const reply = await postToAgentIngress({ endpoint: target.endpoint, token: target.token, body: {}, deadline: AbortSignal.timeout(timeoutMs) });
    return limitsLines(reply.text) ?? [HELP_LIMITS_UNKNOWN_LINE];
  } catch {
    return [HELP_LIMITS_UNKNOWN_LINE];
  }
}

const MAX_STEP_ID_LENGTH = 40;

type PlanReply = { ok: boolean; text: string };

function stepIdFromTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, MAX_STEP_ID_LENGTH).replace(/-+$/, '');
  return slug || 'step';
}

function commaSeparatedIds(text: string | boolean | undefined): string[] {
  if (typeof text !== 'string') return [];
  return text.split(',').map((id) => id.trim()).filter(Boolean);
}

async function askWhiteboard(body: Record<string, unknown>): Promise<WhiteboardAgentReply | string> {
  const reply: unknown = await askAgentApi('whiteboard', body);
  const parsed = WhiteboardAgentReply.safeParse(reply);
  if (parsed.success) return parsed.data;
  const error = typeof reply === 'object' && reply !== null ? (reply as { error?: unknown }).error : null;
  return typeof error === 'string' ? error : 'Glimmervoid gave no usable answer';
}

async function putPlanOps(boardRef: string, ops: BoardOp[], doneText: string): Promise<PlanReply> {
  const reply = await askWhiteboard({ sub: 'put', board: boardRef, ops });
  if (typeof reply === 'string') return { ok: false, text: reply };
  return { ok: true, text: doneText };
}

async function readBoard(boardRef: string, { isPeek }: { isPeek: boolean }): Promise<{ board: Board; changes: BoardChange[] } | string> {
  const reply = await askWhiteboard({ sub: 'get', board: boardRef, whole: true, ...(isPeek ? { peek: true } : {}) });
  if (typeof reply === 'string') return reply;
  if (!('changes' in reply) || 'outline' in reply) return 'Glimmervoid did not return the board';
  return { board: reply.board, changes: reply.changes };
}

function parsedOps(rawOps: readonly unknown[]): BoardOp[] | string {
  const parsed = z.array(Op).safeParse(rawOps);
  if (parsed.success) return parsed.data;
  return parsed.error.issues.map((issue) => issue.message).join('; ');
}

function dependencyWireOps(board: Board, stepId: string, afterIds: readonly string[]): unknown[] | string {
  const stepIds = new Set(stepBoxesOf(board).map((stepBox) => stepBox.id));
  const notAStep = afterIds.find((afterId) => afterId === stepId || !stepIds.has(afterId));
  if (notAStep === stepId) return `${stepId} cannot come after itself`;
  if (notAStep !== undefined) return `${notAStep} is not a plan step on this board`;
  const takenIds = new Set([...board.elements.keys()]);
  return afterIds.map((afterId) => {
    const id = dependencyWireId(afterId, stepId, takenIds);
    takenIds.add(id);
    return { op: 'add', element: { kind: 'wire', id, from: afterId, to: stepId } };
  });
}

async function addStep({ values, positionals }: ParsedArguments, boardRef: string): Promise<PlanReply> {
  const title = joinedText(positionals.slice(1));
  const stepId = typeof values.id === 'string' ? values.id : stepIdFromTitle(title);
  const read = await readBoard(boardRef, { isPeek: true });
  if (typeof read === 'string') return { ok: false, text: read };
  const wireOps = dependencyWireOps(read.board, stepId, commaSeparatedIds(values.after));
  if (typeof wireOps === 'string') return { ok: false, text: wireOps };
  const ops = parsedOps([
    { op: 'add', element: { kind: 'box', id: stepId, title, place: 'plan', step: { status: 'planned' } } },
    ...wireOps,
  ]);
  if (typeof ops === 'string') return { ok: false, text: ops };
  return putPlanOps(boardRef, ops, `added step ${stepId} "${title}"; run glimmervoid whiteboard plan show ${boardRef} for the order`);
}

async function boardWithStep(boardRef: string, stepId: string): Promise<Board | string> {
  const read = await readBoard(boardRef, { isPeek: true });
  if (typeof read === 'string') return read;
  const element = read.board.elements.get(stepId);
  if (element?.kind !== 'box' || element.step === null) return `${stepId} is not a plan step on ${boardRef}`;
  return read.board;
}

async function setStepAfter(boardRef: string, stepId: string, afterIds: string[]): Promise<PlanReply> {
  const board = await boardWithStep(boardRef, stepId);
  if (typeof board === 'string') return { ok: false, text: board };
  const wireOps = dependencyWireOps(board, stepId, afterIds);
  if (typeof wireOps === 'string') return { ok: false, text: wireOps };
  const removals = dependencyWireIdsInto(board, stepId).map((id) => ({ op: 'remove', id }));
  const ops = parsedOps([...removals, ...wireOps]);
  if (typeof ops === 'string') return { ok: false, text: ops };
  const doneText = afterIds.length === 0 ? `${stepId} now comes after nothing` : `${stepId} now comes after ${afterIds.join(', ')}`;
  return putPlanOps(boardRef, ops, doneText);
}

async function setStepStatus(boardRef: string, stepId: string, statusText: string): Promise<PlanReply> {
  const status = STEP_STATUSES.find((candidate) => candidate === statusText);
  if (!status) return { ok: false, text: `a step status is ${STEP_STATUSES.join(', ')}, not ${statusText}` };
  const board = await boardWithStep(boardRef, stepId);
  if (typeof board === 'string') return { ok: false, text: board };
  return putPlanOps(boardRef, [{ op: 'set', id: stepId, fields: { step: { status } } }], `${stepId} is now ${status}; run glimmervoid whiteboard get ${boardRef} --layout to check it against the code session changes`);
}

function formatPlan(board: Board, changes: readonly BoardChange[]): string {
  const steps = planSteps(board);
  if (steps.length === 0) return `Board "${board.title}" has no plan yet; add a step with glimmervoid whiteboard plan add ${board.id} <title>`;
  const labelWidth = Math.max(...steps.map((step) => step.label.length));
  const idWidth = Math.max(...steps.map((step) => step.boxId.length));
  const statusWidth = Math.max(...steps.map((step) => step.status.length));
  const lines = [`Plan on "${board.title}" (${steps.length} ${steps.length === 1 ? 'step' : 'steps'})`];
  for (const step of steps) {
    const after = step.afterLabels.length > 0 ? `  after ${step.afterLabels.join(', ')}` : '';
    lines.push(`${step.label.padEnd(labelWidth)}  ${step.boxId.padEnd(idWidth)}  ${step.status.padEnd(statusWidth)}  ${step.title}${after}`);
  }
  if (changes.length > 0) lines.push('', 'Changes since this session last read the board:', ...changes.map((change) => `- ${change.summary}`));
  return lines.join('\n');
}

async function showPlan(boardRef: string): Promise<PlanReply> {
  const read = await readBoard(boardRef, { isPeek: false });
  if (typeof read === 'string') return { ok: false, text: read };
  return { ok: true, text: formatPlan(read.board, read.changes) };
}

function runPlanAction(parsed: ParsedArguments, boardRef: string): Promise<PlanReply> {
  const action = parsed.commandPath[2];
  if (action === 'add') return addStep(parsed, boardRef);
  if (action === 'after') return setStepAfter(boardRef, parsed.positionals[1] ?? '', parsed.positionals.slice(2));
  if (action === 'status') return setStepStatus(boardRef, parsed.positionals[1] ?? '', parsed.positionals[2] ?? '');
  return showPlan(boardRef);
}

async function runPlanCommand(parsed: ParsedArguments): Promise<number> {
  const boardRef = parsed.commandPath[2] === 'show' ? joinedText(parsed.positionals) : parsed.positionals[0] ?? '';
  const reply = await runPlanAction(parsed, boardRef);
  if (!reply.ok) {
    console.log(JSON.stringify({ ok: false, error: reply.text }));
    return 1;
  }
  console.log(reply.text);
  return 0;
}

function pointsOfPath(pathData: string): { x: number; y: number }[] {
  return [...pathData.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
}

function rectOf(element: { x: number; y: number; width: number; height: number }) {
  return { x: element.x, y: element.y, width: element.width, height: element.height };
}

function summarizeLayout(layout: BoardLayout) {
  const placed = layout.elements.flatMap((element) => (element.kind === 'wire' ? [] : [{ kind: element.kind, id: element.id, ...rectOf(element) }]));
  const wires = layout.elements.flatMap((element) => (element.kind === 'wire'
    ? [{ id: element.id, points: pointsOfPath(element.path), label: element.label, labelAt: element.label ? element.labelAt : null }]
    : []));
  return {
    ok: true,
    bounds: layout.bounds,
    elements: placed,
    wires,
    warnings: layout.warnings,
  };
}

async function fetchReviewedBoard(boardRef: string): Promise<{ board: Board; review: BoardReview | null } | string> {
  const reply = await askWhiteboard({ sub: 'get', board: boardRef, peek: true, review: true, whole: true });
  if (typeof reply === 'string') return reply;
  if (!('changes' in reply) || 'outline' in reply) return 'Glimmervoid did not return the board';
  return { board: reply.board, review: reply.review ?? null };
}

async function runLayoutCommand(parsed: ParsedArguments): Promise<number> {
  const isRender = parsed.commandPath[1] === 'render';
  const outPath = typeof parsed.values.out === 'string' ? parsed.values.out : null;
  if (isRender && outPath === null) {
    console.log(JSON.stringify({ ok: false, error: 'render needs --out <path>, for example "glimmervoid whiteboard render flow --out flow.svg"' }));
    return 1;
  }
  const fetched = await fetchReviewedBoard(joinedText(parsed.positionals));
  if (typeof fetched === 'string') {
    console.log(JSON.stringify({ ok: false, error: fetched }));
    return 1;
  }
  const layout = layoutBoard(fetched.board);
  if (outPath === null) {
    console.log(JSON.stringify({ ...summarizeLayout(layout), review: fetched.review }));
    return 0;
  }
  const absoluteOutPath = path.resolve(outPath);
  await fs.promises.writeFile(absoluteOutPath, boardSvgDocument(layout));
  console.log(JSON.stringify({ ok: true, wrote: absoluteOutPath, width: layout.bounds.width, height: layout.bounds.height, warnings: layout.warnings, review: fetched.review }));
  return 0;
}

function isLayoutCommand(parsed: ParsedArguments): boolean {
  const subcommand = parsed.commandPath[1];
  return subcommand === 'render' || (subcommand === 'get' && parsed.values.layout === true);
}

async function runAgentApiCli(args: string[]): Promise<number> {
  const verb = args[0];
  if (!verb || !isAgentApiVerb(verb)) {
    console.error(`glimmervoid: ${verb || 'that'} is not an agent command`);
    return 1;
  }
  const parsed = parseCommand(agentCommandSpec(verb), args.slice(1));
  if (parsed.kind === 'help') {
    console.log(parsed.text);
    return 0;
  }
  if (parsed.kind === 'refused') {
    console.error(parsed.text);
    return 1;
  }
  if (verb === 'whiteboard' && parsed.commandPath[1] === 'plan') return runPlanCommand(parsed);
  if (verb === 'whiteboard' && isLayoutCommand(parsed)) return runLayoutCommand(parsed);
  if (verb === 'need') return runNeedCommand(parsed);
  const body = BODY_BUILDERS[verb](parsed);
  if (!body) {
    console.error(`glimmervoid ${parsed.commandPath.join(' ')}: ${AGENT_COMMAND_HELP[verb].missingArgumentHint ?? 'those arguments are not understood'}; run it with --help for its usage`);
    return 1;
  }
  const target = sessionEndpoint(verb);
  if (!target.ok) {
    console.error(target.error);
    return 1;
  }
  const reply = await postToAgentIngress({ endpoint: target.endpoint, token: target.token, body });
  if (verb === 'whiteboard' && parsed.commandPath[1] === 'doc' && reply.hasSuccessStatus) return printDocText(reply.text);
  console.log(reply.text);
  return reply.hasSuccessStatus && bodySaysOk(reply.text) ? 0 : 1;
}

async function askNeedOnce(names: readonly string[]): Promise<AgentNeedReply | string> {
  const reply: unknown = await askAgentApi('need', { names }).catch((error: unknown) => ({ error: `Glimmervoid could not be reached: ${error instanceof Error ? error.message : String(error)}` }));
  const parsed = AgentNeedReply.safeParse(reply);
  if (parsed.success) return parsed.data;
  const error = typeof reply === 'object' && reply !== null ? (reply as { error?: unknown }).error : null;
  return typeof error === 'string' ? error : 'Glimmervoid gave no usable answer';
}

function isStillPending(reply: AgentNeedReply | string): boolean {
  if (typeof reply === 'string') return true;
  return reply.results.some((result) => result.status === 'pending');
}

async function waitedNeedReply(names: readonly string[], { isWaiting }: { isWaiting: boolean }): Promise<AgentNeedReply | string> {
  const deadlineMs = clock.nowMs() + NEED_WAIT_LIMIT_MS;
  let reply = await askNeedOnce(names);
  while (isWaiting && isStillPending(reply) && clock.nowMs() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, NEED_POLL_INTERVAL_MS));
    reply = await askNeedOnce(names);
  }
  return reply;
}

async function runNeedCommand(parsed: ParsedArguments): Promise<number> {
  const reply = await waitedNeedReply(parsed.positionals, { isWaiting: parsed.values.wait === true });
  if (typeof reply === 'string') {
    console.log(JSON.stringify({ ok: false, error: reply }));
    return 1;
  }
  console.log(JSON.stringify(reply));
  return needExitCode(Object.fromEntries(reply.results.map((result) => [result.name, result.status])));
}

function printDocText(replyText: string): number {
  const docReply = WhiteboardAgentReply.safeParse(parseJsonOrNull(replyText));
  if (!docReply.success || !('text' in docReply.data)) {
    console.log(replyText);
    return 1;
  }
  process.stdout.write(docReply.data.text);
  return 0;
}

function sessionEndpoint(verb: AgentApiVerb): { ok: true; endpoint: URL; token: string } | { ok: false; error: string } {
  const rawUrl = process.env[AGENT_URL_ENV];
  if (!rawUrl) return { ok: false, error: `glimmervoid: ${AGENT_URL_ENV} is not set, so this is not a Glimmervoid session` };
  const target = verbEndpoint(rawUrl, verb);
  if (!target.ok) return { ok: false, error: `glimmervoid: ${AGENT_URL_ENV} must be a loopback http url under ${AGENT_PATH_PREFIX}, so nothing was sent` };
  return target;
}

async function askAgentApi(verb: AgentApiVerb, body: Record<string, unknown>): Promise<unknown> {
  const target = sessionEndpoint(verb);
  if (!target.ok) return { ok: false, error: target.error };
  const reply = await postToAgentIngress({ endpoint: target.endpoint, token: target.token, body });
  return parseJsonOrNull(reply.text);
}

export { askAgentApi, postToAgentIngress, runAgentApiCli, sessionLimitsHelpLines };
