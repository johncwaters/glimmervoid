import { z } from 'zod';
import { PLACEHOLDER_TOKEN, placeholderExpirySeconds } from '../../../session/core/agent-home-core.ts';

const LITTLE_ENDIAN_MARK = 0x6c;
const METHOD_CALL_TYPE = 1;
const METHOD_RETURN_TYPE = 2;
const ERROR_TYPE = 3;
const PROTOCOL_VERSION = 1;
const FIXED_HEADER_BYTES = 16;
const HEADER_FIELDS_LENGTH_OFFSET = 12;
const HEADER_FIELD_PATH = 1;
const HEADER_FIELD_INTERFACE = 2;
const HEADER_FIELD_MEMBER = 3;
const HEADER_FIELD_ERROR_NAME = 4;
const HEADER_FIELD_REPLY_SERIAL = 5;
const HEADER_FIELD_DESTINATION = 6;
const HEADER_FIELD_SIGNATURE = 8;
const MAX_MESSAGE_BYTES = 1024 * 1024;

const BUS_DESTINATION = 'org.freedesktop.DBus';
const BUS_PATH = '/org/freedesktop/DBus';
const SECRET_SERVICE_DESTINATION = 'org.freedesktop.secrets';
const SECRET_SERVICE_PATH = '/org/freedesktop/secrets';
const SECRET_SERVICE_INTERFACE = 'org.freedesktop.Secret.Service';
const SECRET_ITEM_INTERFACE = 'org.freedesktop.Secret.Item';
const PLAIN_ALGORITHM = 'plain';

const ANTIGRAVITY_KEYRING_ENTRY: KeyringEntry = Object.freeze({ service: 'gemini', account: 'antigravity' });
const ANTIGRAVITY_TOKEN_FILE_SEGMENTS: readonly string[] = Object.freeze(['.gemini', 'antigravity-cli', 'antigravity-oauth-token']);

interface KeyringEntry {
  service: string;
  account: string;
}

interface DbusVariant {
  signature: string;
  value: DbusValue;
}

type DbusValue = number | string | DbusVariant | DbusValue[];

interface DbusCall {
  serial: number;
  destination: string;
  path: string;
  interfaceName: string;
  member: string;
  signature: string;
  body: readonly DbusValue[];
}

interface DbusMessage {
  type: number;
  serial: number;
  replySerial: number | null;
  errorName: string | null;
  body: DbusValue[];
}

interface WireWriter {
  chunks: Buffer[];
  length: number;
}

interface WireReader {
  buffer: Buffer;
  offset: number;
}

function completeTypeLength(signature: string, start: number): number {
  const code = signature[start];
  if (code === 'a') return 1 + completeTypeLength(signature, start + 1);
  if (code !== '(' && code !== '{') return 1;
  let depth = 0;
  for (let index = start; index < signature.length; index += 1) {
    if (signature[index] === '(' || signature[index] === '{') depth += 1;
    if (signature[index] === ')' || signature[index] === '}') depth -= 1;
    if (depth === 0) return index - start + 1;
  }
  throw new Error(`unbalanced D-Bus signature ${signature}`);
}

function completeTypesOf(signature: string): string[] {
  const types: string[] = [];
  for (let start = 0; start < signature.length; start += completeTypeLength(signature, start)) types.push(signature.slice(start, start + completeTypeLength(signature, start)));
  return types;
}

const ALIGNMENT_BY_CODE: Readonly<Record<string, number>> = Object.freeze({ y: 1, g: 1, v: 1, b: 4, u: 4, i: 4, s: 4, o: 4, a: 4, '(': 8, '{': 8, t: 8, x: 8 });

function alignmentOf(signature: string): number {
  const alignment = ALIGNMENT_BY_CODE[signature[0]];
  if (alignment === undefined) throw new Error(`unsupported D-Bus type ${signature}`);
  return alignment;
}

function paddingFor(offset: number, alignment: number): number {
  return (alignment - (offset % alignment)) % alignment;
}

function pushBytes(writer: WireWriter, bytes: Buffer): void {
  writer.chunks.push(bytes);
  writer.length += bytes.length;
}

function padWriter(writer: WireWriter, alignment: number): void {
  const padding = paddingFor(writer.length, alignment);
  if (padding > 0) pushBytes(writer, Buffer.alloc(padding));
}

function writeUint32(writer: WireWriter, value: number): Buffer {
  padWriter(writer, 4);
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  pushBytes(writer, bytes);
  return bytes;
}

