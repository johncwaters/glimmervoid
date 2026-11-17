import { isRecord } from '../../shared/coerce.ts';

const SESSION_TAG_PREFIX_CHARS = 8;
const SESSION_TAG_PATTERN = /\[gv:([A-Za-z0-9-]{1,40})\]/g;
const MAX_INBOUND_TEXT_CHARS = 4000;

interface InboundMessage {
  sessionPrefixes: string[];
  text: string;
}

interface ParsedUpdate {
  updateId: number;
  message: InboundMessage | null;
}

interface RoutableSession {
  id: string;
  name: string;
  heldQuestion: { question: string; optionLabels: string[] } | null;
}

type InboundRoute =
  | { kind: 'answer'; sessionId: string; question: string; option: string }
  | { kind: 'deliver'; sessionId: string; text: string }
  | { kind: 'reply'; text: string };

function sessionTagFor(sessionId: string): string {
  return `[gv:${sessionId.slice(0, SESSION_TAG_PREFIX_CHARS)}]`;
}

function withoutSessionTags(text: string): string {
  return text.replaceAll('[gv:', '[gv ');
}

function sessionPrefixesIn(text: string): string[] {
  return [...new Set([...text.matchAll(SESSION_TAG_PATTERN)].map((match) => match[1]))];
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseInboundUpdate(update: unknown, allowedChatId: string): ParsedUpdate | null {
  if (!isRecord(update) || typeof update.update_id !== 'number' || !Number.isSafeInteger(update.update_id)) return null;
  const updateId = update.update_id;
  const message = update.message;
  if (!isRecord(message) || !isRecord(message.chat)) return { updateId, message: null };
  const chatId = message.chat.id;
  const isAllowedChat = allowedChatId.length > 0 && (typeof chatId === 'number' || typeof chatId === 'string') && String(chatId) === allowedChatId;
  if (!isAllowedChat) return { updateId, message: null };
  const ownText = textOf(message.text).trim();
  if (ownText.length === 0) return { updateId, message: null };
  const repliedTo = isRecord(message.reply_to_message) ? textOf(message.reply_to_message.text) : '';
  const ownPrefixes = sessionPrefixesIn(ownText);
  const sessionPrefixes = ownPrefixes.length > 0 ? ownPrefixes : sessionPrefixesIn(repliedTo);
  const text = ownText.replace(SESSION_TAG_PATTERN, '').trim().slice(0, MAX_INBOUND_TEXT_CHARS);
  return { updateId, message: { sessionPrefixes, text } };
}

function matchedOption(text: string, optionLabels: readonly string[]): string | null {
  const wanted = text.trim().toLowerCase();
  const byNumber = /^\d+$/.test(wanted) ? optionLabels[Number(wanted) - 1] : undefined;
  if (byNumber !== undefined) return byNumber;
  return optionLabels.find((label) => label.toLowerCase() === wanted) ?? null;
}

function optionListText(optionLabels: readonly string[]): string {
  return optionLabels.map((label, index) => `${index + 1}. ${label}`).join('\n');
}

function routeInbound(message: InboundMessage, sessions: readonly RoutableSession[]): InboundRoute {
  if (message.sessionPrefixes.length !== 1) {
    return { kind: 'reply', text: 'Reply to an alert from one session, or start the message with its [gv:...] tag, so Glimmervoid knows where to send it.' };
  }
  const [prefix] = message.sessionPrefixes;
  const matches = sessions.filter((session) => session.id.startsWith(prefix));
  if (matches.length !== 1) return { kind: 'reply', text: `No live session here matches ${sessionTagFor(prefix)}.` };
  const [session] = matches;
  const tag = sessionTagFor(session.id);
  const name = withoutSessionTags(session.name);
  if (message.text.length === 0) return { kind: 'reply', text: `Nothing to send to ${name}. ${tag}` };
  const held = session.heldQuestion;
  if (held === null) return { kind: 'deliver', sessionId: session.id, text: message.text };
  if (held.optionLabels.length === 0) return { kind: 'reply', text: `${name} is waiting on a question that needs the dashboard: ${withoutSessionTags(held.question)} ${tag}` };
  const option = matchedOption(message.text, held.optionLabels);
  if (option === null) {
    return { kind: 'reply', text: `${name} is waiting on a question: ${withoutSessionTags(held.question)}\nReply with one of:\n${withoutSessionTags(optionListText(held.optionLabels))}\n${tag}` };
  }
  return { kind: 'answer', sessionId: session.id, question: held.question, option };
}

export { parseInboundUpdate, routeInbound, sessionTagFor, withoutSessionTags };
export type { InboundRoute, RoutableSession };
