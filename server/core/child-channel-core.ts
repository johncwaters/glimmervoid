import { BADGE_LABELS, STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';

const MAX_UNREAD_ENTRIES_PER_SIDE = 50;
const MAX_ENTRY_CHARS = 4000;
const MAX_STOP_NOTE_MESSAGE_CHARS = 2000;
const MAX_WAKES_WITHOUT_OPERATOR = 10;
const OPERATOR_TYPING_HOLD_OFF_MS = 30_000;
const STARTUP_STATES: readonly SessionState[] = [STATES.DORMANT, STATES.INITIALIZING, STATES.STARTING];
const TURN_END_STATES: readonly SessionState[] = [STATES.IDLE, STATES.COMPLETE, STATES.WAITING];
const ENDED_STATES: readonly SessionState[] = [STATES.DONE, STATES.FAILED];
const WAKEABLE_STATES: readonly SessionState[] = [STATES.IDLE, STATES.COMPLETE];

type ChannelAuthor = 'parent' | 'child' | 'glimmervoid';
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

interface AgentChannel {
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
  recipientState: SessionState;
  hasUnread: boolean;
  isWakePending: boolean;
  isOperatorFlagged: boolean;
  wakesSinceOperatorInput: number;
  msSinceOperatorInput: number;
}

type WakeDecision =
  | { kind: 'none' }
  | { kind: 'hold'; retryInMs: number }
  | { kind: 'flag-operator' }
  | { kind: 'wake' };

type ChildTarget = { ok: true; channel: AgentChannel } | { ok: false; error: string };

const EMPTY_MAILBOX: Mailbox = Object.freeze({ unread: Object.freeze([]), droppedCount: 0 });

function openChannel({ parentId, childId, childName }: { parentId: string; childId: string; childName: string }): AgentChannel {
  return { parentId, childId, childName, toParent: EMPTY_MAILBOX, toChild: EMPTY_MAILBOX };
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

function hasWakingUnread(mailbox: Mailbox): boolean {
  return mailbox.unread.some((entry) => entry.wakes);
}

function shouldStopNoteWake(state: SessionState, hasParentRead: boolean): boolean {
  return state !== STATES.DONE || !hasParentRead;
}

function shouldPostStopNote(from: SessionState, to: SessionState): boolean {
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

function describeWakeLine(channel: AgentChannel, side: ChannelSide): string {
  if (side === 'toParent') return `Glimmervoid: ${channel.childName}, the session you spawned, has news. Run glimmervoid read ${channel.childId} and act on it.`;
  return 'Glimmervoid: the session that spawned you sent a message. Run glimmervoid read and act on it.';
}

function describeWakeCapNote(channel: AgentChannel): string {
  return `Glimmervoid stopped waking this session after ${MAX_WAKES_WITHOUT_OPERATOR} wake lines between ${channel.childName} and its parent with no operator input; glimmervoid read shows what is waiting`;
}

function decideWake(facts: WakeFacts): WakeDecision {
  if (!facts.hasUnread || facts.isWakePending || facts.isOperatorFlagged) return { kind: 'none' };
  if (!WAKEABLE_STATES.includes(facts.recipientState)) return { kind: 'none' };
  if (facts.wakesSinceOperatorInput >= MAX_WAKES_WITHOUT_OPERATOR) return { kind: 'flag-operator' };
  if (facts.msSinceOperatorInput < OPERATOR_TYPING_HOLD_OFF_MS) return { kind: 'hold', retryInMs: OPERATOR_TYPING_HOLD_OFF_MS - facts.msSinceOperatorInput };
  return { kind: 'wake' };
}

function canSubmitWake({ recipientState, pastedAt, lastOperatorInputAt }: { recipientState: SessionState; pastedAt: number; lastOperatorInputAt: number }): boolean {
  if (lastOperatorInputAt >= pastedAt) return false;
  return WAKEABLE_STATES.includes(recipientState);
}

export {
  canSubmitWake, decideWake, describeStopNote, describeWakeCapNote, describeWakeLine, drainChannel, findOwnedChild, hasWakingUnread,
  openChannel, postToChannel, readLastAssistantMessage, shouldPostStopNote, shouldStopNoteWake,
};
export type { AgentChannel, ChannelEntry, ChannelSide };