function writeText(writer: WireWriter, text: string, lengthBytes: 1 | 4): void {
  const encoded = Buffer.from(text, 'utf8');
  if (lengthBytes === 4) writeUint32(writer, encoded.length);
  if (lengthBytes === 1) pushBytes(writer, Buffer.from([encoded.length]));
  pushBytes(writer, Buffer.concat([encoded, Buffer.alloc(1)]));
}

function asList(value: DbusValue): DbusValue[] {
  if (!Array.isArray(value)) throw new Error('a D-Bus container value must be a list');
  return value;
}

function writeValue(writer: WireWriter, signature: string, value: DbusValue): void {
  const code = signature[0];
  if (code === 'y' && typeof value === 'number') {
    pushBytes(writer, Buffer.from([value]));
    return;
  }
  if ((code === 'u' || code === 'b') && typeof value === 'number') {
    writeUint32(writer, value);
    return;
  }
  if ((code === 's' || code === 'o') && typeof value === 'string') {
    writeText(writer, value, 4);
    return;
  }
  if (code === 'g' && typeof value === 'string') {
    writeText(writer, value, 1);
    return;
  }
  if (code === 'v' && typeof value === 'object' && !Array.isArray(value)) {
    writeText(writer, value.signature, 1);
    writeValue(writer, value.signature, value.value);
    return;
  }
  if (code === 'a') {
    const lengthBytes = writeUint32(writer, 0);
    const elementSignature = signature.slice(1);
    padWriter(writer, alignmentOf(elementSignature));
    const elementsStart = writer.length;
    for (const element of asList(value)) writeValue(writer, elementSignature, element);
    lengthBytes.writeUInt32LE(writer.length - elementsStart);
    return;
  }
  if (code === '(' || code === '{') {
    padWriter(writer, 8);
    const members = asList(value);
    writeMembers(writer, signature.slice(1, -1), members);
    return;
  }
  throw new Error(`cannot write ${JSON.stringify(value)} as D-Bus type ${signature}`);
}

function writeMembers(writer: WireWriter, signature: string, members: readonly DbusValue[]): void {
  const memberSignatures = completeTypesOf(signature);
  for (let index = 0; index < memberSignatures.length; index += 1) writeValue(writer, memberSignatures[index], members[index]);
}

function alignReader(reader: WireReader, alignment: number): void {
  reader.offset += paddingFor(reader.offset, alignment);
}

function takeBytes(reader: WireReader, count: number): Buffer {
  if (reader.offset + count > reader.buffer.length) throw new Error('the D-Bus message ends early');
  const bytes = reader.buffer.subarray(reader.offset, reader.offset + count);
  reader.offset += count;
  return bytes;
}

function readUint32(reader: WireReader): number {
  alignReader(reader, 4);
  return takeBytes(reader, 4).readUInt32LE(0);
}

function readText(reader: WireReader, lengthBytes: 1 | 4): string {
  const length = lengthBytes === 4 ? readUint32(reader) : takeBytes(reader, 1)[0];
  const text = takeBytes(reader, length).toString('utf8');
  takeBytes(reader, 1);
  return text;
}

function readValue(reader: WireReader, signature: string): DbusValue {
  const code = signature[0];
  if (code === 'y') return takeBytes(reader, 1)[0];
  if (code === 'u' || code === 'b' || code === 'i') return readUint32(reader);
  if (code === 's' || code === 'o') return readText(reader, 4);
  if (code === 'g') return readText(reader, 1);
  if (code === 'v') {
    const variantSignature = readText(reader, 1);
    return { signature: variantSignature, value: readValue(reader, variantSignature) };
  }
  if (code === 'a') {
    const length = readUint32(reader);
    const elementSignature = signature.slice(1);
    alignReader(reader, alignmentOf(elementSignature));
    const end = reader.offset + length;
    const elements: DbusValue[] = [];
    while (reader.offset < end) elements.push(readValue(reader, elementSignature));
    return elements;
  }
  if (code === '(' || code === '{') {
    alignReader(reader, 8);
    return completeTypesOf(signature.slice(1, -1)).map((memberSignature) => readValue(reader, memberSignature));
  }
  throw new Error(`unsupported D-Bus type ${signature}`);
}

