const PACK_URL_FLAG = 'pack-url';
const PACK_SECRET_ENV_FLAG = 'pack-secret-env';
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;
const BRIDGE_SERVER_INFO = { name: 'glimmervoid', version: '1.0.0' };
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const ENVELOPE_PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const BASE64_SENTINEL_PREFIX = '=?base64?';
const PLAIN_HEADER_VALUE_PATTERN = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;
const NAME_FIELD_BY_METHOD: Readonly<Record<string, string>> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
  'tasks/get': 'taskId',
  'tasks/update': 'taskId',
  'tasks/cancel': 'taskId',
};

type JsonRpcMessage = Record<string, unknown>;

function parseJsonRpcLine(line: string): JsonRpcMessage | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return Object.fromEntries(Object.entries(parsed));
  } catch {
    return null;
  }
}

function isRequest(message: JsonRpcMessage): boolean {
  return typeof message.method === 'string' && 'id' in message;
}

function requestedProtocolVersion(message: JsonRpcMessage): string {
  const params = message.params;
  if (typeof params !== 'object' || params === null || !('protocolVersion' in params)) return FALLBACK_PROTOCOL_VERSION;
  return typeof params.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL_VERSION;
}

function offlineResultFor(message: JsonRpcMessage): JsonRpcMessage {
  switch (message.method) {
    case 'initialize':
      return { result: { protocolVersion: requestedProtocolVersion(message), capabilities: { tools: { listChanged: false } }, serverInfo: BRIDGE_SERVER_INFO } };
    case 'tools/list':
      return { result: { tools: [] } };
    case 'ping':
      return { result: {} };
    default:
      return { error: { code: JSON_RPC_METHOD_NOT_FOUND, message: 'Glimmervoid is not supervising this session, so it offers no tools' } };
  }
}

function stringFieldOf(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null || !(field in value)) return null;
  const fieldValue: unknown = Object.getOwnPropertyDescriptor(value, field)?.value;
  return typeof fieldValue === 'string' ? fieldValue : null;
}

function headerValueOf(text: string): string {
  if (PLAIN_HEADER_VALUE_PATTERN.test(text) && !text.startsWith(BASE64_SENTINEL_PREFIX)) return text;
  return `${BASE64_SENTINEL_PREFIX}${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function standardHeadersFor(message: JsonRpcMessage): Record<string, string> {
  const params = message.params;
  const envelope = typeof params === 'object' && params !== null && '_meta' in params ? params._meta : null;
  const envelopeVersion = stringFieldOf(envelope, ENVELOPE_PROTOCOL_VERSION_KEY);
  if (envelopeVersion === null || typeof message.method !== 'string') return {};
  const headers: Record<string, string> = { 'mcp-protocol-version': envelopeVersion, 'mcp-method': message.method };
  const nameField = NAME_FIELD_BY_METHOD[message.method];
  const name = nameField === undefined ? null : stringFieldOf(params, nameField);
  if (name !== null) headers['mcp-name'] = headerValueOf(name);
  return headers;
}

function offlineReplyTo(message: JsonRpcMessage): JsonRpcMessage | null {
  if (!isRequest(message)) return null;
  return { jsonrpc: '2.0', id: message.id, ...offlineResultFor(message) };
}

function messagesOfEventStream(eventStreamText: string): string[] {
  return eventStreamText.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data.length > 0);
}

function messagesOfJsonBody(bodyText: string): string[] {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.map((message) => JSON.stringify(message)) : [JSON.stringify(parsed)];
  } catch {
    return [];
  }
}

function messagesOfResponse(contentType: string, bodyText: string): string[] {
  if (contentType.includes('text/event-stream')) return messagesOfEventStream(bodyText);
  return messagesOfJsonBody(bodyText);
}

function failureReplyTo(message: JsonRpcMessage, reason: string, serverLabel = 'Glimmervoid'): JsonRpcMessage | null {
  if (!isRequest(message)) return null;
  return { jsonrpc: '2.0', id: message.id, error: { code: JSON_RPC_INTERNAL_ERROR, message: `${serverLabel} could not be reached: ${reason}` } };
}

interface EndpointReply {
  statusCode: number;
  contentType: string;
  bodyText: string;
  mcpSessionId?: string | null;
}

function isSuccessStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function isJsonRpcText(text: string): boolean {
  return parseJsonRpcLine(text)?.jsonrpc === '2.0';
}

function answersRequest(text: string, message: JsonRpcMessage): boolean {
  const reply = parseJsonRpcLine(text);
  return reply !== null && reply.id === message.id && !('method' in reply);
}

function bridgedLinesFor(message: JsonRpcMessage, reply: EndpointReply, serverLabel = 'Glimmervoid'): string[] {
  const failure = (reason: string) => [failureReplyTo(message, reason, serverLabel)].flatMap((failureReply) => (failureReply === null ? [] : [JSON.stringify(failureReply)]));
  if (!isSuccessStatus(reply.statusCode)) return failure(`the endpoint answered HTTP ${reply.statusCode}`);
  const jsonRpcLines = messagesOfResponse(reply.contentType, reply.bodyText).filter(isJsonRpcText);
  if (!isRequest(message) || jsonRpcLines.some((line) => answersRequest(line, message))) return jsonRpcLines;
  return [...jsonRpcLines, ...failure('the endpoint sent no reply to this request')];
}

export { PACK_SECRET_ENV_FLAG, PACK_URL_FLAG, bridgedLinesFor, failureReplyTo, offlineReplyTo, parseJsonRpcLine, standardHeadersFor };
export type { EndpointReply };
export type { JsonRpcMessage };
