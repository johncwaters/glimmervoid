import { FLYING_ANIMALS_DEFAULTS } from './flying-animals-core.ts';

export interface SettingsOption {
  value: string;
  label: string;
}

export interface SettingsSetting {
  id: string;
  path: string;
  title: string;
  description?: string;
  control?: string;
  options?: SettingsOption[] | string[];
  optionsFrom?: string;
  keywords?: string[];
  defaultValue?: unknown;
  integer?: boolean;
  nullable?: boolean;
  zeroIsNull?: boolean;
  step?: number;
  range?: string;
  maximumSettingId?: string;
  valueKind?: string;
  warning?: string;
  danger?: boolean;
  advanced?: boolean;
  commitOnChange?: boolean;
  fileOnly?: boolean;
  status?: string;
  projectId?: string;
  value?: unknown;
}

export interface SettingsSectionLink {
  settingId: string;
  title: string;
}

export interface SettingsSection {
  id: string;
  level: string;
  title: string;
  description?: string;
  caption?: string;
  unattendedLinks?: SettingsSectionLink[];
  project?: unknown;
  settings: SettingsSetting[];
}

export const SETTINGS_SECTION_ALIASES = Object.freeze({
  general: 'machine-general',
  updates: 'machine-updates',
  terminal: 'machine-terminal',
  repos: 'machine-repositories',
  repositories: 'machine-repositories',
  advanced: 'machine-detection-sessions',
  detection: 'machine-detection-sessions',
  telegram: 'machine-telegram',
  notifications: 'machine-telegram',
  'change-map': 'lanes-change-map',
  visions: 'lanes-visions',
  ingest: 'lanes-ingest',
  posthog: 'lanes-posthog',
  'team-review': 'lanes-team-review',
  reviews: 'lanes-team-review',
  usage: 'machine-usage',
  privacy: 'machine-privacy',
  telemetry: 'machine-privacy',
  shortcuts: 'browser-shortcuts',
  animals: 'browser-flying-animals',
  'flying-animals': 'browser-flying-animals',
  unattended: 'lanes-unattended',
});

export const SETTINGS_MOVED_SETTINGS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  'browser-appearance': Object.freeze({ 'flying-animals': 'browser-flying-animals' }),
});

