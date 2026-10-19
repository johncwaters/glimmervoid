
import http from 'node:http';
import path from 'node:path';

import { resolveHookTarget } from '../session/core/hook-relay-core.ts';
import { formatSessionLimits } from '../session/core/session-routes.ts';
import { AgentLimitsReply, AGENT_URL_ENV } from '../shared/contracts/session.ts';
import type { AgentApiVerb } from '../shared/contracts/session.ts';
import { errorCode } from '../shared/text.ts';
import { decideGuardrailsProxy } from '../session/core/guardrails-proxy-core.ts';
import type { GuardrailsProxy } from '../session/core/guardrails-proxy-core.ts';
import { isAgentApiVerb } from './core/agent-api-core.ts';
import { parseJsonOrNull } from './core/json-core.ts';

const AGENT_PATH_PREFIX = '/agent/';
const HELP_LIMITS_TIMEOUT_MS = 2000;
const HELP_LIMITS_UNKNOWN_LINE = 'This session: Glimmervoid did not report its limits, so run glimmervoid limits to see why';

type BodyBuilder = (rest: string[]) => Record<string, unknown> | null;

function pullRequestBody(rest: string[]): Record<string, unknown> | null {
  const pullRequest = rest.join(' ').trim();
  return pullRequest ? { pr: pullRequest } : null;
}

const BODY_BUILDERS: Record<AgentApiVerb, BodyBuilder> = {
  spawn: (rest) => {
    const prompt = rest.join(' ').trim();
    return prompt ? { prompt } : null;
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
  reviews: () => ({}),
  prs: () => ({}),
  'link-pr': pullRequestBody,
  settings: ([command, settingPath]) => ({ command, ...(settingPath === undefined ? {} : { path: settingPath }) }),
};

const MISSING_ARGUMENT_HINTS: Readonly<Partial<Record<AgentApiVerb, string>>> = Object.freeze({
  edit: 'glimmervoid edit: this command needs a file path, for example "glimmervoid edit drafts/post.md"',
  review: 'glimmervoid review: this command needs a pull request, for example "glimmervoid review https://github.com/acme/app/pull/12" or "glimmervoid review acme/app#12"',
  'link-pr': 'glimmervoid link-pr: this command needs a pull request, for example "glimmervoid link-pr acme/app#12"',
});

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

function printableReply(verb: AgentApiVerb, replyText: string): string {
  if (verb !== 'limits') return replyText;
  return limitsLines(replyText)?.join('\n') ?? replyText;
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

function postThroughGuardrailsProxy(guardrailsProxy: GuardrailsProxy, { endpoint, headers, bodyText, deadline }: AgentPost): Promise<AgentReply> {
  const proxyHeaders = guardrailsProxy.authorization ? { 'proxy-authorization': guardrailsProxy.authorization } : {};
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: guardrailsProxy.hostname,
      port: guardrailsProxy.port,
      method: 'POST',
      path: endpoint.href,
      headers: { ...headers, ...proxyHeaders, host: endpoint.host, 'content-length': String(Buffer.byteLength(bodyText)) },
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
    request.end(bodyText);
  });
}

function wasConnectionRefused(error: unknown): boolean {
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

async function runAgentApiCli(args: string[]): Promise<number> {
  const verb = args[0];
  if (!verb || !isAgentApiVerb(verb)) {
    console.error(`glimmervoid: ${verb || 'that'} is not an agent command`);
    return 1;
  }
  const body = BODY_BUILDERS[verb](args.slice(1));
  if (!body) {
    console.error(MISSING_ARGUMENT_HINTS[verb] ?? `glimmervoid ${verb}: this command needs text, for example "glimmervoid ${verb} check the failing test"`);
    return 1;
  }
  const target = sessionEndpoint(verb);
  if (!target.ok) {
    console.error(target.error);
    return 1;
  }
  const reply = await postToAgentIngress({ endpoint: target.endpoint, token: target.token, body });
  console.log(printableReply(verb, reply.text));
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
