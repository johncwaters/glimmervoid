import { BADGE_LABELS, STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';
import { isCompactionRestoreEvent } from '../../shared/compaction-restore-events.ts';
import type { ConversationApproval } from '../../shared/contracts/session.ts';
import { shellQuote } from '../../shared/text.ts';
import { relayNewsLine, SIBLING_MESSAGE_LINE } from '../../shared/glimmervoid-lines.ts';

const MAX_UNREAD_ENTRIES_PER_SIDE = 50;
const READ_PAGE_CHARS = 8000;
const MAX_INLINE_QUESTION_NOTE_CHARS = 4000;
const MAX_STOP_NOTE_MESSAGE_CHARS = 2000;
const OPERATOR_TYPING_HOLD_OFF_MS = 30_000;
const WAKE_TURN_START_TIMEOUT_MS = 5000;
const CHANNEL_READ_CURSOR_PATTERN = /^([pc])\.([a-zA-Z0-9_-]+)\.(\d+)\.(\d+)$/;
const STARTUP_STATES: readonly SessionState[] = [STATES.DORMANT, STATES.INITIALIZING, STATES.STARTING];
const TURN_END_STATES: readonly SessionState[] = [STATES.IDLE, STATES.COMPLETE, STATES.WAITING];
const ENDED_STATES: readonly SessionState[] = [STATES.DONE, STATES.FAILED];

type ChannelAuthor = 'parent' | 'child' | 'sibling' | 'glimmervoid';
type ChannelSide = 'toParent' | 'toChild';

interface ChannelEntry {
  author: ChannelAuthor;
  text: string;
  at: number;
  wakes: boolean;
}

interface StoredChannelEntry extends ChannelEntry {
  seq: number;
  readOffset: number;
}

interface Mailbox {
  unread: readonly StoredChannelEntry[];
  nextSeq: number;
  droppedCount: number;
}

type ChannelKind = 'spawned' | 'branch';

interface AgentChannel {
  kind: ChannelKind;
  parentId: string;
  childId: string;
  childName: string;
  toParent: Mailbox;
  toChild: Mailbox;
}

interface DrainedChannelEntry {
  author: ChannelAuthor;
  text: string;
  at: number;
  truncated?: boolean;
  offset?: number;
  totalChars?: number;
  remainingChars?: number;
}

interface DrainedMailboxPage {
  entries: readonly DrainedChannelEntry[];
  droppedCount: number;
  nextCursor: string | null;
}

interface ChannelPageCursor {
  side: ChannelSide;
  childId: string;
  seq: number;
  offset: number;
}

interface WakeFacts {
  isRecipientBetweenTurns: boolean;
  hasUnread: boolean;
  isWakePending: boolean;
  msSinceOperatorInput: number;
}

type WakeDecision =
  | { kind: 'none' }
  | { kind: 'hold'; retryInMs: number }
  | { kind: 'wake' };

type ChildTarget = { ok: true; channel: AgentChannel } | { ok: false; error: string };

const EMPTY_MAILBOX: Mailbox = Object.freeze({ unread: Object.freeze([]), nextSeq: 1, droppedCount: 0 });

function openChannel({ kind, parentId, childId, childName }: { kind: ChannelKind; parentId: string; childId: string; childName: string }): AgentChannel {
  return { kind, parentId, childId, childName, toParent: EMPTY_MAILBOX, toChild: EMPTY_MAILBOX };
}

function formatChannelReadCursor({ side, childId, seq, offset }: ChannelPageCursor): string {
  const sideCode = side === 'toParent' ? 'p' : 'c';
  return `${sideCode}.${childId}.${seq}.${offset}`;
}

function parseChannelReadCursor(rawCursor: string): ChannelPageCursor | null {
  const match = CHANNEL_READ_CURSOR_PATTERN.exec(rawCursor);
  if (!match) return null;
  const seq = Number(match[3]);
  const offset = Number(match[4]);
  if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(offset) || offset < 0) return null;
  return { side: match[1] === 'p' ? 'toParent' : 'toChild', childId: match[2], seq, offset };
}

