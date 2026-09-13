import { resolveHookTarget } from '../session/core/hook-relay-core.ts';
import { AGENT_URL_ENV } from '../shared/contracts/session.ts';
import type { AgentApiVerb } from '../shared/contracts/session.ts';
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

async function runAgentApiCli(args: string[]): Promise<number> {
  const verb = args[0];
  if (!verb || !isAgentApiVerb(verb)) {
    console.error(`glimmervoid: ${verb || 'that'} is not an agent command`);
    return 1;
  }
  const body = BODY_BUILDERS[verb](args.slice(1));
  if (!body) {
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
  const response = await fetch(target.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  console.log(text);
  return response.ok && bodySaysOk(text) ? 0 : 1;
}

export { runAgentApiCli };
