import { KEEP_MERGEABLE_TIMEOUT_MINUTES_RANGE, POSITIVE_NUMBER_RANGE, WORKFLOWS_MAX_CONCURRENT_SESSIONS_RANGE, COMMUNITY_INTERVAL_MINUTES_RANGE, POSTHOG_PROJECT_ID_RANGE } from '../settings-ranges.ts';
import { MACHINE_NOW, READOUT, INVESTIGATIONS, SESSIONS, MINUTES, HOURS, DAYS, USERS } from './registry-fields.ts';
import type { SettingsSection } from './registry-fields.ts';

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
      control: 'text', keywords: ['url', 'server'], defaultValue: 'https://us.posthog.com', ...MACHINE_NOW,
    },
    {
      id: 'posthog-api-key', path: 'posthog.apiKey', title: 'Personal API key',
      description: 'Personal API key with read access to your projects.',
      control: 'password', keywords: ['credential', 'token'], defaultValue: '', ...MACHINE_NOW,
    },
    {
      id: 'posthog-projects', path: 'posthog.projects', title: 'Projects',
      description: 'Project ids to watch, where empty watches all and none watches none.',
      control: 'list', keywords: ['project ids', 'filter'], defaultValue: 'all', valueKind: 'posthog-projects',
      listPlaceholder: 'Project id', listEmptyText: 'Every project the key can read.', ...MACHINE_NOW,
    },
    {
      id: 'posthog-interval', path: 'posthog.intervalMinutes', title: 'Poll interval',
      description: 'Time between PostHog checks.',
      control: 'number', integer: false, step: 'any', range: POSITIVE_NUMBER_RANGE, unit: MINUTES, keywords: ['refresh', 'schedule'], defaultValue: 15, ...MACHINE_NOW,
    },
    {
      id: 'posthog-max-investigations', path: 'posthog.maxConcurrentInvestigations', title: 'Max concurrent investigations',
      description: 'Most investigations running at once.',
      control: 'number', range: POSITIVE_NUMBER_RANGE, unit: INVESTIGATIONS, keywords: ['parallel', 'workers'], defaultValue: 2, ...MACHINE_NOW,
    },
    {
      id: 'posthog-min-users', path: 'posthog.minUsersToInvestigate', title: 'Min users to investigate',
      description: 'Fewest affected users before a new issue is investigated.',
      control: 'number', range: POSITIVE_NUMBER_RANGE, unit: USERS, keywords: ['threshold', 'affected'], defaultValue: 1, ...MACHINE_NOW,
    },
    {
      id: 'posthog-traffic-enabled', path: 'posthog.trafficSpikeEnabled', title: 'Traffic spike alerts',
      description: 'Alert when unique users jump above normal.',
      control: 'toggle', keywords: ['analytics', 'alert'], defaultValue: true, ...MACHINE_NOW,
    },
    {
      id: 'posthog-auto-fix', path: 'posthog.autoFix', title: 'Attempt fixes for major issues',
      description: 'Let an agent fix an issue on a local branch, opening a pull request only after you approve.',
      control: 'toggle', keywords: ['automatic', 'pull request'], danger: true,
      warning: 'Enabling this control lets an agent that read PostHog error data edit code onto a local branch; nothing is pushed until you approve it.', defaultValue: false, ...MACHINE_NOW,
    },
  ],
};

export const LANES_GITHUB_ACCESS: SettingsSection = {
  id: 'lanes-github-access',
  level: 'lanes',
  title: 'Lane GitHub access',
  description: 'What background lanes may read on GitHub and the web.',
  settings: [
    {
      id: 'github-read-token', path: 'github.readToken', title: 'GitHub read token',
      description: 'Read-only fine-grained GitHub token lanes use for gh. Team review and community research need it.',
      control: 'password', keywords: ['credential', 'token', 'gh', 'pull requests'], defaultValue: '', ...MACHINE_NOW,
    },
    {
      id: 'lanes-fetch-domains', path: 'lanes.fetchDomains', title: 'Extra fetch domains',
      description: 'Domains lanes may fetch pages from, beyond GitHub and posthog.com.',
      control: 'list', keywords: ['web', 'fetch', 'domains', 'allowlist'], defaultValue: [],
      listPlaceholder: 'docs.example.com', listEmptyText: 'Only the built-in domains.', ...MACHINE_NOW,
    },
  ],
};

