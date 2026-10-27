import { POST_TURN_CHECK_MODES } from '../contracts/browser-config.ts';
import { UPDATE_CHANNELS } from '../contracts/update-journal.ts';
import {
  FLYING_ANIMALS_DEFAULTS, FLYING_ANIMALS_DURATION_RANGE, FLYING_ANIMALS_GAP_RANGE,
  FLYING_ANIMALS_SCALE_RANGE, KEEP_MERGEABLE_TIMEOUT_MINUTES_RANGE, NON_NEGATIVE_NUMBER_RANGE, PORT_RANGE, POSITIVE_NUMBER_RANGE,
  POSTHOG_FIX_TIMEOUT_RANGE, POSTHOG_TRAFFIC_BASELINE_RANGE, POSTHOG_TRAFFIC_MIN_USERS_RANGE, POSTHOG_TRAFFIC_MULTIPLIER_RANGE,
  MEMORY_RESERVE_MB_RANGE, REPLAY_BUFFER_KB_RANGE, TASK_TITLE_TIMEOUT_RANGE, USAGE_BUDGET_RANGE, USAGE_INTEGER_RANGES, USAGE_RETAIN_DAYS_RANGE, USAGE_SCAN_INTERVAL_RANGE,
  WORKFLOWS_MAX_ACTIONS_PER_POLL_RANGE, WORKFLOWS_MAX_CONCURRENT_SESSIONS_RANGE,
} from '../settings-ranges.ts';
import type { SettingsRange } from '../settings-ranges.ts';
import { USAGE_COST_MODES } from '../usage-config.ts';

type SettingsScope = 'browser' | 'machine';
type SettingsAccess = 'editable' | 'advanced' | 'readout' | 'file-only';
export type SettingsEffect = 'now' | 'new-sessions' | 'restart';
export type SettingsLevel = 'browser' | 'machine' | 'lanes';
type SettingsControl = 'toggle' | 'number' | 'text' | 'password' | 'select' | 'list' | 'projects' | 'json' | 'readonly' | 'shortcut-key' | 'tab-order';
export type SettingsChoicePresentation = 'segmented' | 'select';

interface SettingsOption {
  value: string;
  label: string;
}

interface SettingsUnit {
  label: string;
  storedPerDisplay: number;
  storedLabel?: string;
}

interface SettingsLegacyId {
  sectionId: string;
  settingId: string;
}

export interface SettingsSetting {
  id: string;
  path: string;
  title: string;
  description: string;
  keywords: readonly string[];
  control: SettingsControl;
  scope: SettingsScope;
  access: SettingsAccess;
  takesEffect: SettingsEffect;
  fileOnlyReason?: string;
  group?: string;
  legacyIds?: readonly SettingsLegacyId[];
  options?: readonly SettingsOption[];
  optionsFrom?: string;
  presentation?: SettingsChoicePresentation;
  listPlaceholder?: string;
  listEmptyText?: string;
  defaultValue?: unknown;
  integer?: boolean;
  nullable?: boolean;
  zeroIsNull?: boolean;
  step?: number | 'any';
  range?: SettingsRange;
  unit?: SettingsUnit;
  maximumSettingId?: string;
  valueKind?: string;
  warning?: string;
  danger?: boolean;
  status?: string;
}

export interface SettingsSection {
  id: string;
  level: SettingsLevel;
  title: string;
  description: string;
  parent?: string;
  legacyIds?: readonly string[];
  settings: readonly SettingsSetting[];
}

export interface SettingsGroup {
  title: string;
  description: string;
}

export interface SettingsRegistry {
  sections: readonly SettingsSection[];
  fileOnly: readonly SettingsSetting[];
}

const BROWSER_NOW = { scope: 'browser', access: 'editable', takesEffect: 'now' } as const;
const BROWSER_ADVANCED = { scope: 'browser', access: 'advanced', takesEffect: 'now' } as const;
const MACHINE_NOW = { scope: 'machine', access: 'editable', takesEffect: 'now' } as const;
const MACHINE_NEW_SESSIONS = { scope: 'machine', access: 'editable', takesEffect: 'new-sessions' } as const;
const READOUT = { scope: 'machine', access: 'readout', takesEffect: 'now' } as const;
const FILE_ONLY = { scope: 'machine', access: 'file-only' } as const;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const MS_PER_HOUR = MS_PER_MINUTE * MINUTES_PER_HOUR;
const MS_PER_DAY = MS_PER_HOUR * 24;

const INVESTIGATIONS: SettingsUnit = { label: 'investigations', storedPerDisplay: 1 };
const SESSIONS: SettingsUnit = { label: 'sessions', storedPerDisplay: 1 };
const RECURRENCES: SettingsUnit = { label: 'recurrences', storedPerDisplay: 1 };
const ACTIONS: SettingsUnit = { label: 'actions', storedPerDisplay: 1 };
const SECONDS: SettingsUnit = { label: 'seconds', storedPerDisplay: 1 };
const MINUTES: SettingsUnit = { label: 'minutes', storedPerDisplay: 1 };
const HOURS: SettingsUnit = { label: 'hours', storedPerDisplay: 1 };
const DAYS: SettingsUnit = { label: 'days', storedPerDisplay: 1 };
const SECONDS_STORED_AS_MS: SettingsUnit = { label: 'seconds', storedPerDisplay: MS_PER_SECOND, storedLabel: 'ms' };
const MINUTES_STORED_AS_MS: SettingsUnit = { label: 'minutes', storedPerDisplay: MS_PER_MINUTE, storedLabel: 'ms' };
const MINUTES_STORED_AS_SECONDS: SettingsUnit = { label: 'minutes', storedPerDisplay: SECONDS_PER_MINUTE, storedLabel: 'seconds' };
const HOURS_STORED_AS_MS: SettingsUnit = { label: 'hours', storedPerDisplay: MS_PER_HOUR, storedLabel: 'ms' };
const HOURS_STORED_AS_MINUTES: SettingsUnit = { label: 'hours', storedPerDisplay: MINUTES_PER_HOUR, storedLabel: 'minutes' };
const DAYS_STORED_AS_MS: SettingsUnit = { label: 'days', storedPerDisplay: MS_PER_DAY, storedLabel: 'ms' };
const USD: SettingsUnit = { label: 'USD', storedPerDisplay: 1 };
const USERS: SettingsUnit = { label: 'users', storedPerDisplay: 1 };
const REVIEWS_PER_HOUR: SettingsUnit = { label: 'reviews per hour', storedPerDisplay: 1 };
const MULTIPLIER: SettingsUnit = { label: 'times', storedPerDisplay: 1 };

const TUNING_KNOB = 'A tuning knob kept out of the Settings view; the default suits almost every install.';
const DIAGNOSTIC = 'A diagnostic switch kept out of the Settings view; change it in config.json while investigating.';
const PROCESS_SETTING = 'Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind.';
const STRUCTURED_VALUE = 'A structured value with no dashboard control; edit it in config.json.';
const BY_RULE = 'Never editable from the dashboard by rule; edit it in config.json.';

function capitalizedOptions(values: readonly string[]): SettingsOption[] {
  return values.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
}

export const FILE_ONLY_GROUPS: Readonly<Record<string, SettingsGroup>> = Object.freeze({
  'machine-terminal': { title: 'Terminal', description: 'Terminal behavior shared by dashboard clients.' },
  'machine-detection-sessions': { title: 'Detection and sessions', description: 'Config-file-only detection, timing, worktree and process settings.' },
  'lanes-ingest': { title: 'Ingest', description: 'The machine-context sources behind Visions.' },
});

