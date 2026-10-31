
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';

import { resolveHookTarget } from '../session/core/hook-relay-core.ts';
import { formatSessionLimits } from '../session/core/session-routes.ts';
import { AgentLimitsReply, AGENT_URL_ENV, SHOWN_CAPTION_MAX_CHARS, SHOWN_FILE_CAP_BYTES } from '../shared/contracts/session.ts';
import type { AgentApiVerb } from '../shared/contracts/session.ts';
import { UNIT_STATUSES, WhiteboardAgentReply } from '../shared/contracts/whiteboard.ts';
import type { Board, BoardChange, BoardReview, BoardSummary, Op } from '../shared/contracts/whiteboard.ts';
import { layoutBoard } from '../shared/whiteboard-layout-core.ts';
import type { BoardLayout } from '../shared/whiteboard-layout-core.ts';
import { planSteps } from '../shared/whiteboard-plan-core.ts';
import { boardSvgDocument } from '../shared/whiteboard-svg-core.ts';
import { AGENT_COMMAND_HELP, agentCommandSpec, isAgentApiVerb } from './core/agent-api-core.ts';
import { parseCommand } from './core/cli-spec-core.ts';
import type { ParsedCommand } from './core/cli-spec-core.ts';
import { parseJsonOrNull } from './core/json-core.ts';
import { describeOverCap } from './core/shown-files-core.ts';

const AGENT_PATH_PREFIX = '/agent/';
const HELP_LIMITS_TIMEOUT_MS = 2000;
const HELP_LIMITS_UNKNOWN_LINE = 'This session: Glimmervoid did not report its limits, so run glimmervoid limits to see why';

type ParsedArguments = Extract<ParsedCommand, { kind: 'run' }>;
type BodyBuilder = (parsed: ParsedArguments) => Record<string, unknown> | null;