function matchesMailboxCursor(mailbox: Mailbox, cursor: ChannelPageCursor): boolean {
  const head = mailbox.unread[0];
  if (!head) return false;
  return head.seq === cursor.seq && head.readOffset === cursor.offset;
}

function postToMailbox(mailbox: Mailbox, entry: ChannelEntry): Mailbox {
  const storedEntry: StoredChannelEntry = { ...entry, seq: mailbox.nextSeq, readOffset: 0 };
  const unread = [...mailbox.unread, storedEntry];
  const overflowCount = Math.max(0, unread.length - MAX_UNREAD_ENTRIES_PER_SIDE);
  return { unread: unread.slice(overflowCount), nextSeq: mailbox.nextSeq + 1, droppedCount: mailbox.droppedCount + overflowCount };
}

function postToChannel(channel: AgentChannel, side: ChannelSide, entry: ChannelEntry): AgentChannel {
  return { ...channel, [side]: postToMailbox(channel[side], entry) };
}

function withdrawUnreadNote(channel: AgentChannel, side: ChannelSide, text: string): AgentChannel {
  const unread = channel[side].unread.filter((entry) => entry.author !== 'glimmervoid' || entry.text !== text);
  return { ...channel, [side]: { ...channel[side], unread } };
}

function quietUnread(channel: AgentChannel, side: ChannelSide): AgentChannel {
  const unread = channel[side].unread.map((entry) => ({ ...entry, wakes: false }));
  return { ...channel, [side]: { ...channel[side], unread } };
}

function drainChannelPage(channel: AgentChannel, side: ChannelSide, pageChars = READ_PAGE_CHARS): { channel: AgentChannel; drained: DrainedMailboxPage } {
  const mailbox = channel[side];
  if (mailbox.unread.length === 0) {
    return {
      channel: { ...channel, [side]: { unread: [], nextSeq: mailbox.nextSeq, droppedCount: 0 } },
      drained: { entries: [], droppedCount: mailbox.droppedCount, nextCursor: null },
    };
  }
  const delivered: DrainedChannelEntry[] = [];
  let remainingBudget = pageChars;
  let index = 0;
  while (index < mailbox.unread.length) {
    const entry = mailbox.unread[index];
    const totalChars = entry.text.length;
    const startOffset = entry.readOffset;
    const unreadLength = totalChars - startOffset;
    if (unreadLength <= remainingBudget) {
      delivered.push(startOffset === 0
        ? { author: entry.author, at: entry.at, text: entry.text }
        : { author: entry.author, at: entry.at, text: entry.text.slice(startOffset), truncated: false, offset: startOffset, totalChars, remainingChars: 0 });
      remainingBudget -= unreadLength;
      index += 1;
      continue;
    }
    if (delivered.length > 0) break;
    const chunkLength = Math.max(1, pageChars);
    const endOffset = startOffset + chunkLength;
    const remainingChars = totalChars - endOffset;
    delivered.push({
      author: entry.author,
      at: entry.at,
      text: entry.text.slice(startOffset, endOffset),
      truncated: true,
      offset: startOffset,
      totalChars,
      remainingChars,
    });
    const nextUnread = [{ ...entry, readOffset: endOffset, wakes: false }, ...mailbox.unread.slice(index + 1)];
    const nextCursor = formatChannelReadCursor({ side, childId: channel.childId, seq: entry.seq, offset: endOffset });
    return {
      channel: { ...channel, [side]: { unread: nextUnread, nextSeq: mailbox.nextSeq, droppedCount: 0 } },
      drained: { entries: delivered, droppedCount: mailbox.droppedCount, nextCursor },
    };
  }
  const remainingUnread = mailbox.unread.slice(index);
  const nextHead = remainingUnread[0];
  const nextCursor = nextHead ? formatChannelReadCursor({ side, childId: channel.childId, seq: nextHead.seq, offset: nextHead.readOffset }) : null;
  return {
    channel: { ...channel, [side]: { unread: remainingUnread, nextSeq: mailbox.nextSeq, droppedCount: 0 } },
    drained: { entries: delivered, droppedCount: mailbox.droppedCount, nextCursor },
  };
}

