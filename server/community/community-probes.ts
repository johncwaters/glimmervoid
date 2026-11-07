import type { Probe } from '../../shared/contracts/watcher-link.ts';
import { posthogQueryProbe } from '../lanes/posthog-query-probe.ts';
import { COMMUNITY_LANE_ID, DISCORD_CHANNEL_NAME_EXPRESSION } from './core/community-core.ts';
import type { CommunitySettings } from './core/community-core.ts';

const NEWEST_FORUM_QUESTION_QUERY = "SELECT max(JSONExtractString(attributes, 'createdAt')) FROM custom.squeak.questions";
const NEWEST_DISCORD_MESSAGE_QUERY = [
  "SELECT max(timestamp) FROM events WHERE event IN ('message_sent', 'thread_created') AND timestamp > now() - INTERVAL 7 DAY",
  `AND has({channels}, ${DISCORD_CHANNEL_NAME_EXPRESSION})`,
].join(' ');

function communityProbes({ host, settings, hasDiscordSource }: { host: string; settings: CommunitySettings; hasDiscordSource: boolean }): Probe[] {
  const shared = { laneId: COMMUNITY_LANE_ID, host, projectId: settings.projectId, intervalMinutes: settings.intervalMinutes };
  const forumProbe = posthogQueryProbe({ ...shared, id: `${COMMUNITY_LANE_ID}:forum`, query: NEWEST_FORUM_QUESTION_QUERY });
  if (!hasDiscordSource) return [forumProbe];
  return [forumProbe, posthogQueryProbe({ ...shared, id: `${COMMUNITY_LANE_ID}:discord`, query: NEWEST_DISCORD_MESSAGE_QUERY, values: { channels: settings.discordChannels } })];
}

export { communityProbes };