export const LANES_TEAM_REVIEW: SettingsSection = {
  id: 'lanes-team-review',
  level: 'lanes',
  title: 'Team review',
  description: "Draft reviews of teammates' pull requests for you to post.",
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
      control: 'text', keywords: ['github', 'organization', 'org', 'review requests'], defaultValue: '', ...MACHINE_NOW,
    },
    {
      id: 'team-review-re-review-after-hours', path: 'teamReview.reReviewAfterHours', title: 'Re-review after',
      description: 'Review a pull request again after a new push, once this much time has passed.',
      control: 'number', range: POSITIVE_NUMBER_RANGE, unit: HOURS, keywords: ['review', 'delay'], defaultValue: 24, integer: false, step: 0.5, ...MACHINE_NOW,
    },
    {
      id: 'team-review-skip-idle-after-days', path: 'teamReview.skipIdleAfterDays', title: 'Skip PRs idle for',
      description: 'Skip pull requests with no activity for this long.',
      control: 'number', range: POSITIVE_NUMBER_RANGE, unit: DAYS, keywords: ['idle', 'activity'], defaultValue: 14, integer: false, step: 0.5, ...MACHINE_NOW,
    },
    {
      id: 'team-review-skill', path: 'teamReview.skill', title: 'Review skill',
      description: 'Skill Claude Code follows for each review, or none when empty.',
      control: 'text', keywords: ['skill', 'claude code', 'pr review'], defaultValue: '', suggestionsFrom: 'review-skills', ...MACHINE_NOW,
    },
    {
      id: 'team-review-reviewer-model', path: 'teamReview.reviewer.model', title: 'Review model',
      description: "Model for reviews, or the agent's default when empty.",
      control: 'text', keywords: ['model', 'opus', 'sonnet', 'reviewer'], defaultValue: '', suggestionsFrom: 'review-models', ...MACHINE_NOW,
    },
    {
      id: 'team-review-reviewer-effort', path: 'teamReview.reviewer.effort', title: 'Review effort',
      description: "Effort for reviews, or the agent's default when empty.",
      control: 'text', keywords: ['effort', 'thinking', 'reasoning', 'reviewer'], defaultValue: '', suggestionsFrom: 'review-efforts', ...MACHINE_NOW,
    },
    {
      id: 'team-review-stamp-reviewer-model', path: 'teamReview.stampReviewer.model', title: 'Docs and tests PR model',
      description: 'Model for pull requests that only touch docs and tests.',
      control: 'text', keywords: ['stamp', 'model', 'small pull requests', 'docs', 'tests'], defaultValue: '', suggestionsFrom: 'review-stamp-models', ...MACHINE_NOW,
    },
    {
      id: 'team-review-stamp-reviewer-effort', path: 'teamReview.stampReviewer.effort', title: 'Docs and tests PR effort',
      description: 'Effort for pull requests that only touch docs and tests.',
      control: 'text', keywords: ['stamp', 'effort', 'small pull requests', 'docs', 'tests'], defaultValue: '', suggestionsFrom: 'review-stamp-efforts', ...MACHINE_NOW,
    },
    {
      id: 'team-review-sandbox-load-mcp-servers', path: 'teamReview.sandbox.loadMcpServers', title: 'Load my MCP servers',
      description: 'Give the review agent your own MCP servers.',
      control: 'toggle', keywords: ['mcp', 'servers', 'tools'], danger: true,
      warning: 'Enabling this control gives the review agent, which reads untrusted pull request text, every tool your MCP servers expose.', defaultValue: false, ...MACHINE_NOW,
    },
    {
      id: 'team-review-auto-rebase-my-prs', path: 'teamReview.autoRebaseMyPrs', title: 'Keep my pull requests rebased',
      description: 'Rebase your open pull requests when they fall behind their base branch.',
      control: 'toggle', keywords: ['rebase', 'update branch', 'behind', 'my prs'], danger: true,
      warning: 'Enabling this control rewrites your pull request branches on GitHub. Pull before you push from a local checkout of one.', defaultValue: false, ...MACHINE_NOW,
    },
    {
      id: 'team-review-keep-mergeable-enabled', path: 'teamReview.keepMergeableEnabled', title: 'Keep mergeable',
      description: 'Offer Keep mergeable: an agent fixes conflicts and failing checks on your pull requests.',
      control: 'toggle', keywords: ['repair', 'conflicts', 'my prs'], defaultValue: true, ...MACHINE_NOW,
    },
    {
      id: 'team-review-keep-mergeable-timeout', path: 'teamReview.keepMergeableTimeoutMinutes', title: 'Keep mergeable deadline',
      description: 'Longest a Keep mergeable repair may run.',
      control: 'number', range: KEEP_MERGEABLE_TIMEOUT_MINUTES_RANGE, unit: MINUTES, keywords: ['timeout', 'repair'], defaultValue: 30, ...MACHINE_NOW,
    },
    {
      id: 'team-review-merge-queue-enabled', path: 'teamReview.mergeQueueEnabled', title: 'Merge when ready',
      description: 'Offer Merge when ready: queued pull requests merge once they pass.',
      control: 'toggle', keywords: ['merge queue', 'auto merge', 'my prs'], defaultValue: true, ...MACHINE_NOW,
    },
  ],
};