function joinedText(words: readonly string[]): string {
  return words.join(' ').trim();
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
  if (subcommand === 'list') return { sub: 'list' };
  if (subcommand === 'new') return joined ? { sub: 'new', title: joined } : null;
  if (subcommand === 'connect' || subcommand === 'disconnect' || subcommand === 'get' || subcommand === 'delete') return joined ? { sub: subcommand, board: joined } : null;
  const [board, ...argumentWords] = positionals;
  const opsFilePath = typeof values.file === 'string' ? values.file : null;
  if (!board || (argumentWords.length === 0 && opsFilePath === null)) return null;
  if (subcommand === 'resolve') return { sub: 'resolve', board, note: joinedText(argumentWords) };
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

const BODY_BUILDERS: Record<Exclude<AgentApiVerb, 'show'>, BodyBuilder> = {
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
  board: () => ({}),
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
  whiteboard: whiteboardBody,
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

interface HttpTarget {
  hostname: string;
  port: string;
  path: string;
  headers: Record<string, string>;
}

function requestOverHttp(target: HttpTarget, deadline: AbortSignal | null, sendBody: (request: http.ClientRequest) => void): Promise<AgentReply> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      method: 'POST',
      path: target.path,
      headers: target.headers,
      ...(deadline ? { signal: deadline } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const statusCode = response.statusCode ?? 0;
        resolve({ hasSuccessStatus: statusCode >= 200 && statusCode < 300, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.on('error', reject);
    sendBody(request);
  });
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

interface ShowRequest {
  filePaths: string[];
  caption: string | null;
}

interface FileToShow {
  filePath: string;
  name: string;
  sizeBytes: number;
}

function showRequestOf({ values, positionals }: ParsedArguments): ShowRequest {
  const caption = typeof values.caption === 'string' ? values.caption.trim().slice(0, SHOWN_CAPTION_MAX_CHARS) : '';
  return { filePaths: positionals, caption: caption || null };
}

async function statFileToShow(filePath: string): Promise<FileToShow | string> {
  const absolutePath = path.resolve(filePath);
  const stats = await fs.promises.stat(absolutePath).catch(() => null);
  if (!stats?.isFile()) return `${filePath} is not a file this session can read`;
  if (stats.size > SHOWN_FILE_CAP_BYTES) return describeOverCap(filePath, stats.size);
  return { filePath: absolutePath, name: path.basename(absolutePath), sizeBytes: stats.size };
}

function showHeaders(token: string, file: FileToShow, caption: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/octet-stream',
    'content-length': String(file.sizeBytes),
    'x-glimmervoid-show-name': encodeURIComponent(file.name),
  };
  if (caption) headers['x-glimmervoid-show-caption'] = encodeURIComponent(caption);
  return headers;
}

function streamFileBody(filePath: string): (request: http.ClientRequest) => void {
  return (request) => {
    pipeline(fs.createReadStream(filePath), request, (error) => {
      if (error) request.destroy(error);
    });
  };
}

async function postFileToShow(endpoint: URL, token: string, file: FileToShow, caption: string | null): Promise<AgentReply> {
  const headers = showHeaders(token, file, caption);
  const directTarget: HttpTarget = { hostname: endpoint.hostname, port: endpoint.port, path: `${endpoint.pathname}${endpoint.search}`, headers };
  return requestOverHttp(directTarget, null, streamFileBody(file.filePath));
}

function replyError(replyText: string): string {
  const reply: unknown = parseJsonOrNull(replyText);
  const error = typeof reply === 'object' && reply !== null ? (reply as { error?: unknown }).error : null;
  return typeof error === 'string' ? error : `Glimmervoid answered ${replyText || 'nothing'}`;
}

async function runShowCommand(parsed: ParsedArguments): Promise<number> {
  const request = showRequestOf(parsed);
  const target = sessionEndpoint('show');
  if (!target.ok) {
    console.error(target.error);
    return 1;
  }
  const filesToShow: FileToShow[] = [];
  for (const filePath of request.filePaths) {
    const checked = await statFileToShow(filePath);
    if (typeof checked === 'string') {
      console.log(JSON.stringify({ ok: false, error: checked, shown: [] }));
      return 1;
    }
    filesToShow.push(checked);
  }
  const shown: unknown[] = [];
  for (const file of filesToShow) {
    const reply = await postFileToShow(target.endpoint, target.token, file, request.caption);
    if (!reply.hasSuccessStatus || !bodySaysOk(reply.text)) {
      console.log(JSON.stringify({ ok: false, error: replyError(reply.text), shown }));
      return 1;
    }
    shown.push((parseJsonOrNull(reply.text) as { shown?: unknown } | null)?.shown ?? { name: file.name });
  }
  console.log(JSON.stringify({ ok: true, shown }));
  return 0;
}

const MAX_UNIT_ID_LENGTH = 40;

type PlanReply = { ok: boolean; text: string };

function unitIdFromTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, MAX_UNIT_ID_LENGTH).replace(/-+$/, '');
  return slug || 'unit';
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

async function listBoards(): Promise<BoardSummary[] | string> {
  const reply = await askWhiteboard({ sub: 'list' });
  if (typeof reply === 'string') return reply;
  return 'boards' in reply ? reply.boards : 'Glimmervoid did not list the boards';
}

async function resolveLinkedBoardId(ref: string): Promise<{ boardId: string } | { error: string }> {
  const boards = await listBoards();
  if (typeof boards === 'string') return { error: boards };
  const byId = boards.find((board) => board.id === ref);
  if (byId) return { boardId: byId.id };
  const byTitle = boards.filter((board) => board.title.toLowerCase() === ref.trim().toLowerCase());
  if (byTitle.length === 1 && byTitle[0]) return { boardId: byTitle[0].id };
  if (byTitle.length > 1) return { error: `${byTitle.length} boards are titled "${ref}", so link it by id` };
  return { error: `no board is called ${ref}, so run glimmervoid whiteboard list to see the boards` };
}

async function putPlanOps(boardRef: string, ops: Op[], doneText: string): Promise<PlanReply> {
  const reply = await askWhiteboard({ sub: 'put', board: boardRef, ops });
  if (typeof reply === 'string') return { ok: false, text: reply };
  return { ok: true, text: doneText };
}

async function addUnit({ values, positionals }: ParsedArguments, boardRef: string): Promise<PlanReply> {
  const title = joinedText(positionals.slice(1));
  const unitId = typeof values.id === 'string' ? values.id : unitIdFromTitle(title);
  const linkRef = typeof values.link === 'string' ? values.link : null;
  const link = linkRef === null ? { boardId: null } : await resolveLinkedBoardId(linkRef);
  if ('error' in link) return { ok: false, text: link.error };
  const ops: Op[] = [{ op: 'add', element: { kind: 'unit', id: unitId, title, lines: [], refs: [], status: 'planned', after: commaSeparatedIds(values.after), linkedBoardId: link.boardId } }];
  return putPlanOps(boardRef, ops, `added unit ${unitId} "${title}"; run glimmervoid whiteboard plan show ${boardRef} for the order`);
}

function setUnitAfter(boardRef: string, unitId: string, afterIds: string[]): Promise<PlanReply> {
  const ops: Op[] = [{ op: 'set', id: unitId, fields: { after: afterIds } }];
  const doneText = afterIds.length === 0 ? `${unitId} now comes after nothing` : `${unitId} now comes after ${afterIds.join(', ')}`;
  return putPlanOps(boardRef, ops, doneText);
}

function setUnitStatus(boardRef: string, unitId: string, statusText: string): Promise<PlanReply> {
  const status = UNIT_STATUSES.find((candidate) => candidate === statusText);
  if (!status) return Promise.resolve({ ok: false, text: `a unit status is ${UNIT_STATUSES.join(', ')}, not ${statusText}` });
  return putPlanOps(boardRef, [{ op: 'set', id: unitId, fields: { status } }], `${unitId} is now ${status}; run glimmervoid whiteboard get ${boardRef} --layout to check it against the code session changes`);
}

function formatPlan(board: Board, boards: readonly BoardSummary[], changes: readonly BoardChange[]): string {
  const steps = planSteps(board);
  if (steps.length === 0) return `Board "${board.title}" has no plan yet; add a unit with glimmervoid whiteboard plan add ${board.id} <title>`;
  const titleById = new Map(boards.map((summary) => [summary.id, summary.title]));
  const labelWidth = Math.max(...steps.map((step) => step.label.length));
  const idWidth = Math.max(...steps.map((step) => step.unitId.length));
  const statusWidth = Math.max(...steps.map((step) => step.status.length));
  const lines = [`Plan on "${board.title}" (${steps.length} ${steps.length === 1 ? 'unit' : 'units'})`];
  for (const step of steps) {
    const after = step.afterLabels.length > 0 ? `  after ${step.afterLabels.join(', ')}` : '';
    const link = step.linkedBoardId === null ? '' : `  board "${titleById.get(step.linkedBoardId) ?? step.linkedBoardId}"`;
    lines.push(`${step.label.padEnd(labelWidth)}  ${step.unitId.padEnd(idWidth)}  ${step.status.padEnd(statusWidth)}  ${step.title}${after}${link}`);
  }
  if (changes.length > 0) lines.push('', 'Changes since this session last read the board:', ...changes.map((change) => `- ${change.summary}`));
  return lines.join('\n');
}

async function showPlan(boardRef: string): Promise<PlanReply> {
  const reply = await askWhiteboard({ sub: 'get', board: boardRef });
  if (typeof reply === 'string') return { ok: false, text: reply };
  if (!('changes' in reply)) return { ok: false, text: 'Glimmervoid did not return the board' };
  const boards = await listBoards();
  return { ok: true, text: formatPlan(reply.board, typeof boards === 'string' ? [] : boards, reply.changes) };
}

function runPlanAction(parsed: ParsedArguments, boardRef: string): Promise<PlanReply> {
  const action = parsed.commandPath[2];
  if (action === 'add') return addUnit(parsed, boardRef);
  if (action === 'after') return setUnitAfter(boardRef, parsed.positionals[1] ?? '', parsed.positionals.slice(2));
  if (action === 'status') return setUnitStatus(boardRef, parsed.positionals[1] ?? '', parsed.positionals[2] ?? '');
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
    columns: layout.columns.map((column) => ({ id: column.id, x: column.x, width: column.width })),
    elements: placed,
    wires,
    warnings: layout.warnings,
  };
}

async function fetchReviewedBoard(boardRef: string): Promise<{ board: Board; review: BoardReview | null } | string> {
  const reply = await askWhiteboard({ sub: 'get', board: boardRef, peek: true, review: true });
  if (typeof reply === 'string') return reply;
  if (!('changes' in reply)) return 'Glimmervoid did not return the board';
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
  if (verb === 'show') return runShowCommand(parsed);
  if (verb === 'whiteboard' && parsed.commandPath[1] === 'plan') return runPlanCommand(parsed);
  if (verb === 'whiteboard' && isLayoutCommand(parsed)) return runLayoutCommand(parsed);
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
  console.log(reply.text);
  return reply.hasSuccessStatus && bodySaysOk(reply.text) ? 0 : 1;
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
