const MAX_UNREAD_ENTRIES_PER_SIDE = 50;
const MAX_ENTRY_CHARS = 4000;

type ChannelAuthor = 'parent' | 'child' | 'glimmervoid';
type ChannelSide = 'toParent' | 'toChild';

interface ChannelEntry {
  author: ChannelAuthor;
  text: string;
  at: number;
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

export { drainChannel, findOwnedChild, openChannel, postToChannel };
export type { AgentChannel, ChannelEntry, ChannelSide };
