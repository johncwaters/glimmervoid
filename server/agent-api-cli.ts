import http from 'node:http';

import { resolveHookTarget } from '../session/core/hook-relay-core.ts';
import { AgentDispatchRequest, AGENT_URL_ENV } from '../shared/contracts/session.ts';
import type { AgentApiVerb } from '../shared/contracts/session.ts';
import { errorCode } from '../shared/text.ts';
import { decideSandboxProxy } from '../session/core/sandbox-proxy-core.ts';
import type { SandboxProxy } from '../session/core/sandbox-proxy-core.ts';
import { isAgentApiVerb } from './core/agent-api-core.ts';

const AGENT_PATH_PREFIX = '/agent/';

type BodyBuilder = (rest: string[]) => Record<string, unknown> | null;

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
  dispatch: (rest) => {
    const parsed = AgentDispatchRequest.safeParse(rest[0] === '--ready' ? { readyIntent: rest[1] } : { workId: rest[0] });
    return parsed.success ? parsed.data : null;
  },
};

function bodySaysOk(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && (parsed as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
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

async function postDirectly(endpoint: URL, headers: Record<string, string>, bodyText: string): Promise<AgentReply> {
  const response = await fetch(endpoint, { method: 'POST', headers, body: bodyText });
  return { hasSuccessStatus: response.ok, text: await response.text() };
}

function postThroughSandboxProxy(sandboxProxy: SandboxProxy, endpoint: URL, headers: Record<string, string>, bodyText: string): Promise<AgentReply> {
  const proxyHeaders = sandboxProxy.authorization ? { 'proxy-authorization': sandboxProxy.authorization } : {};
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: sandboxProxy.hostname,
      port: sandboxProxy.port,
      method: 'POST',
      path: endpoint.href,
      headers: { ...headers, ...proxyHeaders, host: endpoint.host, 'content-length': String(Buffer.byteLength(bodyText)) },
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

async function postToAgentIngress(endpoint: URL, token: string, body: Record<string, unknown>): Promise<AgentReply> {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const bodyText = JSON.stringify(body);
  try {
    return await postDirectly(endpoint, headers, bodyText);
  } catch (error) {
    if (!wasConnectionRefused(error)) throw error;
    const sandboxProxy = decideSandboxProxy(process.env);
    if (!sandboxProxy) throw error;
    return postThroughSandboxProxy(sandboxProxy, endpoint, headers, bodyText);
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
    if (verb === 'dispatch') {
      console.error('glimmervoid dispatch: expected a work id matching wrk-[0-9a-f]{16}');
      return 1;
    }
    console.error(`glimmervoid ${verb}: this command needs text, for example "glimmervoid ${verb} check the failing test"`);
    return 1;
  }
  const rawUrl = process.env[AGENT_URL_ENV];
  if (!rawUrl) {
    console.error(`glimmervoid: ${AGENT_URL_ENV} is not set, so this is not a Glimmervoid session with the agent API turned on`);
    return 1;
  }
  const target = verbEndpoint(rawUrl, verb);
  if (!target.ok) {
    console.error(`glimmervoid: ${AGENT_URL_ENV} must be a loopback http url under ${AGENT_PATH_PREFIX}, so nothing was sent`);
    return 1;
  }
  const reply = await postToAgentIngress(target.endpoint, target.token, body);
  console.log(reply.text);
  return reply.hasSuccessStatus && bodySaysOk(reply.text) ? 0 : 1;
}

export { runAgentApiCli };
