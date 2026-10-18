import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { resolveHookTarget } from '../session/core/hook-relay-core.ts';
import { formatSessionLimits } from '../session/core/session-routes.ts';
import { AgentDispatchRequest, AgentFactoryRetryRequest, AgentFactoryStatusRequest, AgentLimitsReply, AgentTicketRequest, AGENT_URL_ENV } from '../shared/contracts/session.ts';
import type { AgentApiVerb } from '../shared/contracts/session.ts';
import { errorCode } from '../shared/text.ts';
import { decideGuardrailsProxy } from '../session/core/guardrails-proxy-core.ts';
import type { GuardrailsProxy } from '../session/core/guardrails-proxy-core.ts';
import { isAgentApiVerb, isOrchestratorAgentVerb } from './core/agent-api-core.ts';
import { isRecord } from '../shared/coerce.ts';
import { parseJsonOrNull } from './core/json-core.ts';
import { ProjectCoherenceCheckResult } from '../shared/contracts/coherence.ts';
import { renderCoherenceCheckText } from './coherence/core/coherence-check-core.ts';

const AGENT_PATH_PREFIX = '/agent/';
const HELP_LIMITS_TIMEOUT_MS = 2000;
const HELP_LIMITS_UNKNOWN_LINE = 'This session: Glimmervoid did not report its limits, so run glimmervoid limits to see why';

type BodyBuilder = (rest: string[]) => Record<string, unknown> | null;

function ticketBody(rest: string[]): Record<string, unknown> | null {
  const parsed = AgentTicketRequest.safeParse({ workId: rest[0] });
  return parsed.success ? parsed.data : null;
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
  dispatch: (rest) => {
    const parsed = AgentDispatchRequest.safeParse(rest[0] === '--ready' ? { readyIntent: rest[1] } : { workId: rest[0] });
    return parsed.success ? parsed.data : null;
  },
  reopen: (rest) => ticketBody(rest),
  cancel: (rest) => ticketBody(rest),
  'factory-status': (rest) => {
    if (rest.length === 0) return {};
    if (rest.length !== 2 || rest[0] !== '--project') return null;
    const parsed = AgentFactoryStatusRequest.safeParse({ projectId: rest[1] });
    return parsed.success ? parsed.data : null;
  },
  'factory-retry': (rest) => {
    if (rest.length !== 1) return null;
    const parsed = AgentFactoryRetryRequest.safeParse({ intentId: rest[0] });
    return parsed.success ? parsed.data : null;
  },
  'factory-setup': (rest) => rest.length === 0 ? {} : null,
  'coherence-check': (rest) => rest.length === 0 ? {} : null,
  'factory-queue': (rest) => {
    if (rest.length !== 1) return null;
    const intent = parseJsonOrNull(readFileSync(rest[0], 'utf8'));
    if (!isRecord(intent)) return null;
    const { name: _name, type: _type, requestId: _requestId, projectId: _projectId, ...request } = intent;
    return request;
  },
};

const FACTORY_USAGE: Readonly<Record<string, string>> = Object.freeze({
  'factory-status': 'status [--project <projectId>]',
  'factory-retry': 'retry <intentId>',
  'factory-setup': 'setup',
  'factory-queue': 'queue <intent.json>',
});

function isFactoryVerb(verb: AgentApiVerb): boolean {
  return verb in FACTORY_USAGE;
}

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
  if (isFactoryVerb(verb)) {
    const reply = parseJsonOrNull(replyText);
    if (typeof reply !== 'object' || reply === null) return replyText;
    if ('text' in reply && typeof reply.text === 'string') return reply.text;
    if ('error' in reply && typeof reply.error === 'string') return reply.error;
    return replyText;
  }
  if (verb === 'coherence-check') {
    const result = ProjectCoherenceCheckResult.safeParse(parseJsonOrNull(replyText));
    return result.success ? renderCoherenceCheckText(result.data) : replyText;
  }
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
  if (args[0] === 'factory') {
    if (!(`factory-${args[1]}` in FACTORY_USAGE)) {
      console.error(`glimmervoid factory: expected ${Object.values(FACTORY_USAGE).join(', or ')}`);
      return 1;
    }
    return runAgentApiCli([`factory-${args[1]}`, ...args.slice(2)]);
  }
  const verb = args[0];
  if (!verb || !isAgentApiVerb(verb)) {
    console.error(`glimmervoid: ${verb || 'that'} is not an agent command`);
    return 1;
  }
  const body = BODY_BUILDERS[verb](args.slice(1));
  if (!body) {
    if (isFactoryVerb(verb)) {
      console.error(`glimmervoid factory: expected ${FACTORY_USAGE[verb]}`);
      return 1;
    }
    if (isOrchestratorAgentVerb(verb)) {
      console.error(`glimmervoid ${verb}: expected a work id matching wrk-[0-9a-f]{16}`);
      return 1;
    }
    if (verb === 'edit') {
      console.error('glimmervoid edit: this command needs a file path, for example "glimmervoid edit drafts/post.md"');
      return 1;
    }
    console.error(`glimmervoid ${verb}: this command needs text, for example "glimmervoid ${verb} check the failing test"`);
    return 1;
  }
  const rawUrl = process.env[AGENT_URL_ENV];
  if (!rawUrl) {
    console.error(`glimmervoid: ${AGENT_URL_ENV} is not set, so this is not a Glimmervoid session`);
    return 1;
  }
  const target = verbEndpoint(rawUrl, verb);
  if (!target.ok) {
    console.error(`glimmervoid: ${AGENT_URL_ENV} must be a loopback http url under ${AGENT_PATH_PREFIX}, so nothing was sent`);
    return 1;
  }
  const reply = await postToAgentIngress({ endpoint: target.endpoint, token: target.token, body });
  console.log(printableReply(verb, reply.text));
  return reply.hasSuccessStatus && bodySaysOk(reply.text) ? 0 : 1;
}

export { AGENT_PATH_PREFIX, postToAgentIngress, runAgentApiCli, sessionLimitsHelpLines, verbEndpoint };