function encodeMethodCall(call: DbusCall): Buffer {
  const body: WireWriter = { chunks: [], length: 0 };
  writeMembers(body, call.signature, call.body);
  const fields: DbusValue[] = [
    [HEADER_FIELD_PATH, { signature: 'o', value: call.path }],
    [HEADER_FIELD_INTERFACE, { signature: 's', value: call.interfaceName }],
    [HEADER_FIELD_MEMBER, { signature: 's', value: call.member }],
    [HEADER_FIELD_DESTINATION, { signature: 's', value: call.destination }],
    ...(call.signature === '' ? [] : [[HEADER_FIELD_SIGNATURE, { signature: 'g', value: call.signature }]]),
  ];
  const header: WireWriter = { chunks: [], length: 0 };
  pushBytes(header, Buffer.from([LITTLE_ENDIAN_MARK, METHOD_CALL_TYPE, 0, PROTOCOL_VERSION]));
  writeUint32(header, body.length);
  writeUint32(header, call.serial);
  writeValue(header, 'a(yv)', fields);
  padWriter(header, 8);
  return Buffer.concat([...header.chunks, ...body.chunks]);
}

function messageLengthOf(buffer: Buffer): number | null {
  if (buffer.length < FIXED_HEADER_BYTES) return null;
  const fieldsLength = buffer.readUInt32LE(HEADER_FIELDS_LENGTH_OFFSET);
  const headerLength = FIXED_HEADER_BYTES + fieldsLength + paddingFor(FIXED_HEADER_BYTES + fieldsLength, 8);
  return headerLength + buffer.readUInt32LE(4);
}

function isMessageTooLong(buffer: Buffer): boolean {
  const length = messageLengthOf(buffer);
  return length !== null && length > MAX_MESSAGE_BYTES;
}

function headerFieldsOf(fields: DbusValue): Map<number, DbusValue> {
  const fieldsByCode = new Map<number, DbusValue>();
  for (const field of asList(fields)) {
    const [code, variant] = asList(field);
    if (typeof code === 'number' && typeof variant === 'object' && !Array.isArray(variant)) fieldsByCode.set(code, variant.value);
  }
  return fieldsByCode;
}

function decodeMessage(buffer: Buffer): DbusMessage | null {
  if (buffer[0] !== LITTLE_ENDIAN_MARK) return null;
  try {
    const reader: WireReader = { buffer, offset: HEADER_FIELDS_LENGTH_OFFSET };
    const fields = headerFieldsOf(readValue(reader, 'a(yv)'));
    alignReader(reader, 8);
    const signature = fields.get(HEADER_FIELD_SIGNATURE);
    const replySerial = fields.get(HEADER_FIELD_REPLY_SERIAL);
    const errorName = fields.get(HEADER_FIELD_ERROR_NAME);
    const body = typeof signature === 'string' ? completeTypesOf(signature).map((memberSignature) => readValue(reader, memberSignature)) : [];
    return {
      type: buffer[1],
      serial: buffer.readUInt32LE(8),
      replySerial: typeof replySerial === 'number' ? replySerial : null,
      errorName: typeof errorName === 'string' ? errorName : null,
      body,
    };
  } catch {
    return null;
  }
}

function helloCall(serial: number): DbusCall {
  return { serial, destination: BUS_DESTINATION, path: BUS_PATH, interfaceName: BUS_DESTINATION, member: 'Hello', signature: '', body: [] };
}

function openSessionCall(serial: number): DbusCall {
  return { serial, destination: SECRET_SERVICE_DESTINATION, path: SECRET_SERVICE_PATH, interfaceName: SECRET_SERVICE_INTERFACE, member: 'OpenSession', signature: 'sv', body: [PLAIN_ALGORITHM, { signature: 's', value: '' }] };
}

function searchItemsCall(serial: number, entry: KeyringEntry): DbusCall {
  return { serial, destination: SECRET_SERVICE_DESTINATION, path: SECRET_SERVICE_PATH, interfaceName: SECRET_SERVICE_INTERFACE, member: 'SearchItems', signature: 'a{ss}', body: [[['service', entry.service], ['username', entry.account]]] };
}

function getSecretCall(serial: number, itemPath: string, sessionPath: string): DbusCall {
  return { serial, destination: SECRET_SERVICE_DESTINATION, path: itemPath, interfaceName: SECRET_ITEM_INTERFACE, member: 'GetSecret', signature: 'o', body: [sessionPath] };
}

function replyFailureOf(message: DbusMessage): string | null {
  if (message.type === METHOD_RETURN_TYPE) return null;
  if (message.type !== ERROR_TYPE) return `an unexpected D-Bus message of type ${message.type}`;
  const detail = typeof message.body[0] === 'string' ? `: ${message.body[0]}` : '';
  return `${message.errorName ?? 'a D-Bus error'}${detail}`;
}

