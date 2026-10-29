
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';

import { resolveHookTarget } from '../session/core/hook-relay-core.ts';
import { formatSessionLimits } from '../session/core/session-routes.ts';
import { AgentLimitsReply, AGENT_URL_ENV, SHOWN_CAPTION_MAX_CHARS, SHOWN_FILE_CAP_BYTES } from '../shared/contracts/session.ts';
import type { AgentApiVerb } from '../shared/contracts/session.ts';
import { errorCode } from '../shared/text.ts';
import { decideGuardrailsProxy } from '../session/core/guardrails-proxy-core.ts';
import type { GuardrailsProxy } from '../session/core/guardrails-proxy-core.ts';
import { AGENT_COMMAND_HELP, isAgentApiVerb } from './core/agent-api-core.ts';
import { parseJsonOrNull } from './core/json-core.ts';
import { describeOverCap } from './core/shown-files-core.ts';

const AGENT_PATH_PREFIX = '/agent/';
const HELP_LIMITS_TIMEOUT_MS = 2000;
const HELP_LIMITS_UNKNOWN_LINE = 'This session: Glimmervoid did not report its limits, so run glimmervoid limits to see why';

type BodyBuilder = (rest: string[]) => Record<string, unknown> | null;

function pullRequestBody(rest: string[]): Record<string, unknown> | null {
  const pullRequest = rest.join(' ').trim();
  return pullRequest ? { pr: pullRequest } : null;
}

const BODY_BUILDERS: Record<Exclude<AgentApiVerb, 'show'>, BodyBuilder> = {
  spawn: (rest) => {
    const prompt = rest.join(' ').trim();
    return prompt ? { prompt } : null;
  },
  send: (rest) => (rest.join(' ').trim() ? { words: rest } : null),
  read: (rest) => {
    const child = rest.join(' ').trim();
    return child ? { child } : {};
  },
  close: (rest) => {
    const discard = rest.includes('--discard');
    const child = rest.filter((word) => word !== '--discard').join(' ').trim();
    if (!child) return null;
    return discard ? { child, discard } : { child };
  },
  answer: ([child, answerText, ...extra]) => {
    if (!child?.trim() || !answerText || extra.length > 0) return null;
    if (answerText === '--operator') return { child, toOperator: true };
    const answers: unknown = parseJsonOrNull(answerText);
    if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return null;
    if (!Object.values(answers).every((answer) => typeof answer === 'string')) return null;
    return { child, answers };
  },
  attention: (rest) => {
    const note = rest.join(' ').trim();
    return note ? { note } : null;
  },
  board: () => ({}),
  push: () => ({}),
  edit: (rest) => {
    const docPath = rest.join(' ').trim();
    return docPath ? { path: path.resolve(docPath) } : null;
  },
  limits: () => ({}),
  review: pullRequestBody,
  reviews: (rest) => pullRequestBody(rest) ?? {},
  prs: () => ({}),
  'link-pr': pullRequestBody,
  settings: ([command, settingPath]) => ({ command, ...(settingPath === undefined ? {} : { path: settingPath }) }),
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

function guardrailsProxyTarget(guardrailsProxy: GuardrailsProxy, endpoint: URL, headers: Record<string, string>): HttpTarget {
  const proxyHeaders: Record<string, string> = guardrailsProxy.authorization ? { 'proxy-authorization': guardrailsProxy.authorization } : {};
  return { hostname: guardrailsProxy.hostname, port: String(guardrailsProxy.port), path: endpoint.href, headers: { ...headers, ...proxyHeaders, host: endpoint.host } };
}

function postThroughGuardrailsProxy(guardrailsProxy: GuardrailsProxy, { endpoint, headers, bodyText, deadline }: AgentPost): Promise<AgentReply> {
  const target = guardrailsProxyTarget(guardrailsProxy, endpoint, { ...headers, 'content-length': String(Buffer.byteLength(bodyText)) });
  return requestOverHttp(target, deadline, (request) => request.end(bodyText));
}

function wasConnectionRefused(error: unknown): boolean {
  if (errorCode(error) === 'ECONNREFUSED') return true;
  return errorCode((error as { cause?: unknown } | null)?.cause) === 'ECONNREFUSED';
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
  try {
    return await postDirectly(post);
  } catch (error) {
    if (!wasConnectionRefused(error)) throw error;
    const guardrailsProxy = decideGuardrailsProxy(process.env);
    if (!guardrailsProxy) throw error;
    return postThroughGuardrailsProxy(guardrailsProxy, post);
  }
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

function parseShowArguments(words: string[]): ShowRequest | null {
  const filePaths: string[] = [];
  let caption: string | null = null;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === '--caption') {
      caption = words[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (word.startsWith('--caption=')) {
      caption = word.slice('--caption='.length);
      continue;
    }
    filePaths.push(word);
  }
  if (filePaths.length === 0) return null;
  return { filePaths, caption: caption?.trim().slice(0, SHOWN_CAPTION_MAX_CHARS) || null };
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
  try {
    return await requestOverHttp(directTarget, null, streamFileBody(file.filePath));
  } catch (error) {
    if (!wasConnectionRefused(error)) throw error;
    const guardrailsProxy = decideGuardrailsProxy(process.env);
    if (!guardrailsProxy) throw error;
    return requestOverHttp(guardrailsProxyTarget(guardrailsProxy, endpoint, headers), null, streamFileBody(file.filePath));
  }
}

function replyError(replyText: string): string {
  const reply: unknown = parseJsonOrNull(replyText);
  const error = typeof reply === 'object' && reply !== null ? (reply as { error?: unknown }).error : null;
  return typeof error === 'string' ? error : `Glimmervoid answered ${replyText || 'nothing'}`;
}

async function runShowCommand(words: string[]): Promise<number> {
  const request = parseShowArguments(words);
  if (!request) {
    console.error(AGENT_COMMAND_HELP.show.missingArgumentHint ?? 'glimmervoid show: this command needs a file path');
    return 1;
  }
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

async function runAgentApiCli(args: string[]): Promise<number> {
  const verb = args[0];
  if (!verb || !isAgentApiVerb(verb)) {
    console.error(`glimmervoid: ${verb || 'that'} is not an agent command`);
    return 1;
  }
  if (verb === 'show') return runShowCommand(args.slice(1));
  const body = BODY_BUILDERS[verb](args.slice(1));
  if (!body) {
    console.error(AGENT_COMMAND_HELP[verb].missingArgumentHint ?? `glimmervoid ${verb}: this command needs an argument`);
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
