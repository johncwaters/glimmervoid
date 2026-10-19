import { createHash } from 'node:crypto';

type ParsedKey = { segments: string[]; end: number };
type HookHandlerIdentity = { type: 'command'; command: string; timeout: number; async: boolean; statusMessage?: string; additionalContextLimit?: number };

const BARE_KEY_CHARACTER = /[A-Za-z0-9_-]/;
const BASIC_STRING_ESCAPES: Readonly<Record<string, string>> = Object.freeze({ '"': '"', '\\': '\\', b: '\b', t: '\t', n: '\n', f: '\f', r: '\r' });
const TRUSTED_HASH_IN_INLINE_TABLE = /(?:^|[{,\s])trusted_hash\s*=\s*(?=["'])/;
const MATCHERLESS_EVENTS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'Stop', 'Interrupt']);
const SHORT_TIMEOUT_EVENTS: ReadonlySet<string> = new Set(['SessionEnd', 'Interrupt']);
const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart',
  'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
]);
const LONE_SURROGATE = /\p{Cs}/u;
const HASHABLE_GROUP_FIELDS: ReadonlySet<string> = new Set(['matcher', 'hooks']);
const HASHABLE_HANDLER_FIELDS: ReadonlySet<string> = new Set(['type', 'command', 'timeout', 'async', 'statusMessage', 'additionalContextLimit']);

function skipSpaces(text: string, start: number): number {
  let index = start;
  while (text[index] === ' ' || text[index] === '\t') index += 1;
  return index;
}

function parseBasicString(text: string, start: number): { value: string; end: number } | null {
  let value = '';
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') return { value, end: index + 1 };
    if (character !== '\\') {
      value += character;
      continue;
    }
    const escapeCharacter = text[index + 1] ?? '';
    const unicodeLength = escapeCharacter === 'u' ? 4 : escapeCharacter === 'U' ? 8 : 0;
    if (unicodeLength > 0) {
      const codePoint = Number.parseInt(text.slice(index + 2, index + 2 + unicodeLength), 16);
      if (!Number.isInteger(codePoint) || codePoint > 0x10ffff) return null;
      value += String.fromCodePoint(codePoint);
      index += 1 + unicodeLength;
      continue;
    }
    const escaped = BASIC_STRING_ESCAPES[escapeCharacter];
    if (escaped === undefined) return null;
    value += escaped;
    index += 1;
  }
  return null;
}

function parseKeySegment(text: string, start: number): { value: string; end: number } | null {
  if (text[start] === '"') return parseBasicString(text, start);
  if (text[start] === "'") {
    const close = text.indexOf("'", start + 1);
    return close === -1 ? null : { value: text.slice(start + 1, close), end: close + 1 };
  }
  let end = start;
  while (end < text.length && BARE_KEY_CHARACTER.test(text[end])) end += 1;
  return end === start ? null : { value: text.slice(start, end), end };
}

function parseDottedKey(text: string, start: number): ParsedKey | null {
  const segments: string[] = [];
  let index = skipSpaces(text, start);
  for (;;) {
    const segment = parseKeySegment(text, index);
    if (!segment) return null;
    segments.push(segment.value);
    index = skipSpaces(text, segment.end);
    if (text[index] !== '.') return { segments, end: index };
    index = skipSpaces(text, index + 1);
  }
}

function hookStateKeyOf(segments: readonly string[], leaf: string | null): string | null {
  const expectedLength = leaf === null ? 3 : 4;
  if (segments.length !== expectedLength || segments[0] !== 'hooks' || segments[1] !== 'state') return null;
  if (leaf !== null && segments[3] !== leaf) return null;
  return segments[2];
}

function tableHeaderSegments(line: string): string[] | null {
  if (!line.startsWith('[') || line.startsWith('[[')) return null;
  const parsed = parseDottedKey(line, 1);
  if (!parsed || line[parsed.end] !== ']') return null;
  return parsed.segments;
}

function parseStringValue(text: string, start: number): string | null {
  if (text[start] === '"') return parseBasicString(text, start)?.value ?? null;
  if (text[start] !== "'") return null;
  const close = text.indexOf("'", start + 1);
  return close === -1 ? null : text.slice(start + 1, close);
}

function inlineTrustedHash(value: string): string | null {
  if (!value.startsWith('{')) return null;
  const match = TRUSTED_HASH_IN_INLINE_TABLE.exec(value);
  return match ? parseStringValue(value, match.index + match[0].length) : null;
}