function findOwnedChild(channels: readonly AgentChannel[], parentId: string, target: string): ChildTarget {
  const wanted = target.trim();
  const owned = channels.filter((channel) => channel.parentId === parentId);
  const match = owned.find((channel) => channel.childId === wanted) ?? owned.find((channel) => channel.childName === wanted);
  if (match) return { ok: true, channel: match };
  if (owned.length === 0) return { ok: false, error: 'this session owns no spawned sessions' };
  const ownedNames = owned.map((channel) => `"${channel.childName}" (${channel.childId})`).join(', ');
  return { ok: false, error: `${wanted} is not a session this one spawned; its spawned sessions are ${ownedNames}` };
}

function findSibling(channels: readonly AgentChannel[], senderChildId: string, target: string): ChildTarget {
  const sender = channels.find((channel) => channel.childId === senderChildId);
  if (!sender) return { ok: false, error: 'only a spawned session has siblings to message' };
  if (sender.kind === 'branch') return { ok: false, error: 'a branch messages only its main: glimmervoid send <text> reaches the main, which passes it on to other branches' };
  const wanted = target.trim();
  const siblings = channels.filter((channel) => channel.kind === 'spawned' && channel.parentId === sender.parentId && channel.childId !== senderChildId);
  const match = siblings.find((channel) => channel.childId === wanted) ?? siblings.find((channel) => channel.childName === wanted);
  if (match) return { ok: true, channel: match };
  if (siblings.length === 0) return { ok: false, error: 'this session has no sibling sessions spawned by the same parent' };
  const siblingNames = siblings.map((channel) => `"${channel.childName}" (${channel.childId})`).join(', ');
  return { ok: false, error: `${wanted} is not a sibling of this session; its siblings are ${siblingNames}` };
}

function hasWakingUnread(mailbox: Mailbox): boolean {
  return mailbox.unread.some((entry) => entry.wakes);
}

function takeSessionInTurnNotices(channels: readonly AgentChannel[], sessionId: string): { updatedChannels: AgentChannel[]; notices: string[] } {
  const updatedChannels: AgentChannel[] = [];
  const notices: string[] = [];
  for (const channel of channels) {
    if (channel.childId === sessionId && hasWakingUnread(channel.toChild)) {
      notices.push(describeWakeLine(channel, 'toChild'));
      updatedChannels.push(quietUnread(channel, 'toChild'));
      continue;
    }
    if (channel.parentId === sessionId && hasWakingUnread(channel.toParent)) {
      notices.push(describeWakeLine(channel, 'toParent'));
      updatedChannels.push(quietUnread(channel, 'toParent'));
    }
  }
  return { updatedChannels, notices };
}

function shouldStopNoteWake(state: SessionState, hasParentRead: boolean): boolean {
  return state !== STATES.DONE || !hasParentRead;
}

function shouldPostStopNote(from: SessionState, to: SessionState, event?: string): boolean {
  if (isCompactionRestoreEvent(event)) return false;
  if (ENDED_STATES.includes(to)) return !ENDED_STATES.includes(from);
  if (!TURN_END_STATES.includes(to)) return false;
  return !TURN_END_STATES.includes(from) && !STARTUP_STATES.includes(from);
}

function readLastAssistantMessage(payload: Record<string, unknown>): string | null {
  const message = payload.last_assistant_message ?? payload.lastAssistantMessage;
  if (typeof message !== 'string' || !message.trim()) return null;
  return message;
}

function describeChildState(childName: string, state: SessionState): string {
  if (state === STATES.WAITING) return `${childName} is waiting on the operator at a prompt, and its card is flagged for the operator`;
  if (state === STATES.DONE) return `${childName} exited`;
  if (state === STATES.FAILED) return `${childName} failed`;
  return `${childName} finished a turn and is ${BADGE_LABELS[state]}`;
}

