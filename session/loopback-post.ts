import { isLoopbackHostname } from "../shared/loopback-hosts.ts";
import type { RequestOptions } from 'node:http';
import { MAX_RESPONSE_BYTES } from './core/hook-relay-core.ts';
import { decideGuardrailsProxy, HOOK_VIA_GUARDRAILS_PROXY_ENV } from './core/guardrails-proxy-core.ts';
import type { GuardrailsProxy } from './core/guardrails-proxy-core.ts';

const POST_TIMEOUT_MS = 1500;
const http = process.getBuiltinModule('node:http');

interface LoopbackPostOutcome {
  reason: string;
  responseBody: string | null;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

function refusal(reason: string): LoopbackPostOutcome {
  return { reason, responseBody: null };
}

function directRoute(target: URL): RequestOptions {
  return { hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}` };
}

function guardrailsProxyRoute(guardrailsProxy: GuardrailsProxy, target: URL): RequestOptions {
  const proxyHeaders = guardrailsProxy.authorization ? { 'proxy-authorization': guardrailsProxy.authorization } : {};
  return { hostname: guardrailsProxy.hostname, port: guardrailsProxy.port, path: target.href, headers: { ...proxyHeaders, host: target.host } };
}

function sendPost(route: RequestOptions, body: Buffer): Promise<LoopbackPostOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (reason: string, responseBody: string | null = null): void => {
      if (settled) return;
      settled = true;
      resolve({ reason, responseBody });
    };
    try {
      const request = http.request(
        {
          ...route,
          method: 'POST',
          headers: {
            ...route.headers,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let responseBytes = 0;
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            responseBytes += chunk.length;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              response.destroy();
              done('response-too-large');
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => done(`status-${response.statusCode}`, Buffer.concat(chunks).toString('utf8')));
          response.on('error', () => done('response-error'));
          response.on('close', () => done('response-error'));
        },
      );
      request.on('error', () => done('request-error'));
      request.setTimeout(POST_TIMEOUT_MS, () => {
        request.destroy();
        done('timeout');
      });
      request.end(body);
    } catch {
      done('request-throw');
    }
  });
}

async function postToLoopback(url: string, body: Buffer, env: EnvLike = process.env): Promise<LoopbackPostOutcome> {
  if (!URL.canParse(url)) return refusal('bad-url');
  const target = new URL(url);
  if (target.protocol !== 'http:') return refusal('not-http');
  if (!isLoopbackHostname(target.hostname)) return refusal('not-loopback');
  if (env[HOOK_VIA_GUARDRAILS_PROXY_ENV] !== '1') return sendPost(directRoute(target), body);
  const guardrailsProxy = decideGuardrailsProxy(env);
  if (!guardrailsProxy) return refusal('guardrails-proxy-missing');
  return sendPost(guardrailsProxyRoute(guardrailsProxy, target), body);
}

async function postPayload(url: string, body: Buffer): Promise<string | null> {
  const outcome = await postToLoopback(url, body);
  return outcome.responseBody;
}

export { postPayload, postToLoopback };