export function trustedCodexHookHashes(configText: string): ReadonlyMap<string, string> {
  const trustedHashByKey = new Map<string, string>();
  let table: string[] = [];
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      table = tableHeaderSegments(line) ?? ['<unparsed>'];
      continue;
    }
    const assignment = parseDottedKey(line, 0);
    if (!assignment || line[assignment.end] !== '=') continue;
    const value = line.slice(skipSpaces(line, assignment.end + 1));
    const fullPath = [...table, ...assignment.segments];
    const hashedKey = hookStateKeyOf(fullPath, 'trusted_hash');
    const directHash = hashedKey === null ? null : parseStringValue(value, 0);
    if (hashedKey !== null && directHash !== null) trustedHashByKey.set(hashedKey, directHash);
    const inlineKey = hookStateKeyOf(fullPath, null);
    const inlineHash = inlineKey === null ? null : inlineTrustedHash(value);
    if (inlineKey !== null && inlineHash !== null) trustedHashByKey.set(inlineKey, inlineHash);
  }
  return trustedHashByKey;
}

function codexEventKeyLabel(eventName: string): string {
  return eventName.replace(/(?<=[a-z0-9])([A-Z])/g, '_$1').toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHashableString(value: unknown): value is string {
  return typeof value === 'string' && !LONE_SURROGATE.test(value);
}

function hasOnlyFields(record: Record<string, unknown>, allowedFields: ReadonlySet<string>): boolean {
  return Object.keys(record).every((field) => allowedFields.has(field));
}

function normalizedTimeoutSeconds(eventName: string, timeout: unknown): number | null {
  if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 0)) return null;
  if (SHORT_TIMEOUT_EVENTS.has(eventName)) return Math.min(Math.max(timeout ?? 1, 1), 3);
  return Math.max(timeout ?? 600, 1);
}

function normalizedHandlerIdentity(eventName: string, handler: unknown): HookHandlerIdentity | null {
  if (!isPlainObject(handler) || !hasOnlyFields(handler, HASHABLE_HANDLER_FIELDS) || handler.type !== 'command') return null;
  if (!isHashableString(handler.command) || handler.command.trim() === '') return null;
  if (handler.async !== undefined && typeof handler.async !== 'boolean') return null;
  if (handler.statusMessage !== undefined && !isHashableString(handler.statusMessage)) return null;
  const contextLimit = handler.additionalContextLimit;
  if (contextLimit !== undefined && contextLimit !== null && (typeof contextLimit !== 'number' || !Number.isSafeInteger(contextLimit) || contextLimit < 0)) return null;
  const timeout = normalizedTimeoutSeconds(eventName, handler.timeout);
  if (timeout === null) return null;
  const identity: HookHandlerIdentity = { type: 'command', command: handler.command, timeout, async: handler.async ?? false };
  if (handler.statusMessage !== undefined) identity.statusMessage = handler.statusMessage;
  if (typeof contextLimit === 'number' && contextLimit !== 2500 && ['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'SubagentStart'].includes(eventName)) identity.additionalContextLimit = contextLimit;
  return identity;
}

function sortedObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedObjectKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedObjectKeys(value[key])]));
}

function codexHandlerHash(eventName: string, group: Record<string, unknown>, handler: unknown): string | null {
  if (!KNOWN_EVENTS.has(eventName) || !hasOnlyFields(group, HASHABLE_GROUP_FIELDS)) return null;
  if (group.matcher !== undefined && !isHashableString(group.matcher)) return null;
  const handlerIdentity = normalizedHandlerIdentity(eventName, handler);
  if (handlerIdentity === null) return null;
  const hookIdentity: Record<string, unknown> = { event_name: codexEventKeyLabel(eventName), hooks: [handlerIdentity] };
  if (group.matcher !== undefined && !MATCHERLESS_EVENTS.has(eventName)) hookIdentity.matcher = group.matcher;
  return `sha256:${createHash('sha256').update(JSON.stringify(sortedObjectKeys(hookIdentity))).digest('hex')}`;
}

export function codexHookHashes(hooksFilePath: string, hooksFileText: string): ReadonlyMap<string, string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(hooksFileText);
  } catch {
    return new Map();
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.hooks)) return new Map();
  const currentHashByKey = new Map<string, string | null>();
  for (const [eventName, groups] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group: unknown, groupIndex) => {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) return;
      group.hooks.forEach((handler: unknown, handlerIndex) => {
        currentHashByKey.set(`${hooksFilePath}:${codexEventKeyLabel(eventName)}:${groupIndex}:${handlerIndex}`, codexHandlerHash(eventName, group, handler));
      });
    });
  }
  return currentHashByKey;
}

export function areCodexHooksTrusted(currentHashByKey: ReadonlyMap<string, string | null>, trustedHashByKey: ReadonlyMap<string, string>): boolean {
  if (currentHashByKey.size === 0) return false;
  return [...currentHashByKey].every(([hookKey, currentHash]) => currentHash !== null && trustedHashByKey.get(hookKey) === currentHash);
}
