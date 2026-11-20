import readline from 'node:readline';
import { parseArgs } from 'node:util';

import { isLoopbackHostname } from '../shared/loopback-hosts.ts';
import { MCP_CREDENTIAL_ENV, MCP_TOOL_TIMEOUT_SECONDS, MCP_URL_ENV } from './core/agent-config.ts';
import { PACK_SECRET_ENV_FLAG, PACK_URL_FLAG, bridgedLinesFor, failureReplyTo, offlineReplyTo, parseJsonRpcLine, standardHeadersFor } from './core/stdio-bridge-core.ts';
import type { EndpointReply, JsonRpcMessage } from './core/stdio-bridge-core.ts';

const http = process.getBuiltinModule('node:http');
const https = process.getBuiltinModule('node:https');

const GLIMMERVOID_LABEL = 'Glimmervoid';

interface BridgeTarget {
  url: URL;
  bearer: string;
  label: string;
  mcpSessionId: string | null;
  handshakeLines: string[];
}

interface PackTargetArgs {
  urlText: string;
  secretEnvName: string;
}

function packTargetArgsOf(argv: readonly string[]): PackTargetArgs | null {
  const { values } = parseArgs({ args: [...argv], options: { [PACK_URL_FLAG]: { type: 'string' }, [PACK_SECRET_ENV_FLAG]: { type: 'string' } }, strict: false });
  const urlText = values[PACK_URL_FLAG];
  const secretEnvName = values[PACK_SECRET_ENV_FLAG];
  if (typeof urlText !== 'string' || typeof secretEnvName !== 'string') return null;
  return { urlText, secretEnvName };
}

function glimmervoidTargetOf(env: Record<string, string | undefined>): BridgeTarget | null {
  const urlText = env[MCP_URL_ENV]?.trim() ?? '';
  const bearer = env[MCP_CREDENTIAL_ENV]?.trim() ?? '';
  if (!urlText || !bearer || !URL.canParse(urlText)) return null;
  const url = new URL(urlText);
  if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)) return null;
  return { url, bearer, label: GLIMMERVOID_LABEL, mcpSessionId: null, handshakeLines: [] };
}

function packTargetOf(env: Record<string, string | undefined>, { urlText, secretEnvName }: PackTargetArgs): BridgeTarget | null {
  const isGlimmervoidSession = (env[MCP_URL_ENV]?.trim() ?? '') !== '';
  const bearer = env[secretEnvName]?.trim() ?? '';
  if (!isGlimmervoidSession || !bearer || !URL.canParse(urlText)) return null;
  const url = new URL(urlText);
  return { url, bearer, label: url.host, mcpSessionId: null, handshakeLines: [] };
}

function bridgeTargetOf(env: Record<string, string | undefined>, argv: readonly string[]): BridgeTarget | null {
  const packTargetArgs = packTargetArgsOf(argv);
  return packTargetArgs === null ? glimmervoidTargetOf(env) : packTargetOf(env, packTargetArgs);
}

function headerTextOf(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

function postMessage(target: BridgeTarget, line: string, message: JsonRpcMessage): Promise<EndpointReply> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(line, 'utf8');
    const transport = target.url.protocol === 'https:' ? https : http;
    const request = transport.request(target.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.bearer}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': body.length,
        ...(target.mcpSessionId === null ? {} : { 'mcp-session-id': target.mcpSessionId }),
        ...standardHeadersFor(message),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        contentType: String(response.headers['content-type'] ?? ''),
        bodyText: Buffer.concat(chunks).toString('utf8'),
        mcpSessionId: headerTextOf(response.headers['mcp-session-id']),
      }));
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

async function exchange(target: BridgeTarget, line: string, message: JsonRpcMessage): Promise<EndpointReply> {
  const reply = await postMessage(target, line, message);
  if (reply.mcpSessionId) target.mcpSessionId = reply.mcpSessionId;
  return reply;
}

async function startNewMcpSession(target: BridgeTarget): Promise<void> {
  target.mcpSessionId = null;
  for (const handshakeLine of target.handshakeLines) {
    const handshakeMessage = parseJsonRpcLine(handshakeLine);
    if (handshakeMessage !== null) await exchange(target, handshakeLine, handshakeMessage);
  }
}

async function exchangeRenewingExpiredSession(target: BridgeTarget, line: string, message: JsonRpcMessage): Promise<EndpointReply> {
  const sentSessionId = target.mcpSessionId;
  const reply = await exchange(target, line, message);
  if (reply.statusCode !== 404 || sentSessionId === null || target.handshakeLines.length === 0) return reply;
  await startNewMcpSession(target);
  return exchange(target, line, message);
}

async function forward(target: BridgeTarget, line: string, message: JsonRpcMessage, stdout: { write(text: string): unknown }): Promise<void> {
  try {
    const reply = await exchangeRenewingExpiredSession(target, line, message);
    for (const replyLine of bridgedLinesFor(message, reply, target.label)) writeMessage(stdout, replyLine);
  } catch (error) {
    writeMessage(stdout, failureReplyTo(message, error instanceof Error ? error.message : String(error), target.label));
  }
}

async function main(
  stdin: NodeJS.ReadableStream = process.stdin,
  env: Record<string, string | undefined> = process.env,
  stdout: { write(text: string): unknown } = process.stdout,
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const target = bridgeTargetOf(env, argv);
  const pending = new Set<Promise<void>>();
  for await (const line of readline.createInterface({ input: stdin, crlfDelay: Infinity })) {
    const message = parseJsonRpcLine(line);
    if (message === null) continue;
    if (target === null) {
      writeMessage(stdout, offlineReplyTo(message));
      continue;
    }
    if (message.method === 'initialize') {
      target.handshakeLines = [line];
      await forward(target, line, message, stdout);
      continue;
    }
    if (message.method === 'notifications/initialized') target.handshakeLines = [...target.handshakeLines.slice(0, 1), line];
    const forwarded = forward(target, line, message, stdout);
    pending.add(forwarded);
    void forwarded.finally(() => pending.delete(forwarded));
  }
  await Promise.all(pending);
  return 0;
}

export { main };
