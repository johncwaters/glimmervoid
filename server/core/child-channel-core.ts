import { BADGE_LABELS, STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';
import { isCompactionRestoreEvent } from '../../shared/compaction-restore-events.ts';
import type { ConversationApproval } from '../../shared/contracts/session.ts';
import { shellQuote } from '../../shared/text.ts';
import { relayNewsLine, SIBLING_MESSAGE_LINE } from '../../shared/glimmervoid-lines.ts';

const MAX_UNREAD_ENTRIES_PER_SIDE = 50;
const MAX_ENTRY_CHARS = 4000;
const MAX_STOP_NOTE_MESSAGE_CHARS = 2000;
const OPERATOR_TYPING_HOLD_OFF_MS = 30_000;
const WAKE_TURN_START_TIMEOUT_MS = 5000;
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

interface Mailbox {
  unread: readonly ChannelEntry[];
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

interface DrainedMailbox {
  entries: readonly ChannelEntry[];
  droppedCount: number;
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

const EMPTY_MAILBOX: Mailbox = Object.freeze({ unread: Object.freeze([]), droppedCount: 0 });

function openChannel({ kind, parentId, childId, childName }: { kind: ChannelKind; parentId: string; childId: string; childName: string }): AgentChannel {
  return { kind, parentId, childId, childName, toParent: EMPTY_MAILBOX, toChild: EMPTY_MAILBOX };
}

function truncateEntryText(text: string): string {
  if (text.length <= MAX_ENTRY_CHARS) return text;
  return `${text.slice(0, MAX_ENTRY_CHARS)} [truncated ${text.length - MAX_ENTRY_CHARS} characters]`;
}

function postToMailbox(mailbox: Mailbox, entry: ChannelEntry): Mailbox {
  const unread = [...mailbox.unread, { ...entry, text: truncateEntryText(entry.text) }];
  const overflowCount = Math.max(0, unread.length - MAX_UNREAD_ENTRIES_PER_SIDE);
  return { unread: unread.slice(overflowCount), droppedCount: mailbox.droppedCount + overflowCount };
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

function drainChannel(channel: AgentChannel, side: ChannelSide): { channel: AgentChannel; drained: DrainedMailbox } {
  const { unread, droppedCount } = channel[side];
  return { channel: { ...channel, [side]: EMPTY_MAILBOX }, drained: { entries: unread, droppedCount } };
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
  if (fullNote.length <= MAX_ENTRY_CHARS) return fullNote;
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
  WAKE_TURN_START_TIMEOUT_MS, decideWake, describeQuestionNote, describeStopNote, describeWakeLine, drainChannel, findOwnedChild, findSibling, hasWakingUnread,
  isWakeLineAwaitingTurnStart, openChannel, postToChannel, quietUnread, readLastAssistantMessage, shouldPostStopNote, shouldReuseWithheldWakeLine, shouldStopNoteWake, withdrawUnreadNote,
};
export type { AgentChannel, ChannelEntry, ChannelKind, ChannelSide };