function sessionPathOf(message: DbusMessage): string | null {
  const sessionPath = message.body[1];
  return typeof sessionPath === 'string' ? sessionPath : null;
}

function stringsOf(value: DbusValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function searchResultOf(message: DbusMessage): { unlocked: string[]; locked: string[] } {
  return { unlocked: stringsOf(message.body[0]), locked: stringsOf(message.body[1]) };
}

function secretTextOf(message: DbusMessage): string | null {
  const secret = message.body[0];
  if (!Array.isArray(secret)) return null;
  const secretBytes = secret[2];
  if (!Array.isArray(secretBytes) || !secretBytes.every((byte) => typeof byte === 'number')) return null;
  return Buffer.from(secretBytes).toString('utf8');
}

function sessionBusSocketPath(busAddress: string | undefined, userId: number): string {
  const unixAddresses = (busAddress ?? '').split(';').filter((address) => address.startsWith('unix:'));
  for (const address of unixAddresses) {
    const keys = new Map(address.slice('unix:'.length).split(',').map((pair) => [pair.slice(0, pair.indexOf('=')), decodeURIComponent(pair.slice(pair.indexOf('=') + 1))]));
    const socketPath = keys.get('path');
    if (socketPath) return socketPath;
    const abstractName = keys.get('abstract');
    if (abstractName) return `\0${abstractName}`;
  }
  return `/run/user/${userId}/bus`;
}

function externalAuthLine(userId: number): string {
  return `AUTH EXTERNAL ${Buffer.from(String(userId), 'utf8').toString('hex')}\r\n`;
}

const AntigravityKeyringLogin = z.object({
  token: z.object({ access_token: z.string().min(1), expiry: z.string().min(1) }).passthrough(),
  auth_method: z.string().optional(),
  id_token_email: z.string().optional(),
}).passthrough();

interface AntigravityLogin {
  accessToken: string;
  expiresAtMs: number;
  authMethod: string | null;
  email: string | null;
}

function antigravityLoginOf(secretText: string): AntigravityLogin | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretText);
  } catch {
    return null;
  }
  const login = AntigravityKeyringLogin.safeParse(parsed);
  if (!login.success) return null;
  const expiresAtMs = Date.parse(login.data.token.expiry);
  if (!Number.isFinite(expiresAtMs)) return null;
  return { accessToken: login.data.token.access_token, expiresAtMs, authMethod: login.data.auth_method ?? null, email: login.data.id_token_email ?? null };
}

const ANTIGRAVITY_CONSUMER_AUTH_METHOD = 'consumer';
const ANTIGRAVITY_TOKEN_TYPE = 'Bearer';
const ANTIGRAVITY_PLACEHOLDER_EXPIRES_IN_SECONDS = 3599;

function antigravityPlaceholderLogin(secretText: string, nowMs: number): { placeholder: string } | { refusal: string } {
  const login = antigravityLoginOf(secretText);
  if (login === null) return { refusal: 'its Antigravity keyring login is not the JSON this sandbox reads, so no placeholder login can stand in for it' };
  if (login.authMethod !== ANTIGRAVITY_CONSUMER_AUTH_METHOD) return { refusal: `Antigravity is signed in with ${login.authMethod ?? 'an unknown method'}, and the sandbox places only a personal Google sign-in` };
  const expiry = new Date(placeholderExpirySeconds(nowMs) * 1000).toISOString();
  const token = { access_token: PLACEHOLDER_TOKEN, token_type: ANTIGRAVITY_TOKEN_TYPE, refresh_token: PLACEHOLDER_TOKEN, expiry, expires_in: ANTIGRAVITY_PLACEHOLDER_EXPIRES_IN_SECONDS };
  const email = login.email === null ? {} : { id_token_email: login.email };
  return { placeholder: JSON.stringify({ token, auth_method: ANTIGRAVITY_CONSUMER_AUTH_METHOD, ...email }) };
}

export {
  ANTIGRAVITY_KEYRING_ENTRY,
  ANTIGRAVITY_TOKEN_FILE_SEGMENTS,
  antigravityLoginOf,
  antigravityPlaceholderLogin,
  decodeMessage,
  encodeMethodCall,
  externalAuthLine,
  getSecretCall,
  helloCall,
  isMessageTooLong,
  messageLengthOf,
  openSessionCall,
  replyFailureOf,
  searchItemsCall,
  searchResultOf,
  secretTextOf,
  sessionBusSocketPath,
  sessionPathOf,
};
export type { AntigravityLogin, DbusCall, DbusMessage, KeyringEntry };
