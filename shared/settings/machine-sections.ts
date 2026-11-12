import { USAGE_BUDGET_RANGE, USAGE_RETAIN_DAYS_RANGE } from '../settings-ranges.ts';
import { MACHINE_NOW, MACHINE_NEW_SESSIONS, READOUT, DAYS, USD } from './registry-fields.ts';
import type { SettingsSection } from './registry-fields.ts';

export const MACHINE_TELEGRAM: SettingsSection = {
  id: 'machine-telegram',
  level: 'machine',
  parent: 'browser-notifications',
  title: 'Telegram',
  description: 'One bot for session, review and PostHog alerts.',
  legacyIds: ['telegram', 'notifications'],
  settings: [
    {
      id: 'telegram-bot-token', path: 'telegram.botToken', title: 'Bot token',
      description: 'Token from @BotFather in Telegram (send /newbot).',
      control: 'password', keywords: ['credential', 'api'], defaultValue: '', ...MACHINE_NOW,
    },
    {
      id: 'telegram-chat-id', path: 'telegram.chatId', title: 'Chat id',
      description: 'Chat the bot posts to, read as message.chat.id from its getUpdates page after you message it.',
      control: 'text', keywords: ['destination', 'channel'], defaultValue: '', ...MACHINE_NOW,
    },
    {
      id: 'telegram-session-notifications', path: 'telegramNotifications', title: 'Send session notifications',
      description: 'Alert in Telegram when no dashboard is open, or when an alert sits unacknowledged.',
      control: 'toggle', keywords: ['phone', 'off dashboard', 'test'], defaultValue: false, status: 'telegram-delivery', ...MACHINE_NOW,
    },
  ],
};

export const MACHINE_SESSIONS: SettingsSection = {
  id: 'machine-sessions',
  level: 'machine',
  title: 'Sessions',
  description: 'How sessions start, where projects are found, and branch cleanup.',
  legacyIds: ['machine-general', 'general', 'machine-repositories', 'repos', 'repositories'],
  settings: [
    {
      id: 'auto-resume', path: 'autoResume', title: 'Auto-resume sessions on startup',
      description: 'Resume sessions that were live when Glimmervoid last stopped or crashed.',
      control: 'toggle', keywords: ['startup', 'conversation'], defaultValue: true, ...MACHINE_NOW,
    },
    {
      id: 'tab-order', path: 'viewTabOrder', title: 'Tab order',
      description: 'Order of the dashboard tabs, also set by dragging tabs in the header.',
      control: 'tab-order', keywords: ['tabs', 'order', 'rearrange', 'reorder', 'header', 'more', 'menu'], defaultValue: [], ...MACHINE_NOW,
    },
    {
      id: 'streamer-mode', path: 'streamerMode', title: 'Streamer mode',
      description: 'Hide sensitive details while screen sharing.',
      control: 'toggle', keywords: ['streaming', 'screen share', 'privacy'], defaultValue: false, ...MACHINE_NOW,
    },
    {
      id: 'link-previews', path: 'linkPreviews', title: 'Link page previews',
      description: 'Resting the pointer on a terminal link for about 600 ms fetches that page from this machine to show its title and icon. Off, the link card shows the address only.',
      control: 'toggle', keywords: ['links', 'preview', 'title', 'favicon', 'hover', 'privacy'], defaultValue: true, ...MACHINE_NOW,
    },
    {
      id: 'repository-roots', path: 'repoRoots', title: 'Repository roots',
      description: 'Folders scanned for projects when adding a session.',
      control: 'list', keywords: ['folders', 'project discovery'], defaultValue: [],
      listPlaceholder: 'Repository root path', listEmptyText: 'No repository roots configured.', ...MACHINE_NOW,
    },
    {
      id: 'hidden-agents', path: 'hiddenAgents', title: 'Agents in Add Session',
      description: 'Agents left out of the Add Session picker. Switch an agent off here to hide it; the default agent always stays.',
      control: 'agent-visibility', keywords: ['agents', 'picker', 'hide', 'show', 'add session', 'gemini', 'qwen', 'copilot', 'opencode', 'goose', 'cursor'], defaultValue: [], ...MACHINE_NOW,
    },
    {
      id: 'custom-agents', path: 'status:custom-agents', title: 'Custom agents',
      description: 'Extra agent CLIs a session can run.',
      control: 'readonly', keywords: ['adapters', 'cli'], status: 'custom-agents', ...READOUT,
    },
    {
      id: 'agent-logins', path: 'status:agent-logins', title: 'Agent logins',
      description: 'How Claude Code and Codex sign in inside a Coder workspace.',
      control: 'readonly', keywords: ['claude', 'codex', 'sign in', 'login', 'coder', 'remote'], status: 'agent-logins', ...READOUT,
    },
    {
      id: 'branch-gc-delete-unmerged', path: 'branchGc.deleteUnmerged', title: 'Delete unmerged branches',
      description: 'Also delete stale remote branches with no proof they were merged.',
      control: 'toggle', keywords: ['git', 'cleanup', 'orphan'], danger: true,
      warning: 'Enabling this control lets branch cleanup delete stale remote branches without merge proof.',
      legacyIds: [{ sectionId: 'machine-safety', settingId: 'branch-gc-delete-unmerged' }],
      defaultValue: false, ...MACHINE_NOW,
    },
  ],
};

