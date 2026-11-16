import readline from 'node:readline';

import { isLoopbackHostname } from '../shared/loopback-hosts.ts';
import { MCP_CREDENTIAL_ENV, MCP_TOOL_TIMEOUT_SECONDS, MCP_URL_ENV } from './core/agent-config.ts';
import { bridgedLinesFor, failureReplyTo, offlineReplyTo, parseJsonRpcLine, standardHeadersFor } from './core/stdio-bridge-core.ts';
import type { EndpointReply, JsonRpcMessage } from './core/stdio-bridge-core.ts';

const http = process.getBuiltinModule('node:http');

interface BridgeTarget {
  url: URL;
  bearer: string;
}

function bridgeTargetOf(env: Record<string, string | undefined>): BridgeTarget | null {
  const urlText = env[MCP_URL_ENV]?.trim() ?? '';
  const bearer = env[MCP_CREDENTIAL_ENV]?.trim() ?? '';
  if (!urlText || !bearer || !URL.canParse(urlText)) return null;
  const url = new URL(urlText);
  if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)) return null;
  return { url, bearer };
}

function postMessage(target: BridgeTarget, line: string, message: JsonRpcMessage): Promise<EndpointReply> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(line, 'utf8');
    const request = http.request({
      hostname: target.url.hostname,
      port: target.url.port,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.bearer}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': body.length,
        ...standardHeadersFor(message),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, contentType: String(response.headers['content-type'] ?? ''), bodyText: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(MCP_TOOL_TIMEOUT_SECONDS * 1000, () => request.destroy(new Error('timed out')));
    request.end(body);
  });
}

function writeMessage(stdout: { write(text: string): unknown }, message: JsonRpcMessage | string | null): void {
  if (message === null) return;
  stdout.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
}

async function forward(target: BridgeTarget, line: string, message: JsonRpcMessage, stdout: { write(text: string): unknown }): Promise<void> {
  try {
    const reply = await postMessage(target, line, message);
    for (const replyLine of bridgedLinesFor(message, reply)) writeMessage(stdout, replyLine);
  } catch (error) {
    writeMessage(stdout, failureReplyTo(message, error instanceof Error ? error.message : String(error)));
  }
}

async function main(
  stdin: NodeJS.ReadableStream = process.stdin,
  env: Record<string, string | undefined> = process.env,
  stdout: { write(text: string): unknown } = process.stdout,
): Promise<number> {
  const target = bridgeTargetOf(env);
  const pending = new Set<Promise<void>>();
  for await (const line of readline.createInterface({ input: stdin, crlfDelay: Infinity })) {
    const message = parseJsonRpcLine(line);
    if (message === null) continue;
    if (target === null) {
      writeMessage(stdout, offlineReplyTo(message));
      continue;
    }
    const forwarded = forward(target, line, message, stdout);
    pending.add(forwarded);
    void forwarded.finally(() => pending.delete(forwarded));
  }
  await Promise.all(pending);
  return 0;
}

export { main };