function describeStopNote({ childName, state, lastMessage }: { childName: string; state: SessionState; lastMessage: string | null }): string {
  const summary = describeChildState(childName, state);
  if (lastMessage === null) return summary;
  const shownMessage = lastMessage.length <= MAX_STOP_NOTE_MESSAGE_CHARS
    ? lastMessage
    : `${lastMessage.slice(0, MAX_STOP_NOTE_MESSAGE_CHARS)} [truncated ${lastMessage.length - MAX_STOP_NOTE_MESSAGE_CHARS} characters]`;
  return `${summary}. Its last message:\n${shownMessage}`;
}

function describeQuestionNote(childName: string, childRef: string, approval: ConversationApproval): string {
  const answerCommand = `glimmervoid answer ${childRef}`;
  const operatorLine = `Or pass it to the operator: ${answerCommand} --operator`;
  const questions = approval.questions ?? [];
  if (approval.isSummaryTruncated || questions.length === 0) {
    return [`${childName} asks a question too large to answer here. Pass it to the operator: ${answerCommand} --operator`, approval.summary].join('\n');
  }
  const questionLines = questions.map((question, index) => `${index + 1}. ${question.question} [${question.options.map((option) => option.label).join(' | ')}]`);
  const exampleAnswers = Object.fromEntries(questions.map((question) => [question.question, question.options[0].label]));
  const fullNote = [
    `${childName} asks:`,
    ...questionLines,
    `Answer: ${answerCommand} ${shellQuote(JSON.stringify(exampleAnswers))}`,
    operatorLine,
  ].join('\n');
  if (fullNote.length <= MAX_INLINE_QUESTION_NOTE_CHARS) return fullNote;
  return [
    `${childName} asks the questions below.`,
    `Answer: ${answerCommand} '{"<question text>":"<option label>"}' with one entry per question, each keyed by its full text`,
    operatorLine,
    ...questionLines,
  ].join('\n');
}

function describeWakeLine(channel: AgentChannel, side: ChannelSide): string {
  if (side === 'toParent') return relayNewsLine(channel.childName, channel.childId);
  return SIBLING_MESSAGE_LINE;
}

function isWakeLineAwaitingTurnStart(isRecipientBetweenTurns: boolean, msSinceSubmit: number): boolean {
  return isRecipientBetweenTurns && msSinceSubmit < WAKE_TURN_START_TIMEOUT_MS;
}

function shouldReuseWithheldWakeLine({ pastedAt, lastOperatorInputAt }: { pastedAt: number; lastOperatorInputAt: number }): boolean {
  return lastOperatorInputAt < pastedAt;
}

function decideWake(facts: WakeFacts): WakeDecision {
  if (!facts.hasUnread || facts.isWakePending) return { kind: 'none' };
  if (!facts.isRecipientBetweenTurns) return { kind: 'none' };
  if (facts.msSinceOperatorInput < OPERATOR_TYPING_HOLD_OFF_MS) return { kind: 'hold', retryInMs: OPERATOR_TYPING_HOLD_OFF_MS - facts.msSinceOperatorInput };
  return { kind: 'wake' };
}

export {
  WAKE_TURN_START_TIMEOUT_MS, decideWake, describeQuestionNote, describeStopNote, describeWakeLine, drainChannelPage, findOwnedChild, findSibling, hasWakingUnread,
  isWakeLineAwaitingTurnStart, matchesMailboxCursor, openChannel, parseChannelReadCursor, postToChannel, quietUnread, readLastAssistantMessage, shouldPostStopNote, shouldReuseWithheldWakeLine, shouldStopNoteWake, takeSessionInTurnNotices, withdrawUnreadNote,
};
export type { AgentChannel, ChannelEntry, ChannelKind, ChannelPageCursor, ChannelSide };