export const MACHINE_SAFETY: SettingsSection = {
  id: 'machine-safety',
  level: 'machine',
  title: 'Sane YOLO',
  description: 'What agents may do without asking, and what Sane YOLO blocks.',
  legacyIds: ['machine-guardrails', 'lanes-unattended', 'unattended'],
  settings: [
    {
      id: 'skip-permissions-by-default', path: 'skipPermissionsByDefault', title: 'Skip permission prompts by default',
      description: 'Skip agent permission prompts for projects that set no choice.',
      control: 'toggle', keywords: ['permissions', 'yolo', 'dangerously'], danger: true,
      warning: 'Enabling this control lets agents edit files and run shell commands without asking, and restarts running sessions that inherit it.',
      defaultValue: false, ...MACHINE_NOW,
    },
    {
      id: 'sane-yolo', path: 'saneYolo', title: 'Sane YOLO',
      description: 'Block catastrophic commands and credential reads in every session that supports it.',
      control: 'toggle', keywords: ['permissions', 'yolo', 'safety'], defaultValue: true, ...MACHINE_NEW_SESSIONS,
    },
    {
      id: 'sane-yolo-unreadable-paths', path: 'saneYoloUnreadablePaths', title: 'Unreadable folders',
      description: 'Extra files and folders agents may not read, where ~ is your home folder.',
      control: 'list', keywords: ['guardrails', 'secrets', 'credentials', 'sane yolo'], defaultValue: [],
      listPlaceholder: '~/folder', listEmptyText: 'Only the built-in credential list is unreadable.', ...MACHINE_NEW_SESSIONS,
    },
  ],
};

export const MACHINE_VAULT: SettingsSection = {
  id: 'machine-vault',
  level: 'machine',
  title: 'Vault',
  description: 'Approved secrets, the vault companion, and the tokens Glimmervoid itself holds.',
  legacyIds: ['machine-secrets', 'lanes-github-access'],
  settings: [
    {
      id: 'github-read-token', path: 'github.readToken', title: 'GitHub read token',
      description: 'Read-only fine-grained GitHub token lanes use for gh. Team review and community research need it.',
      control: 'password', keywords: ['credential', 'token', 'gh', 'pull requests'], defaultValue: '', ...MACHINE_NOW,
    },
  ],
};

export const MACHINE_REMOTE: SettingsSection = {
  id: 'machine-remote',
  level: 'machine',
  title: 'Remote',
  description: 'Sessions in Coder workspaces, and a session that sets up Glimmervoid on another machine.',
  legacyIds: ['machine-hosts'],
  settings: [
    {
      id: 'remote-setup', path: 'status:remote-setup', title: 'Remote host setup',
      description: 'Start a session that helps you run Glimmervoid on another Linux machine over ssh.',
      control: 'readonly', keywords: ['remote', 'ssh', 'server', 'devbox', 'tailscale', 'pair', 'host'], status: 'remote-setup', ...READOUT,
      legacyIds: [{ sectionId: 'machine-sessions', settingId: 'remote-setup' }],
    },
  ],
};

export const MACHINE_SERVER: SettingsSection = {
  id: 'machine-server',
  level: 'machine',
  title: 'Server',
  description: 'Restart or shut down the Glimmervoid server.',
  settings: [
    {
      id: 'server-power', path: 'status:server-power', title: 'Restart or shut down',
      description: 'Ends every running session first.',
      control: 'readonly', keywords: ['power', 'restart', 'shutdown', 'stop', 'quit', 'reboot', 'server'],
      status: 'server-power', ...READOUT,
    },
  ],
};

