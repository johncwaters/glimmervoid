import { POSTHOG_PROJECT_ID_RANGE, REVIEWS_TURN_LIMIT_DEFAULT, REVIEWS_TURN_LIMIT_RANGE } from '../settings-ranges.ts';
import { BROWSER_NOW, MACHINE_NOW, READOUT } from './registry-fields.ts';
import type { SettingsSection } from './registry-fields.ts';

export const LANES_BACKGROUND_JOBS: SettingsSection = {
  id: 'lanes-background-jobs',
  level: 'lanes',
  title: 'Background jobs',
  description: 'The Claude Code account each lane runs under, and which plan pays for it. Lanes running another agent use this machine\'s login.',
  settings: [
    {
      id: 'lane-accounts', path: 'status:lane-accounts', title: 'Lane accounts',
      description: 'A lane that follows the default moves with it when you change the default on the Accounts page.',
      control: 'readonly', keywords: ['claude', 'account', 'plan', 'billing', 'team review', 'radar', 'community', 'task titles', 'question manager', 'lanes'], status: 'lane-accounts', ...READOUT,
    },
  ],
};

const POSTHOG_ENABLED = { path: 'posthog.enabled', equals: true } as const;
const COMMUNITY_ENABLED = { path: 'community.enabled', equals: true } as const;
const POSTHOG_CONNECTION_USED = { anyOf: [POSTHOG_ENABLED, COMMUNITY_ENABLED] } as const;

export const LANES_POSTHOG: SettingsSection = {
  id: 'lanes-posthog',
  level: 'lanes',
  title: 'PostHog',
  description: 'Error monitoring, investigations and traffic-spike alerts.',
  legacyIds: ['lanes', 'posthog'],
  settings: [
    {
      id: 'posthog-enabled', path: 'posthog.enabled', title: 'Enable PostHog monitoring',
      description: 'Watch PostHog error tracking and investigate issues that move.',
      control: 'toggle', keywords: ['errors', 'monitoring'], defaultValue: false, ...MACHINE_NOW,
    },
    {
      id: 'posthog-host', path: 'posthog.host', title: 'Host',
      description: 'PostHog cloud or self-hosted URL.',
      control: 'text', keywords: ['url', 'server'], defaultValue: 'https://us.posthog.com', visibleWhen: POSTHOG_CONNECTION_USED, ...MACHINE_NOW,
    },
    {
      id: 'posthog-api-key', path: 'posthog.apiKey', title: 'Personal API key',
      description: 'Personal API key with read access to your projects.',
      control: 'password', keywords: ['credential', 'token'], defaultValue: '', visibleWhen: POSTHOG_CONNECTION_USED, ...MACHINE_NOW,
    },
    {
      id: 'posthog-read-api-key', path: 'posthog.readApiKey', title: 'Read-only API key for the watcher',
      description: 'Personal API key with read scopes only. The watcher uses it to notice new errors and community questions, so Radar and Community stop polling on a timer.',
      control: 'password', keywords: ['credential', 'token', 'watcher', 'read access'], defaultValue: '', visibleWhen: POSTHOG_CONNECTION_USED, ...MACHINE_NOW,
    },
    {
      id: 'posthog-projects', path: 'posthog.projects', title: 'Projects',
      description: 'Project ids to watch, where empty watches all and none watches none.',
      control: 'list', keywords: ['project ids', 'filter'], defaultValue: 'all', valueKind: 'posthog-projects',
      listPlaceholder: 'Project id', listEmptyText: 'Every project the key can read.', visibleWhen: POSTHOG_ENABLED, ...MACHINE_NOW,
    },
    {
      id: 'posthog-traffic-enabled', path: 'posthog.trafficSpikeEnabled', title: 'Traffic spike alerts',
      description: 'Alert when unique users jump above normal.',
      control: 'toggle', keywords: ['analytics', 'alert'], defaultValue: true, visibleWhen: POSTHOG_ENABLED, ...MACHINE_NOW,
    },
    {
      id: 'posthog-auto-fix', path: 'posthog.autoFix', title: 'Attempt fixes for major issues',
      description: 'Let an agent fix an issue on a local branch, opening a pull request only after you approve.',
      control: 'toggle', keywords: ['automatic', 'pull request'], danger: true,
      warning: 'Enabling this control lets an agent that read PostHog error data edit code onto a local branch; nothing is pushed until you approve it.', defaultValue: false, visibleWhen: POSTHOG_ENABLED, ...MACHINE_NOW,
    },
  ],
};

