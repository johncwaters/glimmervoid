import { runHogQL, runSource, sinceIso } from './posthog-query.mjs';

const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const SNOWFLAKE = /^\d{1,30}$/;
const RUN_GAP_MS = 15 * 60 * 1000;
const RUN_BODY_MAX_CHARACTERS = 4000;
const CHANNEL_NAME_EXPRESSION = "replaceRegexpAll(lower(coalesce(properties.root_channel_name, properties.parent_channel_name)), '^[^a-z0-9]+', '')";

const MESSAGES_QUERY = [
  'SELECT uuid, event, timestamp, properties.channel_id AS channel_id, properties.guild_id AS guild_id,',
  `${CHANNEL_NAME_EXPRESSION} AS channel_name, properties.message_content AS message_content,`,
  'properties.thread_id AS thread_id, properties.thread_name AS thread_name,',
  'distinct_id AS author_ref, properties.is_reply AS is_reply',
  "FROM events WHERE event IN ('message_sent', 'thread_created') AND timestamp > parseDateTimeBestEffort({since})",
  `AND has({channels}, ${CHANNEL_NAME_EXPRESSION})`,
  'ORDER BY timestamp ASC',
].join(' ');

function allowedChannels() {
  const channels = (process.env.DISCORD_CHANNELS ?? '').split(',').map((channel) => channel.trim().replace(/^#/, '').toLowerCase()).filter((channel) => CHANNEL_NAME.test(channel));
  if (channels.length === 0) throw new Error('DISCORD_CHANNELS names no channel; list them comma separated, such as help,feature-requests');
  return [...new Set(channels)].slice(0, 50);
}

function text(row, field) {
  return typeof row[field] === 'string' ? row[field] : '';
}

function channelIdOf(row) {
  return text(row, 'event') === 'thread_created' ? text(row, 'thread_id') : text(row, 'channel_id');
}

function titleOf(content) {
  return (content.split(/\r?\n/).find((line) => line.trim() !== '') ?? '').trim().slice(0, 120) || 'Discord message';
}

function itemOf(row, threadNames) {
  const guildId = text(row, 'guild_id');
  const channelId = channelIdOf(row);
  const createdAtMs = Date.parse(text(row, 'timestamp'));
  const content = text(row, 'event') === 'thread_created' ? text(row, 'thread_name') : text(row, 'message_content');
  if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId) || Number.isNaN(createdAtMs) || content.trim() === '') return null;
  return {
    id: text(row, 'uuid'),
    title: (threadNames.get(channelId) ?? titleOf(content)).slice(0, 300),
    body: content.slice(0, 20000),
    url: `https://discord.com/channels/${guildId}/${channelId}`,
    author: 'Discord member',
    channel: text(row, 'channel_name'),
    tags: [],
    createdAt: new Date(createdAtMs).toISOString(),
    resolved: false,
  };
}

function joinedRuns(rows, threadNames) {
  const items = [];
  const openRunByUrl = new Map();
  for (const row of rows) {
    const item = itemOf(row, threadNames);
    if (item === null) continue;
    const authorRef = text(row, 'author_ref');
    const canJoin = authorRef !== '' && text(row, 'event') === 'message_sent' && row.is_reply !== true && row.is_reply !== 'true';
    const messageMs = Date.parse(item.createdAt);
    const openRun = openRunByUrl.get(item.url);
    const runStart = openRun === undefined ? undefined : items[openRun.index];
    const joinedBody = runStart === undefined ? '' : `${runStart.body}\n\n${item.body}`;
    if (canJoin && runStart !== undefined && openRun.authorRef === authorRef && messageMs - openRun.lastMessageMs <= RUN_GAP_MS && joinedBody.length <= RUN_BODY_MAX_CHARACTERS) {
      items[openRun.index] = { ...runStart, body: joinedBody, createdAt: item.createdAt };
      openRun.lastMessageMs = messageMs;
      continue;
    }
    items.push(item);
    openRunByUrl.delete(item.url);
    if (canJoin) openRunByUrl.set(item.url, { authorRef, index: items.length - 1, lastMessageMs: messageMs });
  }
  return items;
}

runSource(async () => {
  const rows = await runHogQL(MESSAGES_QUERY, { since: sinceIso(), channels: allowedChannels() });
  const threadNames = new Map(rows.filter((row) => text(row, 'event') === 'thread_created' && text(row, 'thread_name').trim() !== '').map((row) => [text(row, 'thread_id'), text(row, 'thread_name')]));
  const threadsWithStarter = new Set(rows.filter((row) => text(row, 'event') === 'message_sent' && threadNames.has(text(row, 'channel_id'))).map((row) => text(row, 'channel_id')));
  return joinedRuns(rows.filter((row) => text(row, 'event') !== 'thread_created' || !threadsWithStarter.has(text(row, 'thread_id'))), threadNames);
});