const SECTIONS: readonly SettingsSection[] = Object.freeze([
  {
    id: 'browser-appearance',
    level: 'browser',
    title: 'Appearance',
    description: 'How this browser draws the dashboard.',
    legacyIds: ['browser-flying-animals', 'animals', 'flying-animals'],
    settings: [
      {
        id: 'theme', path: 'pref:themeId', title: 'Theme',
        description: 'Color scheme for the dashboard.',
        control: 'select', optionsFrom: 'themes', keywords: ['color', 'palette'], defaultValue: 'phyrexian', ...BROWSER_NOW,
      },
      {
        id: 'session-usage-chips', path: 'pref:sessionUsageChips', title: 'Show usage on session cards',
        description: "Shows each card's transcript token count and CLI-reported cost when available, otherwise a calculated API list-price estimate.",
        control: 'toggle', keywords: ['usage', 'cost', 'tokens', 'card', 'price'], defaultValue: false, ...BROWSER_NOW,
      },
      {
        id: 'phone-arrow-pad', path: 'pref:phoneArrowPad', title: 'Swipe arrow pad on phone (experimental)',
        description: 'Replace the four arrow keys above the phone keyboard with one pad: swipe on it to send arrow keys, one per short drag.',
        control: 'toggle', keywords: ['experimental', 'mobile', 'keys', 'arrows', 'swipe', 'gesture'], defaultValue: false, ...BROWSER_NOW,
      },
      {
        id: 'flying-animals', path: 'pref:flyingAnimalsEnabled', title: 'Flying animals',
        description: 'Show animated animals flying across the dashboard.',
        control: 'toggle', keywords: ['animation', 'motion', 'animals'], defaultValue: false, ...BROWSER_NOW,
      },
      {
        id: 'animals-min-gap', path: 'pref:flyingAnimalsMinGapSeconds', title: 'Time between flights: minimum',
        description: 'Shortest pause between flights.', control: 'number', integer: false, step: 0.1,
        range: FLYING_ANIMALS_GAP_RANGE, unit: SECONDS, maximumSettingId: 'animals-max-gap', keywords: ['animals', 'frequency'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsMinGapSeconds, ...BROWSER_ADVANCED,
      },
      {
        id: 'animals-max-gap', path: 'pref:flyingAnimalsMaxGapSeconds', title: 'Time between flights: maximum',
        description: 'Longest pause between flights.', control: 'number', integer: false, step: 0.1,
        range: FLYING_ANIMALS_GAP_RANGE, unit: SECONDS, keywords: ['animals', 'frequency'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsMaxGapSeconds, ...BROWSER_ADVANCED,
      },
      {
        id: 'animals-min-duration', path: 'pref:flyingAnimalsMinDurationSeconds', title: 'Flight duration: minimum',
        description: 'Shortest flight, for faster animals.', control: 'number', integer: false, step: 0.1,
        range: FLYING_ANIMALS_DURATION_RANGE, unit: SECONDS, maximumSettingId: 'animals-max-duration', keywords: ['animals', 'speed'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsMinDurationSeconds, ...BROWSER_ADVANCED,
      },
      {
        id: 'animals-max-duration', path: 'pref:flyingAnimalsMaxDurationSeconds', title: 'Flight duration: maximum',
        description: 'Longest flight, for slower animals.', control: 'number', integer: false, step: 0.1,
        range: FLYING_ANIMALS_DURATION_RANGE, unit: SECONDS, keywords: ['animals', 'speed'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsMaxDurationSeconds, ...BROWSER_ADVANCED,
      },
      {
        id: 'animals-scale', path: 'pref:flyingAnimalsScale', title: 'Size multiplier',
        description: 'Scale applied on top of the viewport size.', control: 'number', integer: false, step: 0.1,
        range: FLYING_ANIMALS_SCALE_RANGE, unit: MULTIPLIER, keywords: ['animals', 'size'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsScale, ...BROWSER_ADVANCED,
      },
      {
        id: 'animals-on-phone', path: 'pref:flyingAnimalsOnPhone', title: 'Show on phone layout',
        description: 'Allow flights on the phone layout.', control: 'toggle',
        keywords: ['animals', 'mobile'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsOnPhone, ...BROWSER_ADVANCED,
      },
    ],
  },
  {
    id: 'browser-notifications',
    level: 'browser',
    title: 'Notifications',
    description: 'How this browser, and the Telegram bot shared by every lane, get your attention.',
    settings: [
      {
        id: 'alert-sounds-enabled', path: 'pref:soundEnabled', title: 'Alert sounds',
        legacyIds: [{ sectionId: 'browser-appearance', settingId: 'alert-sounds-enabled' }],
        description: 'Play sounds when a session needs attention and when a merge celebration plays. The same switch as the note button in the desktop header.',
        control: 'toggle', keywords: ['audio', 'mute', 'sound', 'notification'], defaultValue: true, ...BROWSER_NOW,
      },
      {
        id: 'alert-sound', path: 'pref:soundId', title: 'Alert sound',
        legacyIds: [{ sectionId: 'browser-appearance', settingId: 'alert-sound' }],
        description: 'Sound played when a session needs attention. Your own .ogg, .mp3, .wav, .m4a or .webm files dropped into the sounds folder of the Glimmervoid home (~/.glimmervoid/sounds/, or $GLIMMERVOID_HOME/sounds/) are listed after the built-in sounds. Glimmervoid never creates that folder, so make it yourself; new files show up the next time Settings opens.',
        control: 'select', optionsFrom: 'sounds', keywords: ['audio', 'notification', 'custom'], defaultValue: 'chime', ...BROWSER_NOW,
      },
      {
        id: 'desktop-notifications', path: 'pref:notificationsEnabled', title: 'Desktop notifications',
        legacyIds: [{ sectionId: 'browser-appearance', settingId: 'desktop-notifications' }],
        description: 'Raise a browser notification when a session needs attention while this dashboard is in the background.',
        control: 'toggle', keywords: ['browser', 'attention'], defaultValue: true, ...BROWSER_NOW,
      },
    ],
  },
  {
    id: 'machine-telegram',
    level: 'machine',
    parent: 'browser-notifications',
    title: 'Telegram',
    description: 'One bot shared by session, PR review and PostHog notifications.',
    legacyIds: ['telegram', 'notifications'],
    settings: [
      {
        id: 'telegram-bot-token', path: 'telegram.botToken', title: 'Bot token',
        description: 'Credential used by the shared Telegram bot. Create a bot by messaging @BotFather in Telegram and sending /newbot; it replies with this token. When GLIMMERVOID_TELEGRAM_BOT_TOKEN supplies it, this field is read-only.',
        control: 'password', keywords: ['credential', 'api'], defaultValue: '', ...MACHINE_NOW,
      },
      {
        id: 'telegram-chat-id', path: 'telegram.chatId', title: 'Chat id',
        description: 'Destination chat for enabled Telegram lanes. Send your bot any message, then open https://api.telegram.org/bot<token>/getUpdates in a browser and copy the number under message.chat.id.',
        control: 'text', keywords: ['destination', 'channel'], defaultValue: '', ...MACHINE_NOW,
      },
      {
        id: 'telegram-session-notifications', path: 'telegramNotifications', title: 'Send session notifications',
        description: 'Send session completion, input and failure alerts when no dashboard is open. Unacknowledged alerts also escalate after the phone escalation delay while a dashboard remains open.',
        control: 'toggle', keywords: ['phone', 'off dashboard', 'test'], defaultValue: false, status: 'telegram-delivery', ...MACHINE_NOW,
      },
    ],
  },
  {
    id: 'machine-sessions',
    level: 'machine',
    title: 'Sessions',
    description: 'How sessions start, where projects are found, and what the dashboard shows for them.',
    legacyIds: ['machine-general', 'general', 'machine-repositories', 'repos', 'repositories'],
    settings: [
      {
        id: 'auto-resume', path: 'autoResume', title: 'Auto-resume sessions on startup',
        description: 'Resume conversations that were live when Glimmervoid last shut down or crashed, and tell sessions that were mid-turn, or had a background agent, monitor or scheduled wakeup in flight, to continue.',
        control: 'toggle', keywords: ['startup', 'conversation'], defaultValue: true, ...MACHINE_NOW,
      },
      {
        id: 'conversation-view', path: 'conversationView', title: 'Conversation view (experimental)',
        description: 'Let each Claude Code and Codex session turn on a Conversation face from its card menu, which renders the transcript as messages, approvals and a composer. Sessions stay on the terminal until you turn it on for them. A Claude Code session started while this is on can answer its permission prompts and questions there. A Codex session connects on its next start, through a local app-server so approvals can be answered from the dashboard; guarded Codex sessions and those that bypass Codex hook trust keep the terminal only.',
        control: 'toggle', keywords: ['experimental', 'transcript', 'chat', 'codex', 'claude'], defaultValue: false, ...MACHINE_NOW,
      },
      {
        id: 'tab-order', path: 'viewTabOrder', title: 'Tab order',
        description: 'The order of the dashboard tabs in every browser: the header on desktop and the More menu on a phone. You can also drag a tab in the desktop header.',
        control: 'tab-order', keywords: ['tabs', 'order', 'rearrange', 'reorder', 'header', 'more', 'menu'], defaultValue: [], ...MACHINE_NOW,
      },
      {
        id: 'remote-sessions', path: 'remoteSessions', title: 'Remote Coder sessions (experimental)',
        description: 'Offer the Coder environments in config.json when adding a session, so the session runs in its own Coder workspace instead of on this machine. Off refuses new remote sessions; ones already running keep working until closed.',
        control: 'toggle', keywords: ['experimental', 'coder', 'remote', 'workspace', 'cloud'], defaultValue: false, ...MACHINE_NOW,
      },
      {
        id: 'streamer-mode', path: 'streamerMode', title: 'Streamer mode',
        description: 'Hide sensitive details in the dashboard while screen sharing or streaming.',
        control: 'toggle', keywords: ['streaming', 'screen share', 'privacy'], defaultValue: false, ...MACHINE_NOW,
      },
      {
        id: 'repository-roots', path: 'repoRoots', title: 'Repository roots',
        description: 'Directories scanned for projects when adding sessions.',
        control: 'list', keywords: ['folders', 'project discovery'], defaultValue: [],
        listPlaceholder: 'Repository root path', listEmptyText: 'No repository roots configured.', ...MACHINE_NOW,
      },
      {
        id: 'custom-agents', path: 'status:custom-agents', title: 'Custom agents',
        description: 'Extra agent CLIs a session can be spawned with, declared under customAgents in config.json.',
        control: 'readonly', keywords: ['adapters', 'cli'], status: 'custom-agents', ...READOUT,
      },
      {
        id: 'agent-logins', path: 'status:agent-logins', title: 'Agent logins',
        description: 'How Claude Code and Codex sign in inside a Coder workspace. Each uses the login already on this machine; Connect signs one in for Glimmervoid alone when there is none.',
        control: 'readonly', keywords: ['claude', 'codex', 'sign in', 'login', 'coder', 'remote'], status: 'agent-logins', ...READOUT,
      },
      {
        id: 'remote-setup', path: 'status:remote-setup', title: 'Remote host setup',
        description: 'Start a session that walks you through running Glimmervoid on another Linux machine you reach by ssh, as a service you open from your laptop and phone.',
        control: 'readonly', keywords: ['remote', 'ssh', 'server', 'devbox', 'tailscale', 'pair', 'host'], status: 'remote-setup', ...READOUT,
      },
    ],
  },
  {
    id: 'machine-guardrails',
    level: 'machine',
    title: 'Guardrails and unattended',
    description: 'What a guarded session may touch, and which unattended actions automated work may take. Claude Code sessions on Linux and macOS write anywhere this account can, except credentials, Glimmervoid\'s own state and the blocked folders here.',
    legacyIds: ['lanes-unattended', 'unattended'],
    settings: [
      {
        id: 'skip-permissions-by-default', path: 'skipPermissionsByDefault', title: 'Skip permission prompts by default',
        description: 'Start sessions whose project sets no permission choice with the agent CLI permission bypass flag.',
        control: 'toggle', keywords: ['permissions', 'yolo', 'dangerously'], danger: true,
        warning: 'Enabling this control lets agents edit files and run shell commands without asking, and restarts running sessions that inherit it.',
        defaultValue: false, ...MACHINE_NOW,
      },
      {
        id: 'sane-yolo', path: 'saneYolo', title: 'Sane YOLO',
        description: 'Block catastrophic commands in sessions that skip permission prompts when the cc-safety-net executable is available and trusted hooks are installed. Missing or untrusted hooks leave a session unprotected.',
        control: 'toggle', keywords: ['permissions', 'yolo', 'safety'], defaultValue: true, ...MACHINE_NEW_SESSIONS,
      },
      {
        id: 'rtk-compression', path: 'rtk', title: 'rtk output compression',
        description: 'Compress Bash output with the rtk executable.',
        control: 'toggle', keywords: ['bash', 'tokens'], danger: true, status: 'rtk-install',
        warning: 'Enabling this control permits Glimmervoid to install the pinned rtk executable automatically.', defaultValue: false, ...MACHINE_NEW_SESSIONS,
      },
      {
        id: 'post-turn-checks-mode', path: 'postTurnChecks.mode', title: 'Post-turn checks mode',
        description: 'Default mode for post-turn checks. Project and individual rule modes override it, so Report can still allow file fixes.',
        control: 'select', options: capitalizedOptions(POST_TURN_CHECK_MODES),
        keywords: ['quality', 'fixes'], defaultValue: 'report', ...MACHINE_NOW,
      },
      {
        id: 'branch-gc-delete-unmerged', path: 'branchGc.deleteUnmerged', title: 'Delete unmerged branches',
        description: 'Also delete stale remote branches with no merge proof. Off keeps every unmerged branch.',
        control: 'toggle', keywords: ['git', 'cleanup', 'orphan'], danger: true,
        warning: 'Enabling this control lets branch cleanup delete stale remote branches without merge proof.',
        defaultValue: false, ...MACHINE_NOW,
      },
      {
        id: 'guardrails-unguarded-repos', path: 'guardrails.unguardedRepos', title: 'Unguarded repositories',
        description: 'Folders whose sessions run without guardrails. A session started in one of these folders, or below it, is not guarded.',
        control: 'list', keywords: ['guardrails', 'opt out', 'dotfiles'], danger: true,
        warning: 'A session without guardrails can read credentials and write anywhere this account can.',
        defaultValue: [], listPlaceholder: 'Folder path', listEmptyText: 'Every repository is guarded.', ...MACHINE_NEW_SESSIONS,
      },
      {
        id: 'guardrails-blocked-paths', path: 'guardrails.blockedPaths', title: 'Blocked folders',
        description: 'Extra folders and files a guarded session cannot write, on top of credentials and Glimmervoid\'s own state. A leading ~ means the home folder.',
        control: 'list', keywords: ['guardrails', 'block', 'protect'], defaultValue: [],
        listPlaceholder: '~/folder', listEmptyText: 'Only the built-in list is blocked.', ...MACHINE_NEW_SESSIONS,
      },
      {
        id: 'guardrails-unreadable-paths', path: 'guardrails.unreadablePaths', title: 'Unreadable folders',
        description: 'Extra folders and files a guarded session cannot read, on top of the built-in credential list. A leading ~ means the home folder.',
        control: 'list', keywords: ['guardrails', 'secrets', 'credentials'], defaultValue: [],
        listPlaceholder: '~/folder', listEmptyText: 'Only the built-in credential list is unreadable.', ...MACHINE_NEW_SESSIONS,
      },
    ],
  },
  {
    id: 'machine-updates',
    level: 'machine',
    title: 'Updates',
    description: 'See which Glimmervoid version is running, which one is newest, and update in one step.',
    legacyIds: ['updates'],
    settings: [
      {
        id: 'update-actions', path: 'status:update-actions', title: 'Status and actions',
        legacyIds: ['update-summary', 'update-installed', 'update-latest', 'update-last-checked'].map((settingId) => ({ sectionId: 'machine-updates', settingId })),
        description: 'Whether this install is up to date, the running and newest versions, the last check, and the update and restart actions.',
        control: 'readonly', keywords: ['version', 'available', 'current', 'check', 'restart', 'commit', 'installed', 'release', 'failure'],
        status: 'update-actions', ...READOUT,
      },
      {
        id: 'update-channel', path: 'updateChannel', title: 'Channel',
        description: 'Track stable releases, or Experimental builds published from every change to main before it reaches a release.',
        control: 'select', options: capitalizedOptions(UPDATE_CHANNELS),
        keywords: ['release', 'prerelease', 'next', 'beta', 'early'], defaultValue: 'release', ...MACHINE_NOW,
      },
      {
        id: 'check-updates', path: 'checkForUpdates', title: 'Check for updates automatically',
        description: 'Check for a newer Glimmervoid at launch, while a dashboard is connected, and when this page opens.',
        control: 'toggle', keywords: ['release', 'github'], defaultValue: true, ...MACHINE_NOW,
      },
    ],
  },
  {
    id: 'machine-usage',
    level: 'machine',
    title: 'Usage',
    description: 'Local transcript accounting and estimated-cost budgets.',
    legacyIds: ['usage'],
    settings: [
      {
        id: 'usage-enabled', path: 'usage.enabled', title: 'Track token usage',
        description: 'Read local CLI transcripts and roll them into the Usage view and session chips.',
        control: 'toggle', keywords: ['tokens', 'cost'], defaultValue: true, status: 'usage-last-report', ...MACHINE_NOW,
      },
      {
        id: 'usage-retain-days', path: 'usage.retainDays', title: 'Retain transcript detail',
        description: 'How long live transcript detail stays available. A monthly budget keeps detail from the start of the current month when that is longer.',
        control: 'number', range: USAGE_RETAIN_DAYS_RANGE, unit: DAYS, keywords: ['history', 'retention'], defaultValue: 90, ...MACHINE_NOW,
      },
      {
        id: 'usage-daily-budget', path: 'usage.budget.dailyUsd', title: 'Daily budget',
        description: 'Estimated daily spend alert threshold. Alerts at 50%, 75% and 100% do not stop spending. Zero or below disables the threshold.',
        control: 'number', range: USAGE_BUDGET_RANGE, unit: USD, keywords: ['spend', 'alert'], defaultValue: null,
        integer: false, nullable: true, zeroIsNull: true, step: 0.01, ...MACHINE_NOW,
      },
      {
        id: 'usage-monthly-budget', path: 'usage.budget.monthlyUsd', title: 'Monthly budget',
        description: 'Estimated monthly spend alert threshold. Alerts at 50%, 75% and 100% do not stop spending. Zero or below disables the threshold.',
        control: 'number', range: USAGE_BUDGET_RANGE, unit: USD, keywords: ['spend', 'alert'], defaultValue: null,
        integer: false, nullable: true, zeroIsNull: true, step: 0.01, ...MACHINE_NOW,
      },
    ],
  },
  {
    id: 'lanes-visions',
    level: 'lanes',
    title: 'Visions',
    description: 'Editor-buffer findings, bounded model comments, and the machine-context ingest behind them.',
    legacyIds: ['lanes', 'visions', 'lanes-ingest', 'ingest'],
    settings: [
      {
        id: 'visions-enabled', path: 'visions.enabled', title: 'Enable Visions',
        description: 'Set up supported editors detected on this machine, then show their buffer findings in the Visions view.',
        control: 'toggle', keywords: ['editor', 'findings', 'lsp'], defaultValue: false, ...MACHINE_NOW,
      },
      {
        id: 'visions-dispatch-enabled', path: 'visions.dispatch.enabled', title: 'Enable model comments',
        description: 'Start bounded review sessions for local editor buffers.',
        control: 'toggle', keywords: ['review', 'dispatch'], defaultValue: false, ...MACHINE_NOW,
      },
      {
        id: 'visions-max-per-hour', path: 'visions.dispatch.maxPerHour', title: 'Max per hour',
        description: 'Maximum review sessions dispatched per hour. One slot is reserved for edit reviews; activity-driven reviews take the rest, up to the activity cap set by visions.dispatch.activityMaxPerHour.',
        control: 'number', range: POSITIVE_NUMBER_RANGE, unit: REVIEWS_PER_HOUR, keywords: ['rate limit', 'reviews'], defaultValue: 6, ...MACHINE_NOW,
      },
      {
        id: 'visions-model', path: 'visions.dispatch.model', title: 'Model override',
        description: 'Leave blank to use the opus model alias.',
        control: 'text', keywords: ['claude', 'override'], defaultValue: '', ...MACHINE_NOW,
      },
      {
        id: 'visions-projects', path: 'visions.projects', title: 'Projects',
        description: 'Clear every selection, including unavailable projects, to accept buffers from every configured project.',
        control: 'projects', keywords: ['repositories', 'filter'], defaultValue: [], ...MACHINE_NOW,
      },
      {
        id: 'visions-auto-fix', path: 'visions.autoFix', title: 'Apply tier 1 fixes',
        description: 'Allow Visions to edit eligible open Markdown buffers, including inactive buffers, without asking.',
        control: 'toggle', keywords: ['automatic', 'edits'], danger: true,
        warning: 'Enabling this control lets Visions edit eligible buffers without a carbon unit present.', defaultValue: false, ...MACHINE_NOW,
      },
      {
        id: 'ingest-enabled', path: 'ingest.enabled', title: 'Enable machine context ingest',
        description: 'Enable the local activity feed behind Visions. Turning Visions on enables ingest unless ingest.enabled is explicitly false.',
        control: 'toggle', keywords: ['events', 'activity', 'ingest'], defaultValue: false, ...MACHINE_NOW,
      },
    ],
  },
  {
    id: 'lanes-posthog',
    level: 'lanes',
    title: 'PostHog',
    description: 'Error monitoring, investigations and traffic-spike alerts.',
    legacyIds: ['posthog'],
    settings: [
      {
        id: 'posthog-enabled', path: 'posthog.enabled', title: 'Enable PostHog monitoring',
        description: 'Poll PostHog error tracking and investigate issues that move.',
        control: 'toggle', keywords: ['errors', 'monitoring'], defaultValue: false, ...MACHINE_NOW,
      },
      {
        id: 'posthog-host', path: 'posthog.host', title: 'Host',
        description: 'PostHog cloud or self-hosted HTTP URL.',
        control: 'text', keywords: ['url', 'server'], defaultValue: 'https://us.posthog.com', ...MACHINE_NOW,
      },
      {
        id: 'posthog-api-key', path: 'posthog.apiKey', title: 'Personal API key',
        description: 'Credential with read access to PostHog projects. When GLIMMERVOID_POSTHOG_API_KEY supplies it, this field is read-only.',
        control: 'password', keywords: ['credential', 'token'], defaultValue: '', ...MACHINE_NOW,
      },
      {
        id: 'posthog-projects', path: 'posthog.projects', title: 'Projects',
        description: 'PostHog project ids to monitor. config.json holds "all" or an array of ids, and an empty array monitors no project. In Settings that empty array shows as none, and an empty list saves "all".',
        control: 'list', keywords: ['project ids', 'filter'], defaultValue: 'all', valueKind: 'posthog-projects',
        listPlaceholder: 'Project id', listEmptyText: 'Every project the key can read.', ...MACHINE_NOW,
      },
      {
        id: 'posthog-interval', path: 'posthog.intervalMinutes', title: 'Poll interval',
        description: 'Delay between PostHog polling passes.',
        control: 'number', integer: false, step: 'any', range: POSITIVE_NUMBER_RANGE, unit: MINUTES, keywords: ['refresh', 'schedule'], defaultValue: 15, ...MACHINE_NOW,
      },
      {
        id: 'posthog-max-investigations', path: 'posthog.maxConcurrentInvestigations', title: 'Max concurrent investigations',
        description: 'Maximum investigation sessions running together.',
        control: 'number', range: POSITIVE_NUMBER_RANGE, unit: INVESTIGATIONS, keywords: ['parallel', 'workers'], defaultValue: 2, ...MACHINE_NOW,
      },
      {
        id: 'posthog-min-users', path: 'posthog.minUsersToInvestigate', title: 'Min users to investigate',
        description: 'Minimum affected users for a new issue investigation. Regressions, worsening issues and eligible error spikes bypass this minimum.',
        control: 'number', range: POSITIVE_NUMBER_RANGE, unit: USERS, keywords: ['threshold', 'affected'], defaultValue: 1, ...MACHINE_NOW,
      },
      {
        id: 'posthog-traffic-enabled', path: 'posthog.trafficSpikeEnabled', title: 'Traffic spike alerts',
        description: 'Ping when recent unique users exceed a project baseline.',
        control: 'toggle', keywords: ['analytics', 'alert'], defaultValue: true, ...MACHINE_NOW,
      },
      {
        id: 'posthog-auto-fix', path: 'posthog.autoFix', title: 'Attempt fixes for major issues',
        description: 'Allow an isolated agent to fix an issue, push a branch and open a pull request.',
        control: 'toggle', keywords: ['automatic', 'pull request'], danger: true,
        warning: 'Enabling this control lets PostHog fixes commit, push and open pull requests automatically.', defaultValue: false, ...MACHINE_NOW,
      },
    ],
  },
  {
    id: 'lanes-team-review',
    level: 'lanes',
    title: 'Team review',
    description: "Draft reviews of teammates' pull requests for you to post from the Reviews tab.",
    legacyIds: ['team-review', 'reviews'],
    settings: [
      {
        id: 'team-review-enabled', path: 'teamReview.enabled', title: 'Enable team review',
        description: 'Poll open pull requests from the team and draft a review of each one. Nothing is posted until you choose Approve or Comment.',
        control: 'toggle', keywords: ['pull requests', 'github'], defaultValue: true, ...MACHINE_NOW,
      },
      {
        id: 'github-teams', path: 'github.teams', title: 'GitHub teams',
        description: 'Teams to search for review requests and members, one org/slug per entry. Leave empty to fall back to the legacy teamReview.org and teamReview.team keys in config.json.',
        control: 'list', keywords: ['github', 'teams', 'review requests'], defaultValue: [],
        listPlaceholder: 'org/team-slug', listEmptyText: 'No GitHub teams configured.', ...MACHINE_NOW,
      },
      {
        id: 'team-review-re-review-after-hours', path: 'teamReview.reReviewAfterHours', title: 'Re-review after',
        description: 'When a reviewed PR has a new head, review it again after this long since its last review. Re-run review runs it at any time.',
        control: 'number', range: POSITIVE_NUMBER_RANGE, unit: HOURS, keywords: ['review', 'delay'], defaultValue: 24, integer: false, step: 0.5, ...MACHINE_NOW,
      },
      {
        id: 'team-review-skip-idle-after-days', path: 'teamReview.skipIdleAfterDays', title: 'Skip PRs idle for',
        description: 'Leave pull requests without GitHub activity for this long out of automatic review.',
        control: 'number', range: POSITIVE_NUMBER_RANGE, unit: DAYS, keywords: ['idle', 'activity'], defaultValue: 14, integer: false, step: 0.5, ...MACHINE_NOW,
      },
      {
        id: 'team-review-skill', path: 'teamReview.skill', title: 'Review skill',
        description: 'Name of a Claude Code skill installed for the review agent, for example your own PR review skill. Leave empty to let the agent review with whatever skills it has.',
        control: 'text', keywords: ['skill', 'claude code', 'pr review'], defaultValue: '', ...MACHINE_NOW,
      },
      {
        id: 'team-review-auto-rebase-my-prs', path: 'teamReview.autoRebaseMyPrs', title: 'Keep my pull requests rebased',
        description: 'On each poll, rebase your open, non-draft pull requests that are behind their base branch. A pull request with conflicts or checks still running is left alone, and a failed rebase is not retried until you push again.',
        control: 'toggle', keywords: ['rebase', 'update branch', 'behind', 'my prs'], danger: true,
        warning: 'Enabling this control rewrites your pull request branches on GitHub. Pull before you push from a local checkout of one.', defaultValue: false, ...MACHINE_NOW,
      },
      {
        id: 'team-review-keep-mergeable-enabled', path: 'teamReview.keepMergeableEnabled', title: 'Keep mergeable',
        description: 'Offer Keep mergeable on your pull requests: a guarded agent repairs conflicts and failing checks and pushes the repair. Off hides the control and starts no repair; the pull requests you chose stay chosen for when you turn it back on.',
        control: 'toggle', keywords: ['repair', 'conflicts', 'my prs'], defaultValue: true, ...MACHINE_NOW,
      },
      {
        id: 'team-review-keep-mergeable-timeout', path: 'teamReview.keepMergeableTimeoutMinutes', title: 'Keep mergeable deadline',
        description: 'Longest a Keep mergeable repair session may run before it is stopped and nothing is pushed.',
        control: 'number', range: KEEP_MERGEABLE_TIMEOUT_MINUTES_RANGE, unit: MINUTES, keywords: ['timeout', 'repair'], defaultValue: 30, ...MACHINE_NOW,
      },
      {
        id: 'team-review-merge-queue-enabled', path: 'teamReview.mergeQueueEnabled', title: 'Merge when ready',
        description: 'Offer Merge when ready on your pull requests: queued pull requests are rebased when behind and merged once ready, one per repository per poll. Off hides the control and merges nothing; the queue is kept for when you turn it back on.',
        control: 'toggle', keywords: ['merge queue', 'auto merge', 'my prs'], defaultValue: true, ...MACHINE_NOW,
      },
    ],
  },
  {
    id: 'lanes-workflows',
    level: 'lanes',
    title: 'Workflows',
    description: 'Rules that act on pull request events in the repositories you choose.',
    legacyIds: ['workflows'],
    settings: [
      {
        id: 'workflows-enabled', path: 'workflows.enabled', title: 'Run workflows',
        description: 'Poll the repositories your enabled rules watch and run their actions. Off stops polling and every action, whatever each rule says.',
        control: 'toggle', keywords: ['pull requests', 'automation', 'master switch'], defaultValue: true, ...MACHINE_NOW,
      },
      {
        id: 'workflows-max-concurrent-sessions', path: 'workflows.maxConcurrentSessions', title: 'Concurrent agent sessions',
        description: 'Most workflow agent sessions running at once. Up to twenty later spawns wait for a free slot; additional spawns are dropped and logged.',
        control: 'number', range: WORKFLOWS_MAX_CONCURRENT_SESSIONS_RANGE, unit: SESSIONS, keywords: ['parallel', 'spawn'], defaultValue: 2, ...MACHINE_NOW,
      },
      {
        id: 'workflows-rules', path: 'status:workflow-rules', title: 'Workflow rules',
        description: 'Each rule watches repositories for one pull request event (opened, checks-failed, review-requested, approved, commented or merged), narrows it by author, labels, base branch, your own pull requests or a review request to your team, and then notifies you, labels or comments on the pull request, or starts a guarded agent session that pushes nothing. Rules start disabled. Turn each rule on or off here; everything else about a rule is set in config.json under workflows.rules.',
        control: 'readonly', keywords: ['pull requests', 'automation', 'github', 'rules'], status: 'workflows', ...READOUT,
      },
    ],
  },
  {
    id: 'lanes-benchmarks',
    level: 'lanes',
    title: 'Benchmarks',
    description: 'Compare agent setups on frozen cases from the suites in the benchmarks folder of the Glimmervoid home.',
    legacyIds: ['benchmarks'],
    settings: [
      {
        id: 'benchmarks-enabled', path: 'benchmarks.enabled', title: 'Enable benchmarks',
        description: 'Show the Bench tab. Nothing runs until you choose Mine or Run there.',
        control: 'toggle', keywords: ['eval', 'arms', 'recall', 'compare'], defaultValue: false, ...MACHINE_NOW,
      },
    ],
  },
  {
    id: 'lanes-coherence',
    level: 'lanes',
    title: 'Coherence (experimental)',
    description: 'Per-session Coherence hook status and decision journal for agent sessions.',
    settings: [
      {
        id: 'coherence-enabled', path: 'coherence.enabled', title: 'Show session Coherence',
        description: "Shows each session's Coherence hook status and decision journal when the repository installed @posthog/coherence 1.8 or newer. Off by default.",
        control: 'toggle', keywords: ['experimental', 'coherence', 'journal', 'decisions'], defaultValue: false, ...MACHINE_NOW,
      },
    ],
  },
  {
    id: 'lanes-issues',
    level: 'lanes',
    title: 'Issues (experimental)',
    description: 'GitHub issues from your projects and teams in their own dashboard tab.',
    settings: [
      {
        id: 'issues-enabled', path: 'issues.enabled', title: 'Show the Issues tab',
        description: 'Poll GitHub issues for your projects and teams and list them in an Issues tab. Off stops the polling and hides the tab.',
        control: 'toggle', keywords: ['experimental', 'issues', 'github', 'tab'], defaultValue: false, ...MACHINE_NOW,
      },
    ],
  },
  {
    id: 'machine-privacy',
    level: 'machine',
    title: 'Privacy',
    description: 'What Glimmervoid sends about itself.',
    legacyIds: ['privacy', 'telemetry'],
    settings: [
      {
        id: 'telemetry-enabled', path: 'telemetry.enabled', title: 'Send usage data',
        description: 'Helps us improve Glimmervoid. Sent under a random install id: version, platform, app starts, daily activity, session starts and ends with agent kind, exit kind and duration, errors as their type, error code and scrubbed stack frames, per session token counts, models and estimated costs from the usage scan, and a salted one-way hash of your Claude and Codex account ids so installs of one account count together. Never prompts, project information, error messages, paths, repository or branch names, objectives, terminal output, emails or names. Delete my data asks for everything sent under this install to be erased and starts a new install id. GLIMMERVOID_TELEMETRY=0, DO_NOT_TRACK=1 or CI=true turn it off regardless.',
        control: 'toggle', keywords: ['telemetry', 'analytics', 'tracking', 'opt out'], defaultValue: true, ...MACHINE_NOW,
      },
    ],
  },
  {
    id: 'browser-shortcuts',
    level: 'browser',
    title: 'Shortcuts',
    description: 'Keyboard shortcuts and their reference.',
    legacyIds: ['shortcuts'],
    settings: [
      {
        id: 'next-attention-key', path: 'pref:nextAttentionKeyCode', title: 'Jump to the next session needing you',
        description: 'The key held with Cmd on a Mac, or Alt elsewhere, that jumps to the next session needing you. Record a new one by pressing the whole shortcut.',
        control: 'shortcut-key', keywords: ['shortcut', 'keyboard', 'hotkey', 'jump', 'next', 'attention'], defaultValue: 'KeyJ', ...BROWSER_NOW,
      },
    ],
  },
]);

const FILE_ONLY_SETTINGS: readonly SettingsSetting[] = Object.freeze([
  {
    id: 'file-debug-mode', path: 'debugMode', title: 'Debug mode', group: 'machine-sessions',
    description: 'Show session-card diagnostics for state, transitions and detection signals.',
    control: 'toggle', keywords: ['diagnostics', 'state'], defaultValue: false, takesEffect: 'now', fileOnlyReason: DIAGNOSTIC, ...FILE_ONLY,
  },
  {
    id: 'file-replay-buffer', path: 'replayBufferKB', title: 'Replay buffer', group: 'machine-terminal',
    description: 'PTY output retained for clients that reconnect or join late.',
    control: 'number', range: REPLAY_BUFFER_KB_RANGE, unit: { label: 'KB', storedPerDisplay: 1 }, keywords: ['history', 'backfill'], defaultValue: 512,
    takesEffect: 'new-sessions', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-session-memory-reserve', path: 'sessionMemoryReserveMB', title: 'Session memory reserve', group: 'machine-sessions',
    description: 'Free memory an automatic session start waits for; 0 starts sessions without checking.',
    control: 'number', range: MEMORY_RESERVE_MB_RANGE, unit: { label: 'MB', storedPerDisplay: 1 }, keywords: ['memory', 'headroom'], defaultValue: 600,
    takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-cursor-blink', path: 'cursorBlink', title: 'Cursor blink', group: 'machine-terminal',
    description: 'Blink the cursor in every terminal.',
    control: 'toggle', keywords: ['caret', 'terminal'], defaultValue: false, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-detect-background-agents', path: 'detectBackgroundAgents', title: 'Detect background agents', group: 'machine-detection-sessions',
    description: 'Hold completion while tracked background work is active.',
    control: 'toggle', keywords: ['subagents', 'completion'], defaultValue: true, takesEffect: 'new-sessions', fileOnlyReason: DIAGNOSTIC, ...FILE_ONLY,
  },
  {
    id: 'file-record-signals', path: 'recordSignals', title: 'Record structural signals', group: 'machine-detection-sessions',
    description: 'Keep forensic status and hook recordings for each session. Full capture (capture.enabled) records these signals even when this is off.',
    control: 'toggle', keywords: ['recordings', 'diagnostics'], defaultValue: true, takesEffect: 'new-sessions', fileOnlyReason: DIAGNOSTIC, ...FILE_ONLY,
  },
  {
    id: 'file-trace-enabled', path: 'trace.enabled', title: 'Capture session traces', group: 'machine-detection-sessions',
    description: 'Keep normalized Claude transcript traces for session debugging.',
    control: 'toggle', keywords: ['transcripts', 'diagnostics'], defaultValue: true, takesEffect: 'restart', fileOnlyReason: DIAGNOSTIC, ...FILE_ONLY,
  },
  {
    id: 'file-detect-scheduled-wakeups', path: 'detectScheduledWakeups', title: 'Detect scheduled wakeups', group: 'machine-detection-sessions',
    description: 'Surface advisory wakeup timing for scheduled sessions.',
    control: 'toggle', keywords: ['schedule', 'sleep'], defaultValue: true, takesEffect: 'restart', fileOnlyReason: DIAGNOSTIC, ...FILE_ONLY,
  },
  {
    id: 'file-worktree-auto-rebase', path: 'worktreeAutoRebase', title: 'Worktree auto-rebase', group: 'machine-detection-sessions',
    description: 'Rebase eligible session worktrees when the integration branch moves.',
    control: 'toggle', keywords: ['git', 'branch'], defaultValue: true, takesEffect: 'new-sessions', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-worktree-sync-on-start', path: 'worktreeSyncOnStart', title: 'Worktree sync on start', group: 'machine-detection-sessions',
    description: 'Fetch origin and fast-forward the local integration branch before a session starts its worktree.',
    control: 'toggle', keywords: ['git', 'fetch', 'fast-forward'], defaultValue: true, takesEffect: 'new-sessions', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-worktree-rerere', path: 'worktreeRerere', title: 'Worktree rerere', group: 'machine-detection-sessions',
    description: 'Reuse recorded Git conflict resolutions.',
    control: 'toggle', keywords: ['git', 'conflicts'], defaultValue: true, takesEffect: 'restart', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-integration-branch', path: 'integrationBranch', title: 'Integration branch', group: 'machine-detection-sessions',
    description: "Base branch for session worktrees. Empty = each repo's default branch. Existing sessions are never retargeted.",
    control: 'text', nullable: true, keywords: ['git', 'merge'], defaultValue: null, takesEffect: 'new-sessions', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-worktree-root', path: 'worktreeRoot', title: 'Worktree root', group: 'machine-detection-sessions',
    description: 'Directory that contains session worktrees. Existing worktrees are never relocated.',
    control: 'text', keywords: ['git', 'directory'], defaultValue: '', takesEffect: 'new-sessions', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-worktree-share', path: 'worktreeShare', title: 'Shared worktree paths', group: 'machine-detection-sessions',
    description: 'Local paths copied or linked during worktree preparation.',
    control: 'list', keywords: ['files', 'context'], defaultValue: ['node_modules', '.env', '.env.local', '.claude'], takesEffect: 'new-sessions', fileOnlyReason: BY_RULE, ...FILE_ONLY,
  },
  {
    id: 'file-port', path: 'port', title: 'Local port', group: 'machine-detection-sessions',
    description: 'Port used by the local dashboard listener.',
    control: 'number', range: PORT_RANGE, unit: { label: 'port', storedPerDisplay: 1 }, keywords: ['server', 'listener'], defaultValue: 3000, takesEffect: 'restart', fileOnlyReason: BY_RULE, ...FILE_ONLY,
  },
  {
    id: 'file-notify-debounce-ms', path: 'notifyDebounceMs', title: 'Notification debounce', group: 'machine-detection-sessions',
    description: 'Delay used to coalesce notification state changes.',
    control: 'number', integer: false, step: 'any', range: POSITIVE_NUMBER_RANGE, unit: SECONDS_STORED_AS_MS, keywords: ['timer', 'alerts'], defaultValue: 3000, takesEffect: 'new-sessions', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-phone-escalation-ms', path: 'phoneEscalationMs', title: 'Phone escalation delay', group: 'machine-detection-sessions',
    description: 'Delay before off-dashboard escalation.',
    control: 'number', integer: false, step: 'any', range: POSITIVE_NUMBER_RANGE, unit: MINUTES_STORED_AS_MS, keywords: ['timer', 'telegram'], defaultValue: 300000, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-post-turn-checks', path: 'postTurnChecks', title: 'Post-turn checks', group: 'machine-detection-sessions',
    description: 'Deterministic checks run after eligible turns. The global mode is a default; project and individual rule modes can select fixes even when the global mode is report.',
    control: 'json', keywords: ['quality', 'fixes'], defaultValue: { enabled: true, mode: 'report', rules: { trailingWs: true, finalNewline: true, bom: true, slop: false } },
    takesEffect: 'now', fileOnlyReason: STRUCTURED_VALUE, ...FILE_ONLY,
  },
  {
    id: 'file-branch-gc-enabled', path: 'branchGc.enabled', title: 'Branch cleanup', group: 'machine-detection-sessions',
    description: 'Enable cleanup of eligible session branches.',
    control: 'toggle', keywords: ['git', 'cleanup'], defaultValue: true, takesEffect: 'now', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-branch-gc-worktrees', path: 'branchGc.worktrees', title: 'Local worktree cleanup', group: 'machine-detection-sessions',
    description: 'Enable cleanup of eligible local worktrees.',
    control: 'toggle', keywords: ['git', 'worktree', 'cleanup'], defaultValue: true, takesEffect: 'now', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-branch-gc-prefixes', path: 'branchGc.prefixes', title: 'Branch cleanup prefixes', group: 'machine-detection-sessions',
    description: 'Branch prefixes that filter both remote branch cleanup and local worktree cleanup.',
    control: 'list', keywords: ['git', 'branch'], defaultValue: ['glimmervoid/session/', 'worktree-agent-'], takesEffect: 'now', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-branch-gc-dry-run', path: 'branchGc.dryRun', title: 'Branch cleanup dry run', group: 'machine-detection-sessions',
    description: 'Report planned cleanup without deleting remote branches.',
    control: 'toggle', keywords: ['git', 'safety'], defaultValue: false, takesEffect: 'now', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-branch-gc-stale-days', path: 'branchGc.staleDays', title: 'Branch stale days', group: 'machine-detection-sessions',
    description: 'Age threshold for orphan branch cleanup when unmerged deletion is on.',
    control: 'number', integer: false, step: 'any', range: POSITIVE_NUMBER_RANGE, unit: DAYS, keywords: ['git', 'retention'], defaultValue: 14, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-branch-gc-interval-ms', path: 'branchGc.intervalMs', title: 'Branch cleanup interval', group: 'machine-detection-sessions',
    description: 'Delay between branch cleanup passes.',
    control: 'number', integer: false, step: 'any', range: POSITIVE_NUMBER_RANGE, unit: HOURS_STORED_AS_MS, keywords: ['git', 'schedule'], defaultValue: 21600000, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-custom-agents', path: 'customAgents', title: 'Custom agents', group: 'machine-detection-sessions',
    description: 'Extra agent CLIs a session can be spawned with. The Sessions section lists the declared agents and whether each command resolves.',
    control: 'json', keywords: ['adapters', 'cli'], defaultValue: [], takesEffect: 'new-sessions', fileOnlyReason: BY_RULE, ...FILE_ONLY,
  },
  {
    id: 'file-task-title-refiner-enabled', path: 'taskTitle.refiner.enabled', title: 'Refine task titles', group: 'machine-detection-sessions',
    description: 'Keep session card titles useful when prompts change topic by asking a model for a short title.',
    control: 'toggle', keywords: ['title', 'refiner', 'card'], defaultValue: true, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-task-title-refiner-model', path: 'taskTitle.refiner.model', title: 'Task title model', group: 'machine-detection-sessions',
    description: 'Claude model alias the title refiner asks.',
    control: 'text', keywords: ['title', 'refiner', 'model'], defaultValue: 'haiku', takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-task-title-refiner-min-interval', path: 'taskTitle.refiner.minIntervalSeconds', title: 'Task title refresh interval', group: 'machine-detection-sessions',
    description: 'Shortest pause between two title refinements of one session.',
    control: 'number', integer: false, step: 'any', range: NON_NEGATIVE_NUMBER_RANGE, unit: SECONDS, keywords: ['title', 'refiner', 'interval'], defaultValue: 60, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-task-title-refiner-timeout', path: 'taskTitle.refiner.timeoutSeconds', title: 'Task title timeout', group: 'machine-detection-sessions',
    description: 'Maximum time allowed for one title refinement.',
    control: 'number', integer: false, step: 'any', range: TASK_TITLE_TIMEOUT_RANGE, unit: SECONDS, keywords: ['title', 'refiner', 'deadline'], defaultValue: 60, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-usage-codex', path: 'usage.vendors.codex', title: 'Track Codex usage', group: 'machine-usage',
    description: 'Include local Codex CLI transcripts in usage reports.',
    control: 'toggle', keywords: ['openai', 'vendor'], defaultValue: true, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-usage-grok', path: 'usage.vendors.grok', title: 'Track Grok usage', group: 'machine-usage',
    description: 'Include local Grok CLI transcripts in usage reports.',
    control: 'toggle', keywords: ['xai', 'vendor'], defaultValue: true, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-usage-fetch-pricing', path: 'usage.fetchPricing', title: 'Fetch current model prices', group: 'machine-usage',
    description: 'Load public model prices when usage tracking starts, using a cached table for up to one day. Falls back to cached or bundled prices if the fetch fails; no daily refresh runs while tracking continues.',
    control: 'toggle', keywords: ['rates', 'models'], defaultValue: true, takesEffect: 'restart', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-usage-plan-limits', path: 'usage.planLimits', title: 'Show plan limits', group: 'machine-usage',
    description: 'Read the Claude plan limit the CLI reports and show it beside usage.',
    control: 'toggle', keywords: ['plan', 'limits', 'quota'], defaultValue: true, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-usage-rtk-savings', path: 'usage.rtkSavings', title: 'Estimate rtk savings', group: 'machine-usage',
    description: 'Estimate the tokens rtk output compression saved and show it in the Usage view.',
    control: 'toggle', keywords: ['rtk', 'savings', 'tokens'], defaultValue: true, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-usage-scan-interval', path: 'usage.scanIntervalMinutes', title: 'Scan interval', group: 'machine-usage',
    description: 'Periodic transcript polling interval. Session activity can also trigger scans between timer ticks.',
    control: 'number', range: USAGE_SCAN_INTERVAL_RANGE, unit: MINUTES, keywords: ['poll', 'refresh'], defaultValue: 5, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-usage-warehouse-retain-days', path: 'usage.warehouseRetainDays', title: 'Retain usage history', group: 'machine-usage',
    description: 'How long the daily usage warehouse keeps rolled-up totals after transcript detail expires.',
    control: 'number', range: USAGE_INTEGER_RANGES.warehouseRetainDays, unit: DAYS, keywords: ['history', 'warehouse', 'retention'], defaultValue: 365, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-usage-session-block-hours', path: 'usage.sessionBlockHours', title: 'Session block length', group: 'machine-usage',
    description: 'Length of the rolling block the Usage view groups activity into.',
    control: 'number', range: USAGE_INTEGER_RANGES.sessionBlockHours, unit: HOURS, keywords: ['block', 'window', 'hours'], defaultValue: 5, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-usage-cost-mode', path: 'usage.costMode', title: 'Cost mode', group: 'machine-usage',
    description: 'Choose whether recorded costs, calculated costs or both can appear.',
    control: 'select', options: capitalizedOptions(USAGE_COST_MODES), keywords: ['pricing', 'estimate'], defaultValue: 'auto', takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-usage-extra-projects-dirs', path: 'usage.extraProjectsDirs', title: 'Extra transcript folders', group: 'machine-usage',
    description: 'Absolute paths of additional Claude projects folders the usage scan reads.',
    control: 'list', keywords: ['transcripts', 'folders', 'scan'], defaultValue: [], takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-visions-quiet-delay', path: 'visions.dispatch.quietMs', title: 'Quiet delay', group: 'lanes-visions',
    description: 'Editor quiet time before a scheduled review. Saves and blank-line boundaries can dispatch immediately, subject to the other review limits.',
    control: 'number', range: POSITIVE_NUMBER_RANGE, unit: SECONDS_STORED_AS_MS, keywords: ['debounce', 'idle'], defaultValue: 30000, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-visions-cooldown', path: 'visions.dispatch.cooldownMs', title: 'Cooldown', group: 'lanes-visions',
    description: 'Minimum delay between reviews of the same document. Initial orientation reviews bypass this delay.',
    control: 'number', range: POSITIVE_NUMBER_RANGE, unit: MINUTES_STORED_AS_MS, keywords: ['rate limit', 'delay'], defaultValue: 300000, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-visions-activity-max-per-hour', path: 'visions.dispatch.activityMaxPerHour', title: 'Activity max per hour', group: 'lanes-visions',
    description: 'Maximum activity-driven reviews dispatched per hour, capped at the overall hourly limit minus one to reserve an edit-review slot.',
    control: 'number', range: NON_NEGATIVE_NUMBER_RANGE, unit: REVIEWS_PER_HOUR, keywords: ['rate limit', 'events'], defaultValue: 2, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-visions-dispatch-timeout', path: 'visions.dispatch.dispatchTimeoutSeconds', title: 'Dispatch timeout', group: 'lanes-visions',
    description: 'Maximum time allowed for one review session.',
    control: 'number', range: POSITIVE_NUMBER_RANGE, unit: MINUTES_STORED_AS_SECONDS, keywords: ['deadline', 'review'], defaultValue: 180, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-visions-intent-thread-ttl', path: 'visions.intent.threadTtlMs', title: 'Intent thread lifetime', group: 'lanes-visions',
    description: 'How long an intent thread nobody advanced stays live before it retires.',
    control: 'number', range: POSITIVE_NUMBER_RANGE, unit: DAYS_STORED_AS_MS, keywords: ['intent', 'decay', 'thread'], defaultValue: 259200000, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-ingest-terminal', path: 'ingest.sources.terminal.enabled', title: 'Terminal output source', group: 'lanes-ingest',
    description: 'Include terminal output in the ingest feed.',
    control: 'toggle', keywords: ['pty', 'source'], defaultValue: false, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-ingest-agent-logs', path: 'ingest.sources.agentLogs.enabled', title: 'Agent logs source', group: 'lanes-ingest',
    description: 'Include local agent logs in the ingest feed.',
    control: 'toggle', keywords: ['transcript', 'source'], defaultValue: false, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-ingest-git', path: 'ingest.sources.git.enabled', title: 'Git activity source', group: 'lanes-ingest',
    description: 'Include local Git activity in the ingest feed.',
    control: 'toggle', keywords: ['commits', 'source'], defaultValue: false, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-ingest-fs', path: 'ingest.sources.fs.enabled', title: 'File changes source', group: 'lanes-ingest',
    description: 'Include watched file changes in the ingest feed.',
    control: 'toggle', keywords: ['filesystem', 'source'], defaultValue: false, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-ingest-shell-history', path: 'ingest.sources.shellHistory.enabled', title: 'Shell history source', group: 'lanes-ingest',
    description: 'Include local shell history in the ingest feed.',
    control: 'toggle', keywords: ['commands', 'source'], defaultValue: false, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-ingest-editor', path: 'ingest.sources.editor.enabled', title: 'Editor events source', group: 'lanes-ingest',
    description: 'Include local editor events in the ingest feed.',
    control: 'toggle', keywords: ['buffers', 'source'], defaultValue: false, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-posthog-investigation-timeout', path: 'posthog.investigationTimeoutSeconds', title: 'Investigation timeout', group: 'lanes-posthog',
    description: 'Maximum time allowed for one investigation.',
    control: 'number', integer: false, step: 'any', range: POSITIVE_NUMBER_RANGE, unit: MINUTES_STORED_AS_SECONDS, keywords: ['deadline', 'session'], defaultValue: 900, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-posthog-escalation', path: 'posthog.userEscalationThreshold', title: 'Escalation threshold', group: 'lanes-posthog',
    description: 'Affected-user count that escalates an issue.',
    control: 'number', range: POSITIVE_NUMBER_RANGE, unit: USERS, keywords: ['threshold', 'severity'], defaultValue: 25, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-posthog-fix-timeout', path: 'posthog.fixTimeoutSeconds', title: 'Fix timeout', group: 'lanes-posthog',
    description: 'Maximum time allowed for one fix session.',
    control: 'number', integer: false, step: 'any', range: POSTHOG_FIX_TIMEOUT_RANGE, unit: MINUTES_STORED_AS_SECONDS, keywords: ['deadline', 'repair'], defaultValue: 1800, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-posthog-traffic-multiplier', path: 'posthog.trafficSpikeMultiplier', title: 'Spike multiplier', group: 'lanes-posthog',
    description: 'Baseline multiplier required to classify a traffic spike.',
    control: 'number', integer: false, step: 'any', range: POSTHOG_TRAFFIC_MULTIPLIER_RANGE, unit: MULTIPLIER, keywords: ['baseline', 'ratio'], defaultValue: 3, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-posthog-traffic-min-users', path: 'posthog.trafficSpikeMinUsers', title: 'Min users to alert', group: 'lanes-posthog',
    description: 'Minimum recent unique users for an initial traffic-spike alert. Escalation and recovery alerts bypass this minimum.',
    control: 'number', range: POSTHOG_TRAFFIC_MIN_USERS_RANGE, unit: USERS, keywords: ['threshold', 'analytics'], defaultValue: 10, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-posthog-traffic-cooldown', path: 'posthog.trafficSpikeCooldownMinutes', title: 'Spike cooldown', group: 'lanes-posthog',
    description: 'Cooldown for new traffic spikes. Escalation and recovery alerts bypass it. Zero removes the time delay; repeated active-spike alerts are still suppressed.',
    control: 'number', integer: false, step: 'any', range: NON_NEGATIVE_NUMBER_RANGE, unit: HOURS_STORED_AS_MINUTES, keywords: ['silence', 'delay'], defaultValue: 360, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-posthog-traffic-baseline', path: 'posthog.trafficSpikeBaselineDays', title: 'Baseline window', group: 'lanes-posthog',
    description: 'Historical window used to calculate normal hourly traffic.',
    control: 'number', range: POSTHOG_TRAFFIC_BASELINE_RANGE, unit: DAYS, keywords: ['history', 'analytics'], defaultValue: 7, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-posthog-recurrence-dedupe', path: 'posthog.recurrenceDedupe', title: 'Deduplicate recurring issues', group: 'lanes-posthog',
    description: 'Treat an issue seen again inside the recurrence window as the same investigation instead of opening a new one.',
    control: 'toggle', keywords: ['recurrence', 'dedupe', 'issues'], defaultValue: true, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-posthog-recurrence-window-days', path: 'posthog.recurrenceWindowDays', title: 'Recurrence window', group: 'lanes-posthog',
    description: 'How far back an issue counts as a recurrence of an investigated one.',
    control: 'number', integer: false, step: 'any', range: POSITIVE_NUMBER_RANGE, unit: DAYS, keywords: ['recurrence', 'window'], defaultValue: 7, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-posthog-transient-recurrence-limit', path: 'posthog.transientRecurrenceLimit', title: 'Transient recurrence limit', group: 'lanes-posthog',
    description: 'How many times a transient issue may recur before it is investigated again.',
    control: 'number', integer: false, step: 'any', range: POSITIVE_NUMBER_RANGE, unit: RECURRENCES, keywords: ['recurrence', 'transient', 'limit'], defaultValue: 3, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-posthog-repo-path', path: 'posthog.repoPath', title: 'Repository path', group: 'lanes-posthog',
    description: 'Absolute path of the local checkout investigations read and fixes branch from, for every project the project map does not name.',
    control: 'text', keywords: ['repository', 'checkout', 'path'], defaultValue: '', takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-posthog-project-map', path: 'posthog.projectMap', title: 'Project map', group: 'lanes-posthog',
    description: 'PostHog project id to a label: the name shown for that project, and, when it is an absolute path to a checkout, the repository its issues are investigated in.',
    control: 'json', keywords: ['projects', 'repositories', 'map'], defaultValue: {}, takesEffect: 'now', fileOnlyReason: STRUCTURED_VALUE, ...FILE_ONLY,
  },
  {
    id: 'file-team-review-org', path: 'teamReview.org', title: 'GitHub organization (legacy)', group: 'lanes-team-review',
    description: 'Organization login that owns the team, for example PostHog. Read only when github.teams is empty.',
    control: 'text', keywords: ['github', 'owner', 'legacy'], defaultValue: '', takesEffect: 'now',
    fileOnlyReason: 'A legacy key: github.teams names teams as org/slug entries and wins whenever it is set.', ...FILE_ONLY,
  },
  {
    id: 'file-team-review-team', path: 'teamReview.team', title: 'GitHub team (legacy)', group: 'lanes-team-review',
    description: 'Team slug whose members and review requests are polled. Read only when github.teams is empty.',
    control: 'text', keywords: ['github', 'slug', 'legacy'], defaultValue: '', takesEffect: 'now',
    fileOnlyReason: 'A legacy key: github.teams names teams as org/slug entries and wins whenever it is set.', ...FILE_ONLY,
  },
  {
    id: 'file-workflows-max-actions-per-poll', path: 'workflows.maxActionsPerPoll', title: 'Actions per poll', group: 'lanes-workflows',
    description: 'Most actions run in one poll. The rest are dropped and logged.',
    control: 'number', range: WORKFLOWS_MAX_ACTIONS_PER_POLL_RANGE, unit: ACTIONS, keywords: ['cap', 'rate limit'], defaultValue: 20, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-workflows-rules', path: 'workflows.rules', title: 'Workflow rule definitions', group: 'lanes-workflows',
    description: 'The rules the Workflows section switches on and off: each names its repositories, one pull request event, its filters and its actions.',
    control: 'json', keywords: ['pull requests', 'automation', 'rules'], defaultValue: [], takesEffect: 'now',
    fileOnlyReason: 'Rule definitions are written in config.json; the Workflows section only switches each rule on or off.', ...FILE_ONLY,
  },
]);

export const SETTINGS_REGISTRY: SettingsRegistry = Object.freeze({ sections: SECTIONS, fileOnly: FILE_ONLY_SETTINGS });

export const SETTINGS_SECTION_ALIASES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  SECTIONS.flatMap((section) => (section.legacyIds ?? []).map((legacyId) => [legacyId, section.id])),
));

export const SETTINGS_MOVED_SETTINGS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze(
  SECTIONS.reduce<Record<string, Record<string, string>>>((moved, section) => {
    for (const setting of section.settings) {
      for (const legacy of setting.legacyIds ?? []) {
        moved[legacy.sectionId] = { ...moved[legacy.sectionId], [legacy.settingId]: section.id };
      }
    }
    return moved;
  }, {}),
);