export const LANES_TEAM_REVIEW: SettingsSection = {
  id: 'lanes-team-review',
  level: 'lanes',
  title: 'Reviews',
  description: "Team review drafts reviews of teammates' pull requests for you to post; My pull requests keeps your own moving.",
  legacyIds: ['team-review', 'reviews'],
  settings: [
    {
      id: 'team-review-enabled', path: 'teamReview.enabled', title: 'Enable team review',
      description: 'Draft a review of each open team pull request, posting nothing until you approve or comment.',
      control: 'toggle', keywords: ['pull requests', 'github'], defaultValue: true, ...MACHINE_NOW,
    },
    {
      id: 'github-teams', path: 'github.teams', title: 'GitHub teams',
      description: 'GitHub teams whose review requests are drafted, as org/team-slug.',
      control: 'list', keywords: ['github', 'teams', 'review requests'], defaultValue: [],
      listPlaceholder: 'org/team-slug', listEmptyText: 'No GitHub teams configured.', ...MACHINE_NOW,
    },
    {
      id: 'team-review-org', path: 'teamReview.org', title: 'GitHub organization',
      description: 'Organization whose pull requests that request your review directly are drafted. Needed only when no GitHub team is set.',
      control: 'text', keywords: ['github', 'organization', 'org', 'review requests'], defaultValue: '',
      visibleWhen: { path: 'github.teams', isSet: false }, ...MACHINE_NOW,
    },
    {
      id: 'team-review-skill', path: 'teamReview.skill', title: 'Review skill',
      description: 'Skill Claude Code follows for each review, or none when empty.',
      control: 'text', keywords: ['skill', 'claude code', 'pr review'], defaultValue: '', suggestionsFrom: 'review-skills', ...MACHINE_NOW,
    },
    {
      id: 'team-review-sandbox-load-mcp-servers', path: 'teamReview.sandbox.loadMcpServers', title: 'Load my MCP servers',
      description: 'Give the review agent your own MCP servers.',
      control: 'toggle', keywords: ['mcp', 'servers', 'tools'], danger: true,
      warning: 'Enabling this control gives the review agent, which reads untrusted pull request text, every tool your MCP servers expose.', defaultValue: false, ...MACHINE_NOW,
    },
    {
      id: 'reviews-turn-limit', path: 'pref:reviewsTurnLimit', title: 'Reviewing now limit',
      description: 'How many pull requests the Reviews Reviewing now column holds at once. 0 means no cap.', control: 'number', integer: true, step: 1,
      range: REVIEWS_TURN_LIMIT_RANGE, keywords: ['reviews', 'board', 'wip', 'limit'], defaultValue: REVIEWS_TURN_LIMIT_DEFAULT,
      legacyIds: [{ sectionId: 'browser-appearance', settingId: 'reviews-turn-limit' }], ...BROWSER_NOW,
    },
  ],
};

export const LANES_MY_PRS: SettingsSection = {
  id: 'lanes-my-prs',
  level: 'lanes',
  parent: 'lanes-team-review',
  title: 'My pull requests',
  description: 'Keep your own pull requests rebased, mergeable and merged, and run workflow rules on their events.',
  legacyIds: ['workflows', 'lanes-workflows'],
  settings: [
    {
      id: 'team-review-auto-rebase-my-prs', path: 'teamReview.autoRebaseMyPrs', title: 'Keep my pull requests rebased',
      description: 'Rebase your open pull requests when they fall behind their base branch.',
      control: 'toggle', keywords: ['rebase', 'update branch', 'behind', 'my prs'], danger: true,
      warning: 'Enabling this control rewrites your pull request branches on GitHub. Pull before you push from a local checkout of one.', defaultValue: false, ...MACHINE_NOW,
      legacyIds: [{ sectionId: 'lanes-team-review', settingId: 'team-review-auto-rebase-my-prs' }],
    },
    {
      id: 'workflows-enabled', path: 'workflows.enabled', title: 'Run workflows',
      description: 'Watch the repositories your rules name and run their actions.',
      control: 'toggle', keywords: ['pull requests', 'automation', 'master switch'], defaultValue: true, ...MACHINE_NOW,
    },
    {
      id: 'workflows-rules', path: 'status:workflow-rules', title: 'Workflow rules',
      description: 'Turn each workflow rule on or off.',
      control: 'readonly', keywords: ['pull requests', 'automation', 'github', 'rules'], status: 'workflows', ...READOUT,
    },
  ],
};

export const LANES_COMMUNITY: SettingsSection = {
  id: 'lanes-community',
  level: 'lanes',
  title: 'Community',
  description: 'Research new posthog.com community questions and draft replies.',
  settings: [
    {
      id: 'community-enabled', path: 'community.enabled', title: 'Show the Community tab',
      description: 'Research new community questions and draft a reply for each.',
      control: 'toggle', keywords: ['community', 'questions', 'forum', 'tab'], defaultValue: false, ...MACHINE_NOW,
    },
    {
      id: 'community-skill', path: 'community.skill', title: 'Research skill',
      description: 'Skill the research agent follows, or none when empty.',
      control: 'text', keywords: ['skill', 'answering', 'claude code'], defaultValue: '', visibleWhen: COMMUNITY_ENABLED, ...MACHINE_NOW,
    },
    {
      id: 'community-project-id', path: 'community.projectId', title: 'PostHog project',
      description: 'PostHog project holding the community forum and Discord data.',
      control: 'number', integer: true, range: POSTHOG_PROJECT_ID_RANGE, unit: { label: 'project id', storedPerDisplay: 1 }, keywords: ['project id', 'warehouse'], defaultValue: 2, visibleWhen: COMMUNITY_ENABLED, ...MACHINE_NOW,
    },
    {
      id: 'community-discord-channels', path: 'community.discordChannels', title: 'Discord channels',
      description: 'Discord channels to watch for questions, without the #, or none to skip Discord.',
      control: 'list', keywords: ['discord', 'channels', 'allowlist'], defaultValue: [], visibleWhen: COMMUNITY_ENABLED, ...MACHINE_NOW,
    },
  ],
};