export const LANES_WORKFLOWS: SettingsSection = {
  id: 'lanes-workflows',
  level: 'lanes',
  title: 'Workflows',
  description: 'Rules that act on pull request events.',
  legacyIds: ['workflows'],
  settings: [
    {
      id: 'workflows-enabled', path: 'workflows.enabled', title: 'Run workflows',
      description: 'Watch the repositories your rules name and run their actions.',
      control: 'toggle', keywords: ['pull requests', 'automation', 'master switch'], defaultValue: true, ...MACHINE_NOW,
    },
    {
      id: 'workflows-max-concurrent-sessions', path: 'workflows.maxConcurrentSessions', title: 'Concurrent agent sessions',
      description: 'Most workflow sessions running at once.',
      control: 'number', range: WORKFLOWS_MAX_CONCURRENT_SESSIONS_RANGE, unit: SESSIONS, keywords: ['parallel', 'spawn'], defaultValue: 2, ...MACHINE_NOW,
    },
    {
      id: 'workflows-rules', path: 'status:workflow-rules', title: 'Workflow rules',
      description: 'Turn each workflow rule on or off.',
      control: 'readonly', keywords: ['pull requests', 'automation', 'github', 'rules'], status: 'workflows', ...READOUT,
    },
  ],
};

export const LANES_BENCHMARKS: SettingsSection = {
  id: 'lanes-benchmarks',
  level: 'lanes',
  title: 'Benchmarks',
  description: 'Compare agent setups on frozen benchmark cases.',
  legacyIds: ['benchmarks'],
  settings: [
    {
      id: 'benchmarks-enabled', path: 'benchmarks.enabled', title: 'Enable benchmarks',
      description: 'Show the Bench tab, where nothing runs until you start it.',
      control: 'toggle', keywords: ['eval', 'arms', 'recall', 'compare'], defaultValue: false, ...MACHINE_NOW,
    },
  ],
};

export const LANES_COHERENCE: SettingsSection = {
  id: 'lanes-coherence',
  level: 'lanes',
  title: 'Coherence',
  description: 'Coherence hook status and decision journal per session.',
  settings: [
    {
      id: 'coherence-enabled', path: 'coherence.enabled', title: 'Show session Coherence',
      description: "Show each session's Coherence hook status and decisions (needs @posthog/coherence 1.8 or newer).",
      control: 'toggle', keywords: ['experimental', 'coherence', 'journal', 'decisions'], defaultValue: false, ...MACHINE_NOW,
    },
  ],
};

export const LANES_ISSUES: SettingsSection = {
  id: 'lanes-issues',
  level: 'lanes',
  title: 'Issues',
  description: 'GitHub issues from your projects and teams.',
  settings: [
    {
      id: 'issues-enabled', path: 'issues.enabled', title: 'Show the Issues tab',
      description: 'Show an Issues tab listing GitHub issues for your projects and teams.',
      control: 'toggle', keywords: ['experimental', 'issues', 'github', 'tab'], defaultValue: false, ...MACHINE_NOW,
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
      control: 'toggle', keywords: ['experimental', 'community', 'questions', 'forum', 'tab'], defaultValue: false, ...MACHINE_NOW,
    },
    {
      id: 'community-skill', path: 'community.skill', title: 'Research skill',
      description: 'Skill the research agent follows, or none when empty.',
      control: 'text', keywords: ['skill', 'answering', 'claude code'], defaultValue: '', ...MACHINE_NOW,
    },
    {
      id: 'community-project-id', path: 'community.projectId', title: 'PostHog project',
      description: 'PostHog project holding the community forum and Discord data.',
      control: 'number', integer: true, range: POSTHOG_PROJECT_ID_RANGE, unit: { label: 'project id', storedPerDisplay: 1 }, keywords: ['project id', 'warehouse'], defaultValue: 2, ...MACHINE_NOW,
    },
    {
      id: 'community-interval', path: 'community.intervalMinutes', title: 'Poll interval',
      description: 'Time between community checks.',
      control: 'number', integer: true, range: COMMUNITY_INTERVAL_MINUTES_RANGE, unit: MINUTES, keywords: ['refresh', 'schedule'], defaultValue: 5, ...MACHINE_NOW,
    },
    {
      id: 'community-discord-channels', path: 'community.discordChannels', title: 'Discord channels',
      description: 'Discord channels to watch for questions, without the #, or none to skip Discord.',
      control: 'list', keywords: ['discord', 'channels', 'allowlist'], defaultValue: [], ...MACHINE_NOW,
    },
  ],
};