export const MACHINE_UPDATES: SettingsSection = {
  id: 'machine-updates',
  level: 'machine',
  title: 'Updates',
  description: 'Which version is running, and updating to the newest.',
  legacyIds: ['updates'],
  settings: [
    {
      id: 'update-actions', path: 'status:update-actions', title: 'Status and actions',
      legacyIds: ['update-summary', 'update-installed', 'update-latest', 'update-last-checked'].map((settingId) => ({ sectionId: 'machine-updates', settingId })),
      description: 'Running and newest versions, with update and restart.',
      control: 'readonly', keywords: ['version', 'available', 'current', 'check', 'restart', 'commit', 'installed', 'release', 'failure'],
      status: 'update-actions', ...READOUT,
    },
    {
      id: 'check-updates', path: 'checkForUpdates', title: 'Check for updates automatically',
      description: 'Check for a newer version at launch and while the dashboard is open.',
      control: 'toggle', keywords: ['release', 'github'], defaultValue: true, ...MACHINE_NOW,
    },
  ],
};

export const MACHINE_USAGE: SettingsSection = {
  id: 'machine-usage',
  level: 'machine',
  title: 'Usage',
  description: 'Token accounting and estimated-cost budgets.',
  legacyIds: ['usage'],
  settings: [
    {
      id: 'usage-enabled', path: 'usage.enabled', title: 'Track token usage',
      description: 'Read local agent transcripts for the Usage tab and session cards.',
      control: 'toggle', keywords: ['tokens', 'cost'], defaultValue: true, status: 'usage-last-report', ...MACHINE_NOW,
    },
    {
      id: 'usage-your-day', path: 'usage.yourDay', title: 'Your day',
      description: 'Recap yesterday and suggest a pace for today when usage tracking is on.',
      control: 'toggle', keywords: ['burnout', 'breaks', 'pace', 'wellbeing'], defaultValue: true, ...MACHINE_NOW,
      legacyIds: [{ sectionId: 'machine-sessions', settingId: 'hint-cards' }],
    },
    {
      id: 'usage-retain-days', path: 'usage.retainDays', title: 'Retain transcript detail',
      description: 'How long detailed usage is kept.',
      control: 'number', range: USAGE_RETAIN_DAYS_RANGE, unit: DAYS, keywords: ['history', 'retention'], defaultValue: 90, ...MACHINE_NOW,
    },
    {
      id: 'usage-daily-budget', path: 'usage.budget.dailyUsd', title: 'Daily budget',
      description: 'Alert at 50%, 75% and 100% of this estimated daily spend, or never at zero.',
      control: 'number', range: USAGE_BUDGET_RANGE, unit: USD, keywords: ['spend', 'alert'], defaultValue: null,
      integer: false, nullable: true, zeroIsNull: true, step: 0.01, ...MACHINE_NOW,
    },
    {
      id: 'usage-monthly-budget', path: 'usage.budget.monthlyUsd', title: 'Monthly budget',
      description: 'Alert at 50%, 75% and 100% of this estimated monthly spend, or never at zero.',
      control: 'number', range: USAGE_BUDGET_RANGE, unit: USD, keywords: ['spend', 'alert'], defaultValue: null,
      integer: false, nullable: true, zeroIsNull: true, step: 0.01, ...MACHINE_NOW,
    },
  ],
};

export const MACHINE_PRIVACY: SettingsSection = {
  id: 'machine-privacy',
  level: 'machine',
  title: 'Privacy',
  description: 'What Glimmervoid sends about itself.',
  legacyIds: ['privacy', 'telemetry'],
  settings: [
    {
      id: 'telemetry-enabled', path: 'telemetry.enabled', title: 'Send usage data',
      description: 'Helps us improve Glimmervoid. Sent under a random install id: version, platform, app starts, daily activity, session starts and ends with agent kind, exit kind and duration, errors as their type, error code and scrubbed stack frames, per session token counts, models and estimated costs from the usage scan, and a salted one-way hash of your Claude and Codex account ids so installs of one account count together. The text of errors the dashboard shows in its header line, with your home folder shown as ~, which can name a session, folder or branch. Otherwise never prompts, project information, other error messages, paths, repository or branch names, objectives, terminal output, emails or names. Delete my data asks for everything sent under this install to be erased and starts a new install id. GLIMMERVOID_TELEMETRY=0, DO_NOT_TRACK=1 or CI=true turn it off regardless.',
      control: 'toggle', keywords: ['telemetry', 'analytics', 'tracking', 'opt out'], defaultValue: true, ...MACHINE_NOW,
    },
  ],
};