export const SETTINGS_MAP = Object.freeze([
  {
    id: 'browser-appearance',
    level: 'browser',
    title: 'Appearance and alerts',
    description: 'Preferences stored only in this browser.',
    settings: [
      {
        id: 'theme',
        path: 'pref:themeId',
        title: 'Theme',
        description: 'Color scheme for the dashboard.',
        control: 'select',
        optionsFrom: 'themes',
        keywords: ['color', 'palette'],
        defaultValue: 'phyrexian',
      },
      {
        id: 'alert-sound',
        path: 'pref:soundId',
        title: 'Alert sound',
        description: 'Sound played when a session needs attention. Your own .ogg, .mp3, .wav, .m4a or .webm files dropped into the sounds folder of the Glimmervoid home (~/.glimmervoid/sounds/, or $GLIMMERVOID_HOME/sounds/) are listed after the built-in sounds. Glimmervoid never creates that folder, so make it yourself; new files show up the next time Settings opens.',
        control: 'select',
        optionsFrom: 'sounds',
        keywords: ['audio', 'notification', 'custom'],
        defaultValue: 'chime',
      },
      {
        id: 'desktop-notifications',
        path: 'pref:notificationsEnabled',
        title: 'Desktop notifications',
        description: 'Raise a browser notification when a session needs attention while this dashboard is in the background.',
        control: 'toggle',
        keywords: ['browser', 'attention'],
        defaultValue: true,
      },
    ],
  },
  {
    id: 'browser-flying-animals', level: 'browser', title: 'Flying animals',
    description: 'Choose your flying animals. Changes apply immediately in this browser.',
    settings: [
      {
        id: 'flying-animals',
        path: 'pref:flyingAnimalsEnabled',
        title: 'Flying animals',
        description: 'Show animated animals flying across the dashboard.',
        control: 'toggle',
        keywords: ['animation', 'motion'],
        defaultValue: false,
      },
      {
        id: 'animals-min-gap', path: 'pref:flyingAnimalsMinGapSeconds', title: 'Time between flights: minimum (seconds)',
        description: 'Shortest pause between flights.', control: 'number', advanced: true, commitOnChange: true, integer: false, step: 0.1,
        range: 'FLYING_ANIMALS_GAP_RANGE', maximumSettingId: 'animals-max-gap', keywords: ['animals', 'frequency'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsMinGapSeconds,
      },
      {
        id: 'animals-max-gap', path: 'pref:flyingAnimalsMaxGapSeconds', title: 'Time between flights: maximum (seconds)',
        description: 'Longest pause between flights.', control: 'number', advanced: true, commitOnChange: true, integer: false, step: 0.1,
        range: 'FLYING_ANIMALS_GAP_RANGE', keywords: ['animals', 'frequency'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsMaxGapSeconds,
      },
      {
        id: 'animals-min-duration', path: 'pref:flyingAnimalsMinDurationSeconds', title: 'Flight duration: minimum (seconds)',
        description: 'Shortest flight, for faster animals.', control: 'number', advanced: true, commitOnChange: true, integer: false, step: 0.1,
        range: 'FLYING_ANIMALS_DURATION_RANGE', maximumSettingId: 'animals-max-duration', keywords: ['animals', 'speed'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsMinDurationSeconds,
      },
      {
        id: 'animals-max-duration', path: 'pref:flyingAnimalsMaxDurationSeconds', title: 'Flight duration: maximum (seconds)',
        description: 'Longest flight, for slower animals.', control: 'number', advanced: true, commitOnChange: true, integer: false, step: 0.1,
        range: 'FLYING_ANIMALS_DURATION_RANGE', keywords: ['animals', 'speed'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsMaxDurationSeconds,
      },
      {
        id: 'animals-scale', path: 'pref:flyingAnimalsScale', title: 'Size multiplier',
        description: 'Scale applied on top of the viewport size.', control: 'number', advanced: true, commitOnChange: true, integer: false, step: 0.1,
        range: 'FLYING_ANIMALS_SCALE_RANGE', keywords: ['animals', 'size'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsScale,
      },
      {
        id: 'animals-on-phone', path: 'pref:flyingAnimalsOnPhone', title: 'Show on phone layout',
        description: 'Allow flights on the phone layout.', control: 'toggle', advanced: true,
        keywords: ['animals', 'mobile'], defaultValue: FLYING_ANIMALS_DEFAULTS.flyingAnimalsOnPhone,
      },
    ],
  },
  {
    id: 'browser-shortcuts',
    level: 'browser',
    title: 'Shortcuts and about',
    description: 'Keyboard reference and build information.',
    settings: [],
  },
  {
    id: 'machine-general',
    level: 'machine',
    title: 'General',
    description: 'Machine-wide session startup and diagnostics.',
    settings: [
      {
        id: 'auto-resume', path: 'autoResume', title: 'Auto-resume sessions on startup',
        description: 'Resume conversations that were live when Glimmervoid last shut down or crashed.',
        control: 'toggle', keywords: ['startup', 'conversation'], defaultValue: true,
      },
      {
        id: 'debug-mode', path: 'debugMode', title: 'Debug mode',
        description: 'Show session-card diagnostics for state, transitions and detection signals.',
        control: 'toggle', keywords: ['diagnostics', 'state'], defaultValue: false,
      },
    ],
    unattendedLinks: [
      { settingId: 'skip-permissions-by-default', title: 'Skip permission prompts by default' },
      { settingId: 'rtk-compression', title: 'rtk output compression' },
    ],
  },
  {
    id: 'machine-updates',
    level: 'machine',
    title: 'Updates',
    description: 'See which Glimmervoid version is running, which one is newest, and update in one step.',
    settings: [
      {
        id: 'update-summary', path: 'checkForUpdates', title: 'Status',
        description: 'Whether this install is up to date, and what an update would move it to.',
        control: 'readonly', keywords: ['version', 'available', 'current'], status: 'update-summary',
      },
      {
        id: 'update-actions', path: 'checkForUpdates', title: 'Actions',
        description: 'Update and restart stages the newest build, then restarts to run it. Update without restart stages it for a later restart.',
        control: 'readonly', keywords: ['check', 'restart'], status: 'update-actions',
      },
      {
        id: 'update-installed', path: 'checkForUpdates', title: 'Running version',
        description: 'The version, commit, branch and checkout state running now.',
        control: 'readonly', keywords: ['version', 'commit', 'installed'], status: 'update-installed',
      },
      {
        id: 'update-latest', path: 'updateChannel', title: 'Latest version',
        description: 'The newest target found on the selected update channel.',
        control: 'readonly', keywords: ['release', 'commit'], status: 'update-latest',
      },
      {
        id: 'update-last-checked', path: 'checkForUpdates', title: 'Last checked',
        description: 'The most recent update check, or why automatic checks are off.',
        control: 'readonly', keywords: ['time', 'failure'], status: 'update-last-checked',
      },
      {
        id: 'update-channel', path: 'updateChannel', title: 'Channel',
        description: 'Track tagged releases or the upstream of the checked-out branch.',
        control: 'select', options: [{ value: 'release', label: 'Release' }, { value: 'main', label: 'Main' }],
        keywords: ['release', 'branch'], defaultValue: 'release',
      },
      {
        id: 'check-updates', path: 'checkForUpdates', title: 'Check for updates automatically',
        description: 'Check for a newer Glimmervoid at launch, while a dashboard is connected, and when this page opens.',
        control: 'toggle', keywords: ['release', 'github'], defaultValue: true,
      },
    ],
  },
  {
    id: 'machine-terminal',
    level: 'machine',
    title: 'Terminal',
    description: 'Terminal behavior shared by dashboard clients.',
    settings: [
      {
        id: 'replay-buffer', path: 'replayBufferKB', title: 'Replay buffer (KB)',
        description: 'PTY output retained for clients that reconnect or join late.',
        control: 'number', range: 'REPLAY_BUFFER_KB_RANGE', keywords: ['history', 'backfill'], defaultValue: 512,
      },
      {
        id: 'cursor-blink', path: 'cursorBlink', title: 'Cursor blink',
        description: 'Blink the cursor in every terminal.',
        control: 'toggle', keywords: ['caret', 'terminal'], defaultValue: false,
      },
    ],
  },
  {
    id: 'machine-detection-sessions',
    level: 'machine',
    title: 'Detection and sessions',
    description: 'Config-file-only detection, timing, worktree and process settings.',
    settings: [
      { id: 'file-detect-background-agents', path: 'detectBackgroundAgents', title: 'Detect background agents', description: 'Hold completion while tracked background work is active.', control: 'readonly', keywords: ['subagents', 'completion'], fileOnly: true },
      { id: 'file-record-signals', path: 'recordSignals', title: 'Record structural signals', description: 'Keep forensic status and hook recordings.', control: 'readonly', keywords: ['recordings', 'diagnostics'], fileOnly: true },
      { id: 'file-trace-enabled', path: 'trace.enabled', title: 'Capture session traces', description: 'Keep normalized Claude transcript traces for session debugging.', control: 'readonly', keywords: ['transcripts', 'diagnostics'], fileOnly: true },
      { id: 'file-anti-slop-prompt', path: 'antiSlopPrompt', title: 'Anti-slop prompt', description: 'Append the configured quality prompt to session instructions.', control: 'readonly', keywords: ['quality', 'instructions'], fileOnly: true },
      { id: 'file-detect-scheduled-wakeups', path: 'detectScheduledWakeups', title: 'Detect scheduled wakeups', description: 'Surface advisory wakeup timing for scheduled sessions.', control: 'readonly', keywords: ['schedule', 'sleep'], fileOnly: true },
      { id: 'file-worktree-auto-rebase', path: 'worktreeAutoRebase', title: 'Worktree auto-rebase', description: 'Rebase eligible session worktrees when the integration branch moves.', control: 'readonly', keywords: ['git', 'branch'], fileOnly: true },
      { id: 'file-worktree-rerere', path: 'worktreeRerere', title: 'Worktree rerere', description: 'Reuse recorded Git conflict resolutions.', control: 'readonly', keywords: ['git', 'conflicts'], fileOnly: true },
      { id: 'file-integration-branch', path: 'integrationBranch', title: 'Integration branch', description: "Base branch for session worktrees. Empty = each repo's default branch.", control: 'readonly', keywords: ['git', 'merge'], fileOnly: true },
      { id: 'file-worktree-root', path: 'worktreeRoot', title: 'Worktree root', description: 'Directory that contains session worktrees.', control: 'readonly', keywords: ['git', 'directory'], fileOnly: true },
      { id: 'file-worktree-share', path: 'worktreeShare', title: 'Shared worktree paths', description: 'Local paths copied or linked into worktrees.', control: 'readonly', keywords: ['files', 'context'], fileOnly: true },
      { id: 'file-port', path: 'port', title: 'Local port', description: 'Port used by the local dashboard listener.', control: 'readonly', keywords: ['server', 'listener'], fileOnly: true },
      { id: 'file-auto-recover-seconds', path: 'autoRecoverSeconds', title: 'Auto-recovery delay', description: 'Delay before an interrupted state can recover.', control: 'readonly', keywords: ['timer', 'recovery'], fileOnly: true },
      { id: 'file-input-grace-seconds', path: 'inputGraceSeconds', title: 'Input grace period', description: 'Grace window around operator input.', control: 'readonly', keywords: ['timer', 'prompt'], fileOnly: true },
      { id: 'file-prompt-detection-ms', path: 'promptDetectionMs', title: 'Prompt detection delay', description: 'Timing threshold used by prompt detection.', control: 'readonly', keywords: ['timer', 'detection'], fileOnly: true },
      { id: 'file-notify-debounce-ms', path: 'notifyDebounceMs', title: 'Notification debounce', description: 'Delay used to coalesce notification state changes.', control: 'readonly', keywords: ['timer', 'alerts'], fileOnly: true },
      { id: 'file-phone-escalation-ms', path: 'phoneEscalationMs', title: 'Phone escalation delay', description: 'Delay before off-dashboard escalation.', control: 'readonly', keywords: ['timer', 'telegram'], fileOnly: true },
      { id: 'file-post-turn-checks', path: 'postTurnChecks', title: 'Post-turn checks', description: 'Deterministic checks run after eligible turns. They only report findings unless mode is fix.', control: 'readonly', keywords: ['quality', 'fixes'], fileOnly: true },
      { id: 'file-branch-gc-enabled', path: 'branchGc.enabled', title: 'Branch cleanup', description: 'Enable cleanup of eligible session branches.', control: 'readonly', keywords: ['git', 'cleanup'], fileOnly: true },
      { id: 'file-branch-gc-worktrees', path: 'branchGc.worktrees', title: 'Local worktree cleanup', description: 'Enable cleanup of eligible local worktrees.', control: 'readonly', keywords: ['git', 'worktree', 'cleanup'], fileOnly: true },
      { id: 'file-branch-gc-prefixes', path: 'branchGc.prefixes', title: 'Branch cleanup prefixes', description: 'Remote branch prefixes eligible for cleanup.', control: 'readonly', keywords: ['git', 'branch'], fileOnly: true },
      { id: 'file-branch-gc-dry-run', path: 'branchGc.dryRun', title: 'Branch cleanup dry run', description: 'Report planned cleanup without deleting remote branches.', control: 'readonly', keywords: ['git', 'safety'], fileOnly: true },
      { id: 'file-branch-gc-stale-days', path: 'branchGc.staleDays', title: 'Branch stale days', description: 'Age threshold for orphan branch cleanup when unmerged deletion is on.', control: 'readonly', keywords: ['git', 'retention'], fileOnly: true },
      { id: 'file-branch-gc-interval-ms', path: 'branchGc.intervalMs', title: 'Branch cleanup interval', description: 'Delay between branch cleanup passes.', control: 'readonly', keywords: ['git', 'schedule'], fileOnly: true },
      { id: 'file-custom-agents', path: 'customAgents', title: 'Custom agents', description: 'Extra agent CLIs a session can be spawned with.', control: 'readonly', keywords: ['adapters', 'cli'], fileOnly: true, status: 'custom-agents' },
    ],
  },
  {
    id: 'machine-repositories',
    level: 'machine',
    title: 'Repositories',
    description: 'Project discovery roots for new sessions.',
    settings: [
      {
        id: 'repository-roots', path: 'repoRoots', title: 'Repository roots',
        description: 'Directories scanned for projects when adding sessions.',
        control: 'list', keywords: ['folders', 'project discovery'], defaultValue: [],
      },
    ],
  },
  {
    id: 'machine-telegram',
    level: 'machine',
    title: 'Telegram',
    description: 'One bot shared by session, PR review and PostHog notifications.',
    settings: [
      {
        id: 'telegram-bot-token', path: 'telegram.botToken', title: 'Bot token',
        description: 'Credential used by the shared Telegram bot.',
        control: 'password', keywords: ['credential', 'api'], defaultValue: '',
      },
      {
        id: 'telegram-chat-id', path: 'telegram.chatId', title: 'Chat id',
        description: 'Destination chat for enabled Telegram lanes.',
        control: 'text', keywords: ['destination', 'channel'], defaultValue: '',
      },
      {
        id: 'telegram-session-notifications', path: 'telegramNotifications', title: 'Send session notifications',
        description: 'Ping when a session completes, needs input or fails and no dashboard is open.',
        control: 'toggle', keywords: ['phone', 'off dashboard'], defaultValue: false,
      },
    ],
  },
  {
    id: 'machine-usage',
    level: 'machine',
    title: 'Usage',
    description: 'Local transcript accounting and estimated-cost budgets.',
    settings: [
      {
        id: 'usage-enabled', path: 'usage.enabled', title: 'Track token usage',
        description: 'Read local CLI transcripts and roll them into the Usage view and session chips.',
        control: 'toggle', keywords: ['tokens', 'cost'], defaultValue: true, status: 'usage-last-report',
      },
      {
        id: 'usage-codex', path: 'usage.vendors.codex', title: 'Track Codex usage',
        description: 'Include local Codex CLI transcripts in usage reports.',
        control: 'toggle', keywords: ['openai', 'vendor'], defaultValue: true,
      },
      {
        id: 'usage-grok', path: 'usage.vendors.grok', title: 'Track Grok usage',
        description: 'Include local Grok CLI transcripts in usage reports.',
        control: 'toggle', keywords: ['xai', 'vendor'], defaultValue: true,
      },
      {
        id: 'usage-fetch-pricing', path: 'usage.fetchPricing', title: 'Fetch current model prices',
        description: 'Refresh the public price table daily instead of relying only on the bundled snapshot.',
        control: 'toggle', keywords: ['rates', 'models'], defaultValue: true,
      },
      {
        id: 'usage-scan-interval', path: 'usage.scanIntervalMinutes', title: 'Scan interval (minutes)',
        description: 'Delay between completed transcript scans.',
        control: 'number', range: 'USAGE_SCAN_INTERVAL_RANGE', keywords: ['poll', 'refresh'], defaultValue: 5,
      },
      {
        id: 'usage-retain-days', path: 'usage.retainDays', title: 'Retain transcript detail (days)',
        description: 'How long live transcript detail stays available.',
        control: 'number', range: 'USAGE_RETAIN_DAYS_RANGE', keywords: ['history', 'retention'], defaultValue: 90,
      },
      {
        id: 'usage-cost-mode', path: 'usage.costMode', title: 'Cost mode',
        description: 'Choose whether recorded costs, calculated costs or both can appear.',
        control: 'select',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'calculate', label: 'Calculate' },
          { value: 'display', label: 'Display' },
        ],
        keywords: ['pricing', 'estimate'], defaultValue: 'auto',
      },
      {
        id: 'usage-daily-budget', path: 'usage.budget.dailyUsd', title: 'Daily budget (USD)',
        description: 'Estimated daily spend ceiling. Zero or below means no ceiling.',
        control: 'number', range: 'USAGE_BUDGET_RANGE', keywords: ['spend', 'alert'], defaultValue: null,
        integer: false, nullable: true, zeroIsNull: true, step: 0.01,
      },
      {
        id: 'usage-monthly-budget', path: 'usage.budget.monthlyUsd', title: 'Monthly budget (USD)',
        description: 'Estimated monthly spend ceiling. Zero or below means no ceiling.',
        control: 'number', range: 'USAGE_BUDGET_RANGE', keywords: ['spend', 'alert'], defaultValue: null,
        integer: false, nullable: true, zeroIsNull: true, step: 0.01,
      },
    ],
  },
  {
    id: 'machine-privacy',
    level: 'machine',
    title: 'Privacy',
    description: 'What Glimmervoid sends about itself.',
    settings: [
      {
        id: 'telemetry-enabled', path: 'telemetry.enabled', title: 'Send anonymous usage and error data',
        description: 'Version, platform, app starts, daily activity, session starts and ends with agent kind, exit kind and duration, errors as their type, error code and scrubbed stack frames, and per session token counts, models and estimated costs from the usage scan, under a random install id. Never error messages, paths, repository or branch names, prompts or terminal output. GLIMMERVOID_TELEMETRY=0, DO_NOT_TRACK=1 or CI=true turn it off regardless.',
        control: 'toggle', keywords: ['telemetry', 'analytics', 'tracking', 'opt out'], defaultValue: true,
      },
    ],
  },
  {
    id: 'lanes-change-map',
    level: 'lanes',
    title: 'Change map',
    description: 'Optional model narration for deterministic change facts.',
    settings: [
      {
        id: 'change-map-narrator-enabled', path: 'changeMap.narrator.enabled', title: 'Enable narration',
        description: 'Add cited model claims to the change map.',
        control: 'toggle', keywords: ['review', 'claims'], defaultValue: false,
      },
      {
        id: 'change-map-narrator-engine', path: 'changeMap.narrator.engine', title: 'Narrator engine',
        description: 'CLI used to generate change map claims.',
        control: 'select', options: [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }],
        keywords: ['claude', 'codex'], defaultValue: 'claude',
      },
      {
        id: 'change-map-narrator-model', path: 'changeMap.narrator.model', title: 'Narrator model',
        description: 'Blank uses the engine default: haiku for Claude, the configured Codex model for Codex.',
        control: 'text', keywords: ['claude', 'codex', 'haiku'], defaultValue: '',
      },
      {
        id: 'change-map-narrator-timeout', path: 'changeMap.narrator.timeoutSeconds', title: 'Narrator timeout (seconds)',
        description: 'Maximum time allowed for one narration.',
        control: 'number', range: 'CHANGE_MAP_NARRATOR_TIMEOUT_RANGE', keywords: ['deadline', 'narration'], defaultValue: 90,
      },
    ],
  },
  {
    id: 'lanes-visions',
    level: 'lanes',
    title: 'Visions',
    description: 'Editor-buffer findings and bounded model comments.',
    settings: [
      {
        id: 'visions-enabled', path: 'visions.enabled', title: 'Enable Visions',
        description: 'Wires every editor on this machine, then shows their buffers findings in the Visions view.',
        control: 'toggle', keywords: ['editor', 'findings', 'lsp'], defaultValue: false,
      },
      {
        id: 'visions-dispatch-enabled', path: 'visions.dispatch.enabled', title: 'Enable model comments',
        description: 'Start bounded review sessions for local editor buffers.',
        control: 'toggle', keywords: ['review', 'dispatch'], defaultValue: false,
      },
      {
        id: 'visions-quiet-delay', path: 'visions.dispatch.quietMs', title: 'Quiet delay (ms)',
        description: 'Required editor quiet time before dispatch.',
        control: 'number', range: 'VISIONS_QUIET_MS_RANGE', keywords: ['debounce', 'idle'], defaultValue: 30000,
      },
      {
        id: 'visions-cooldown', path: 'visions.dispatch.cooldownMs', title: 'Cooldown (ms)',
        description: 'Minimum delay between review dispatches.',
        control: 'number', range: 'VISIONS_COOLDOWN_MS_RANGE', keywords: ['rate limit', 'delay'], defaultValue: 300000,
      },
      {
        id: 'visions-max-per-hour', path: 'visions.dispatch.maxPerHour', title: 'Max per hour',
        description: 'Maximum review sessions dispatched per hour.',
        control: 'number', range: 'VISIONS_MAX_PER_HOUR_RANGE', keywords: ['rate limit', 'reviews'], defaultValue: 6,
      },
      {
        id: 'visions-activity-max-per-hour', path: 'visions.dispatch.activityMaxPerHour', title: 'Activity max per hour',
        description: 'Maximum activity-driven reviews dispatched per hour.',
        control: 'number', range: 'VISIONS_ACTIVITY_MAX_PER_HOUR_RANGE', keywords: ['rate limit', 'events'], defaultValue: 2,
      },
      {
        id: 'visions-dispatch-timeout', path: 'visions.dispatch.dispatchTimeoutSeconds', title: 'Dispatch timeout (seconds)',
        description: 'Maximum time allowed for one review session.',
        control: 'number', range: 'VISIONS_DISPATCH_TIMEOUT_RANGE', keywords: ['deadline', 'review'], defaultValue: 180,
      },
      {
        id: 'visions-intent-thread-ttl', path: 'visions.intent.threadTtlMs', title: 'Intent thread lifetime (ms)',
        description: 'How long an intent thread nobody advanced stays live before it retires.',
        control: 'number', range: 'VISIONS_INTENT_THREAD_TTL_MS_RANGE', keywords: ['intent', 'decay', 'thread'], defaultValue: 259200000,
      },
      {
        id: 'visions-model', path: 'visions.dispatch.model', title: 'Model override',
        description: 'Leave blank to use the configured Claude Code default.',
        control: 'text', keywords: ['claude', 'override'], defaultValue: '',
      },
      {
        id: 'visions-projects', path: 'visions.projects', title: 'Projects',
        description: 'Leave every project clear to accept buffers from every configured project.',
        control: 'projects', keywords: ['repositories', 'filter'], defaultValue: [],
      },
      {
        id: 'visions-auto-fix', path: 'visions.autoFix', title: 'Apply tier 1 fixes',
        description: 'Allow Visions to edit the active buffer without asking.',
        control: 'toggle', keywords: ['automatic', 'edits'], danger: true,
        warning: 'Enabling this control lets Visions edit eligible buffers without a carbon unit present.', defaultValue: false,
      },
    ],
  },
  {
    id: 'lanes-ingest',
    level: 'lanes',
    title: 'Ingest',
    description: 'Machine-context ingest behind Visions.',
    settings: [
      {
        id: 'ingest-enabled', path: 'ingest.enabled', title: 'Enable machine context ingest',
        description: 'Enable the local activity feed behind Visions. Turning Visions on turns this on for you.',
        control: 'toggle', keywords: ['events', 'activity'], defaultValue: false,
      },
      {
        id: 'ingest-terminal', path: 'ingest.sources.terminal.enabled', title: 'Terminal output source',
        description: 'Include terminal output in the ingest feed.',
        control: 'toggle', keywords: ['pty', 'source'], defaultValue: false,
      },
      {
        id: 'ingest-agent-logs', path: 'ingest.sources.agentLogs.enabled', title: 'Agent logs source',
        description: 'Include local agent logs in the ingest feed.',
        control: 'toggle', keywords: ['transcript', 'source'], defaultValue: false,
      },
      {
        id: 'ingest-git', path: 'ingest.sources.git.enabled', title: 'Git activity source',
        description: 'Include local Git activity in the ingest feed.',
        control: 'toggle', keywords: ['commits', 'source'], defaultValue: false,
      },
      {
        id: 'ingest-fs', path: 'ingest.sources.fs.enabled', title: 'File changes source',
        description: 'Include watched file changes in the ingest feed.',
        control: 'toggle', keywords: ['filesystem', 'source'], defaultValue: false,
      },
      {
        id: 'ingest-shell-history', path: 'ingest.sources.shellHistory.enabled', title: 'Shell history source',
        description: 'Include local shell history in the ingest feed.',
        control: 'toggle', keywords: ['commands', 'source'], defaultValue: false,
      },
      {
        id: 'ingest-editor', path: 'ingest.sources.editor.enabled', title: 'Editor events source',
        description: 'Include local editor events in the ingest feed.',
        control: 'toggle', keywords: ['buffers', 'source'], defaultValue: false,
      },
    ],
  },
  {
    id: 'lanes-posthog',
    level: 'lanes',
    title: 'PostHog',
    description: 'Error monitoring, investigations and traffic-spike alerts.',
    settings: [
      {
        id: 'posthog-enabled', path: 'posthog.enabled', title: 'Enable PostHog monitoring',
        description: 'Poll PostHog error tracking and investigate issues that move.',
        control: 'toggle', keywords: ['errors', 'monitoring'], defaultValue: false,
      },
      {
        id: 'posthog-host', path: 'posthog.host', title: 'Host',
        description: 'PostHog cloud or self-hosted HTTP URL.',
        control: 'text', keywords: ['url', 'server'], defaultValue: 'https://us.posthog.com',
      },
      {
        id: 'posthog-api-key', path: 'posthog.apiKey', title: 'Personal API key',
        description: 'Credential with read access to PostHog projects.',
        control: 'password', keywords: ['credential', 'token'], defaultValue: '',
      },
      {
        id: 'posthog-projects', path: 'posthog.projects', title: 'Projects',
        description: 'Use all or a comma-separated list of numeric PostHog project ids.',
        control: 'text', keywords: ['project ids', 'filter'], defaultValue: 'all', valueKind: 'posthog-projects',
      },
      {
        id: 'posthog-interval', path: 'posthog.intervalMinutes', title: 'Poll interval (minutes)',
        description: 'Delay between PostHog polling passes.',
        control: 'number', range: 'POSTHOG_INTERVAL_RANGE', keywords: ['refresh', 'schedule'], defaultValue: 15,
      },
      {
        id: 'posthog-max-investigations', path: 'posthog.maxConcurrentInvestigations', title: 'Max concurrent investigations',
        description: 'Maximum investigation sessions running together.',
        control: 'number', range: 'POSTHOG_MAX_CONCURRENT_RANGE', keywords: ['parallel', 'workers'], defaultValue: 2,
      },
      {
        id: 'posthog-investigation-timeout', path: 'posthog.investigationTimeoutSeconds', title: 'Investigation timeout (seconds)',
        description: 'Maximum time allowed for one investigation.',
        control: 'number', range: 'POSTHOG_INVESTIGATION_TIMEOUT_RANGE', keywords: ['deadline', 'session'], defaultValue: 900,
      },
      {
        id: 'posthog-min-users', path: 'posthog.minUsersToInvestigate', title: 'Min users to investigate',
        description: 'Minimum affected users before an issue is investigated.',
        control: 'number', range: 'POSTHOG_MIN_USERS_RANGE', keywords: ['threshold', 'affected'], defaultValue: 1,
      },
      {
        id: 'posthog-escalation', path: 'posthog.userEscalationThreshold', title: 'Escalation threshold (users)',
        description: 'Affected-user count that escalates an issue.',
        control: 'number', range: 'POSTHOG_ESCALATION_RANGE', keywords: ['threshold', 'severity'], defaultValue: 25,
      },
      {
        id: 'posthog-fix-timeout', path: 'posthog.fixTimeoutSeconds', title: 'Fix timeout (seconds)',
        description: 'Maximum time allowed for one fix session.',
        control: 'number', range: 'POSTHOG_FIX_TIMEOUT_RANGE', keywords: ['deadline', 'repair'], defaultValue: 1800,
      },
      {
        id: 'posthog-traffic-enabled', path: 'posthog.trafficSpikeEnabled', title: 'Traffic spike alerts',
        description: 'Ping when recent unique users exceed a project baseline.',
        control: 'toggle', keywords: ['analytics', 'alert'], defaultValue: true,
      },
      {
        id: 'posthog-traffic-multiplier', path: 'posthog.trafficSpikeMultiplier', title: 'Spike multiplier',
        description: 'Baseline multiplier required to classify a traffic spike.',
        control: 'number', range: 'POSTHOG_TRAFFIC_MULTIPLIER_RANGE', keywords: ['baseline', 'ratio'], defaultValue: 3,
      },
      {
        id: 'posthog-traffic-min-users', path: 'posthog.trafficSpikeMinUsers', title: 'Min users to alert',
        description: 'Minimum recent unique users required for a traffic alert.',
        control: 'number', range: 'POSTHOG_TRAFFIC_MIN_USERS_RANGE', keywords: ['threshold', 'analytics'], defaultValue: 10,
      },
      {
        id: 'posthog-traffic-cooldown', path: 'posthog.trafficSpikeCooldownMinutes', title: 'Spike cooldown (minutes)',
        description: 'Minimum delay between traffic alerts. Zero disables muting.',
        control: 'number', range: 'POSTHOG_TRAFFIC_COOLDOWN_RANGE', keywords: ['silence', 'delay'], defaultValue: 360,
      },
      {
        id: 'posthog-traffic-baseline', path: 'posthog.trafficSpikeBaselineDays', title: 'Baseline window (days)',
        description: 'Historical window used to calculate normal hourly traffic.',
        control: 'number', range: 'POSTHOG_TRAFFIC_BASELINE_RANGE', keywords: ['history', 'analytics'], defaultValue: 7,
      },
      {
        id: 'posthog-auto-fix', path: 'posthog.autoFix', title: 'Attempt fixes for major issues',
        description: 'Allow an isolated agent to fix an issue, push a branch and open a pull request.',
        control: 'toggle', keywords: ['automatic', 'pull request'], danger: true,
        warning: 'Enabling this control lets PostHog fixes commit, push and open pull requests automatically.', defaultValue: false,
      },
    ],
  },
  {
    id: 'lanes-team-review',
    level: 'lanes',
    title: 'Team review',
    description: "Draft reviews of teammates' pull requests for you to post from the Reviews tab.",
    settings: [
      {
        id: 'team-review-enabled', path: 'teamReview.enabled', title: 'Enable team review',
        description: 'Poll open pull requests from the team and draft a review of each one. Nothing is posted until you choose Approve or Comment.',
        control: 'toggle', keywords: ['pull requests', 'github'], defaultValue: false,
      },
      {
        id: 'team-review-org', path: 'teamReview.org', title: 'GitHub organization',
        description: 'Organization login that owns the team, for example PostHog.',
        control: 'text', keywords: ['github', 'owner'], defaultValue: '',
      },
      {
        id: 'team-review-team', path: 'teamReview.team', title: 'GitHub team',
        description: 'Team slug whose members and review requests are polled.',
        control: 'text', keywords: ['github', 'slug'], defaultValue: '',
      },
      {
        id: 'team-review-re-review-after-hours', path: 'teamReview.reReviewAfterHours', title: 'Re-review after (hours)',
        description: 'When a reviewed PR has a new head, review it again after this many hours since its last review. Queue review runs it at any time.',
        control: 'number', range: 'POSTHOG_INTERVAL_RANGE', keywords: ['review', 'delay'], defaultValue: 24, integer: false, step: 0.5,
      },
      {
        id: 'team-review-skip-idle-after-days', path: 'teamReview.skipIdleAfterDays', title: 'Skip PRs idle for (days)',
        description: 'Leave pull requests without GitHub activity for this long out of automatic review.',
        control: 'number', range: 'POSTHOG_INTERVAL_RANGE', keywords: ['idle', 'activity'], defaultValue: 14, integer: false, step: 0.5,
      },
      {
        id: 'team-review-skill', path: 'teamReview.skill', title: 'Review skill',
        description: 'Name of a Claude Code skill installed for the review agent, for example your own PR review skill. Leave empty to let the agent review with whatever skills it has.',
        control: 'text', keywords: ['skill', 'claude code', 'pr review'], defaultValue: '',
      },
    ],
  },
  {
    id: 'lanes-unattended',
    level: 'lanes',
    title: 'Unattended actions',
    description: 'Controls that let automated work change repositories or install executable tooling.',
    settings: [
      {
        id: 'skip-permissions-by-default', path: 'skipPermissionsByDefault', title: 'Skip permission prompts by default',
        description: 'Start sessions whose project sets no permission choice with the agent CLI permission bypass flag.',
        control: 'toggle', keywords: ['permissions', 'yolo', 'dangerously'], danger: true,
        warning: 'Enabling this control lets agents edit files and run shell commands without asking, and restarts running sessions that inherit it.',
        defaultValue: false,
      },
      {
        id: 'branch-gc-delete-unmerged', path: 'branchGc.deleteUnmerged', title: 'Delete unmerged branches',
        description: 'Also delete stale remote branches with no merge proof. Off keeps every unmerged branch.',
        control: 'toggle', keywords: ['git', 'cleanup', 'orphan'], danger: true,
        warning: 'Enabling this control lets branch cleanup delete stale remote branches without merge proof.',
        defaultValue: false,
      },
      {
        id: 'post-turn-checks-mode', path: 'postTurnChecks.mode', title: 'Post-turn checks mode',
        description: 'Report findings or let post-turn checks fix eligible files.',
        control: 'select', options: [{ value: 'report', label: 'Report' }, { value: 'fix', label: 'Fix' }],
        keywords: ['quality', 'fixes'], defaultValue: 'report',
      },
      {
        id: 'agent-api-enabled', path: 'agentApi.enabled', title: 'Agent API',
        description: 'Expose the per-session agent endpoint to running sessions.',
        control: 'toggle', keywords: ['session', 'localhost'], danger: true,
        warning: 'Enabling this control lets a running session spawn sibling sessions, flag itself and read the board through a per-session token on localhost, and it applies to sessions spawned after the change.',
        defaultValue: false,
      },
      {
        id: 'rtk-compression', path: 'rtk', title: 'rtk output compression',
        description: 'Compress Bash output for newly spawned or restarted sessions.',
        control: 'toggle', keywords: ['bash', 'tokens'], danger: true, status: 'rtk-install',
        warning: 'Enabling this control permits Glimmervoid to install the pinned rtk executable automatically.', defaultValue: false,
      },
    ],
  },
]);

export default SETTINGS_MAP;
