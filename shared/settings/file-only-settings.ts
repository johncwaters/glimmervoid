import { z } from 'zod';
import { PrFlowCommand, PrFlowPrAction, PrFlowRule, PrFlowSourceCommand, prFlowRulesJsonSchema } from '../contracts/pr-flows.ts';
import { QuestionRule } from '../contracts/question-manager.ts';

import {
  NON_NEGATIVE_NUMBER_RANGE,
  PORT_RANGE,
  POSITIVE_NUMBER_RANGE,
  POSTHOG_FIX_TIMEOUT_RANGE,
  POSTHOG_TRAFFIC_BASELINE_RANGE,
  POSTHOG_TRAFFIC_MIN_USERS_RANGE,
  POSTHOG_TRAFFIC_MULTIPLIER_RANGE,
  MEMORY_RESERVE_MB_RANGE,
  PACK_SCHEDULED_SESSIONS_DEFAULT,
  PACK_SCHEDULED_SESSIONS_RANGE,
  REPLAY_BUFFER_KB_RANGE,
  TASK_TITLE_TIMEOUT_RANGE,
  USAGE_INTEGER_RANGES,
  USAGE_SCAN_INTERVAL_RANGE,
  WORKFLOWS_MAX_ACTIONS_PER_POLL_RANGE,
} from '../settings-ranges.ts';
import { USAGE_COST_MODES } from '../usage-config.ts';
import { FILE_ONLY, RECURRENCES, ACTIONS, SESSIONS, SECONDS, MINUTES, HOURS, DAYS, SECONDS_STORED_AS_MS, MINUTES_STORED_AS_MS, MINUTES_STORED_AS_SECONDS, HOURS_STORED_AS_MS, HOURS_STORED_AS_MINUTES, USERS, MULTIPLIER, TUNING_KNOB, DIAGNOSTIC, PROCESS_SETTING, STRUCTURED_VALUE, BY_RULE, capitalizedOptions } from './registry-fields.ts';
import type { SettingsSetting } from './registry-fields.ts';
import { DEFAULT_MODELS } from '../contracts/agent-models.ts';

export const FILE_ONLY_SETTINGS: readonly SettingsSetting[] = Object.freeze([
  {
    id: 'file-debug-mode', path: 'debugMode', title: 'Debug mode', group: 'machine-sessions',
    description: 'Show session-card diagnostics for state, transitions and detection signals.',
    control: 'toggle', keywords: ['diagnostics', 'state'], defaultValue: false, takesEffect: 'now', fileOnlyReason: DIAGNOSTIC, ...FILE_ONLY,
  },
  {
    id: 'file-session-order', path: 'sessionOrder', title: 'Session order', group: 'machine-sessions',
    description: 'Order of sessions within each project in the sidebar and the phone Board, as session ids; a session not listed goes after the listed ones.',
    control: 'list', keywords: ['sidebar', 'rail', 'order', 'reorder', 'drag', 'rearrange'], defaultValue: [], takesEffect: 'now',
    fileOnlyReason: 'Set by dragging sessions in the sidebar, or pressing and holding them on the phone Board.', ...FILE_ONLY,
  },
  {
    id: 'file-operator-timezone', path: 'operatorTimezone', title: 'Operator timezone', group: 'machine-sessions',
    description: 'Timezone that wake times, day boundaries and shown times use; until a dashboard reports one, the machine timezone.',
    control: 'text', keywords: ['timezone', 'time zone', 'clock', 'wake', 'day'], defaultValue: null, nullable: true, takesEffect: 'now',
    fileOnlyReason: 'Set by the dashboard from the browser timezone each time it connects with a different one.', ...FILE_ONLY,
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
    id: 'file-pack-scheduled-sessions', path: 'packScheduledSessionsMax', title: 'Scheduled pack sessions', group: 'machine-sessions',
    description: 'Most sessions that pack launcher schedules keep live at once; a scheduled run past it is skipped.',
    control: 'number', range: PACK_SCHEDULED_SESSIONS_RANGE, unit: SESSIONS, keywords: ['packs', 'launchers', 'cron', 'schedule'], defaultValue: PACK_SCHEDULED_SESSIONS_DEFAULT,
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
    id: 'file-worktree-auto-rebase', path: 'worktree.autoRebase', title: 'Worktree auto-rebase', group: 'machine-detection-sessions',
    description: 'Rebase eligible session worktrees when the integration branch moves.',
    control: 'toggle', keywords: ['git', 'branch'], defaultValue: true, takesEffect: 'new-sessions', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-worktree-sync-on-start', path: 'worktree.syncOnStart', title: 'Worktree sync on start', group: 'machine-detection-sessions',
    description: 'Fetch origin and fast-forward the local integration branch before a session starts its worktree.',
    control: 'toggle', keywords: ['git', 'fetch', 'fast-forward'], defaultValue: true, takesEffect: 'new-sessions', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-worktree-clone-dependencies', path: 'worktree.cloneDependencies', title: 'Worktree dependencies', group: 'machine-detection-sessions',
    description: "Give a session worktree its node_modules before the agent starts: on macOS, clone the main checkout's when it matches the worktree's lockfile, then, except on Windows, install each folder still without one from its package-lock.json or pnpm-lock.yaml, with no package scripts.",
    control: 'toggle', keywords: ['node_modules', 'npm', 'pnpm', 'install'], defaultValue: true, takesEffect: 'new-sessions', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-worktree-rerere', path: 'worktree.rerere', title: 'Worktree rerere', group: 'machine-detection-sessions',
    description: 'Reuse recorded Git conflict resolutions.',
    control: 'toggle', keywords: ['git', 'conflicts'], defaultValue: true, takesEffect: 'restart', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-share-commit-provenance', path: 'shareCommitProvenance', title: 'Share commit provenance', group: 'machine-detection-sessions',
    description: 'After Merge pushes the base branch, also push the git notes that let glimmervoid why name the agent and session of a commit on any clone. The notes hold a hashed session id and the agent name, never a task or prompt. Off keeps them on this machine.',
    control: 'toggle', keywords: ['git', 'notes', 'why', 'privacy'], defaultValue: true, takesEffect: 'now', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-integration-branch', path: 'worktree.integrationBranch', title: 'Integration branch', group: 'machine-detection-sessions',
    description: "Base branch for session worktrees. Empty = each repo's default branch. Existing sessions are never retargeted.",
    control: 'text', nullable: true, keywords: ['git', 'merge'], defaultValue: null, takesEffect: 'new-sessions', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-worktree-root', path: 'worktree.root', title: 'Worktree root', group: 'machine-detection-sessions',
    description: 'Directory that contains session worktrees. Existing worktrees are never relocated.',
    control: 'text', keywords: ['git', 'directory'], defaultValue: '', takesEffect: 'new-sessions', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-worktree-share', path: 'worktree.share', title: 'Shared worktree paths', group: 'machine-detection-sessions',
    description: 'Local paths copied or linked during worktree preparation. A * matches names at the project root, never one containing production; name such a file in full to share it.',
    control: 'list', keywords: ['files', 'context', 'env'], defaultValue: ['.env*', '.claude'], takesEffect: 'new-sessions', fileOnlyReason: BY_RULE, ...FILE_ONLY,
  },
  {
    id: 'file-port', path: 'port', title: 'Local port', group: 'machine-detection-sessions',
    description: 'Port used by the local dashboard listener.',
    control: 'number', range: PORT_RANGE, unit: { label: 'port', storedPerDisplay: 1 }, keywords: ['server', 'listener'], defaultValue: 3000, takesEffect: 'restart', fileOnlyReason: BY_RULE, ...FILE_ONLY,
  },
  {
    id: 'file-notify-debounce-ms', path: 'notifyDebounceMs', title: 'Notification grouping window', group: 'machine-detection-sessions',
    description: 'Alerts from any session within this long of the first one fold into one sound, one desktop notification and one Telegram message.',
    control: 'number', integer: false, step: 'any', range: POSITIVE_NUMBER_RANGE, unit: SECONDS_STORED_AS_MS, keywords: ['timer', 'alerts'], defaultValue: 3000, takesEffect: 'new-sessions', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-phone-escalation-ms', path: 'phoneEscalationMs', title: 'Phone escalation delay', group: 'machine-detection-sessions',
    description: 'Delay before off-dashboard escalation.',
    control: 'number', integer: false, step: 'any', range: POSITIVE_NUMBER_RANGE, unit: MINUTES_STORED_AS_MS, keywords: ['timer', 'telegram'], defaultValue: 300000, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
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
    control: 'text', keywords: ['title', 'refiner', 'model'], defaultValue: DEFAULT_MODELS.taskTitleRefiner, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
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
    id: 'file-usage-kimi', path: 'usage.vendors.kimi', title: 'Track Kimi Code usage', group: 'machine-usage',
    description: 'Include local Kimi Code transcripts in usage reports.',
    control: 'toggle', keywords: ['moonshot', 'vendor'], defaultValue: true, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
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
    id: 'file-team-review-team', path: 'teamReview.team', title: 'GitHub team (legacy)', group: 'lanes-team-review',
    description: 'Team slug whose members and review requests are polled. Read only when github.teams is empty.',
    control: 'text', keywords: ['github', 'slug', 'legacy'], defaultValue: '', takesEffect: 'now',
    fileOnlyReason: 'A legacy key: github.teams names teams as org/slug entries and wins whenever it is set.', ...FILE_ONLY,
  },
  {
    id: 'file-workflows-max-actions-per-poll', path: 'workflows.maxActionsPerPoll', title: 'Actions per poll', group: 'lanes-my-prs',
    description: 'Most actions run in one poll. The rest are dropped and logged.',
    control: 'number', range: WORKFLOWS_MAX_ACTIONS_PER_POLL_RANGE, unit: ACTIONS, keywords: ['cap', 'rate limit'], defaultValue: 20, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-workflows-rules', path: 'workflows.rules', title: 'Workflow rule definitions', group: 'lanes-my-prs',
    description: 'The rules My pull requests switches on and off: each names its repositories, one pull request event, its filters and its actions.',
    control: 'json', keywords: ['pull requests', 'automation', 'rules'], defaultValue: [], takesEffect: 'now',
    fileOnlyReason: 'Rule definitions are written in config.json; My pull requests only switches each rule on or off.', ...FILE_ONLY,
  },
  {
    id: 'file-pr-flows-sources', path: 'prFlows.sources', title: 'PR flows sources', group: 'lanes-my-prs',
    description: 'Commands that report review findings for your own pull requests, run without a shell on each new head once you approve the exact command in My PRs. Each entry has id, label, command (an argv array; {prUrl}, {repo}, {number} and {head} expand inside one argument, and GLIMMERVOID_PR_URL, GLIMMERVOID_PR_REPO, GLIMMERVOID_PR_NUMBER and GLIMMERVOID_PR_HEAD are set), timeoutSeconds and optional repos (owner/name; every repository when absent), and prints {"findings": [{"path", "lineStart", "lineEnd", "priority", "body", "url"}], "status": [{"label", "state"}]} JSON. Each id is unique within the list. Check entries with glimmervoid pr-flows check.',
    jsonSchema: z.toJSONSchema(z.array(PrFlowSourceCommand), { io: 'input' }),
    example: [{ id: 'scanner', label: 'Scanner', command: ['my-review-scanner', '--pr', '{prUrl}', '--json'], timeoutSeconds: 120 }],
    control: 'json', keywords: ['pull requests', 'review items', 'bots', 'commands'], defaultValue: [], takesEffect: 'now',
    fileOnlyReason: 'Commands run on this machine, so they are written in config.json and each one waits for your approval in My PRs.', ...FILE_ONLY,
  },
  {
    id: 'file-pr-flows-actions', path: 'prFlows.actions', title: 'PR flows actions', group: 'lanes-my-prs',
    description: 'Commands that act on a review item of your own pull request, shown as a button with their label and named by rules as run:<id>. Each entry has id, label, command and timeoutSeconds like a source, also expands {itemPath} and {itemLine}, gets the item as GLIMMERVOID_ITEM_JSON, waits for your approval in My PRs, and has an id unique within the list. Exit 0 is done and non-zero failed, unless stdout prints {"outcome": "done" | "started" | "refused" | "failed", "message"} JSON.',
    jsonSchema: z.toJSONSchema(z.array(PrFlowCommand), { io: 'input' }),
    example: [{ id: 'ask-bot', label: 'Ask bot', command: ['gh', 'pr', 'comment', '{prUrl}', '--body', '@review-bot fix {itemPath}:{itemLine}'] }],
    control: 'json', keywords: ['pull requests', 'review items', 'commands'], defaultValue: [], takesEffect: 'now',
    fileOnlyReason: 'Commands run on this machine, so they are written in config.json and each one waits for your approval in My PRs.', ...FILE_ONLY,
  },
  {
    id: 'file-pr-flows-pr-actions', path: 'prFlows.prActions', title: 'PR flows PR actions', group: 'lanes-my-prs',
    description: 'Commands that act on a whole pull request of yours, shown as a button next to Keep mergeable and Merge when ready and run once per click, never by a rule. Each entry has id, label, command and timeoutSeconds like an action, plus optional repos (owner/name; every repository when absent), expands {headRef} and {baseRef} instead of the item placeholders, gets GLIMMERVOID_PR_HEAD_REF, GLIMMERVOID_PR_BASE_REF and the pull request as GLIMMERVOID_PR_JSON, and waits for your approval in My PRs. Exit 0 is done and non-zero failed, unless stdout prints {"outcome": "done" | "started" | "refused" | "failed", "message"} JSON.',
    jsonSchema: z.toJSONSchema(z.array(PrFlowPrAction), { io: 'input' }),
    example: [{ id: 'agent-merge', label: 'Merge via agent', repos: ['acme/app'], command: ['my-merge-trigger', '{prUrl}', '{headRef}'], timeoutSeconds: 60 }],
    control: 'json', keywords: ['pull requests', 'buttons', 'commands', 'merge'], defaultValue: [], takesEffect: 'now',
    fileOnlyReason: 'Commands run on this machine, so they are written in config.json and each one waits for your approval in My PRs.', ...FILE_ONLY,
  },
  {
    id: 'file-packs', path: 'packs', title: 'Packs', group: 'machine-packs',
    description: 'More pack directories to load besides every directory under ~/.glimmervoid/packs/. A pack is a pack.json (name, version, description, requires, and sections such as prFlows with prActions, sources, actions, rules and a repos default for them) plus the files it uses, shared by copying the directory; its commands can use {packDir}, its ids show as <pack>/<id>, and it waits for one approval in the Packs tab that any edit to a file in it asks again.',
    control: 'list', keywords: ['packs', 'share', 'plugins', 'pull requests', 'commands'], defaultValue: [], takesEffect: 'now',
    fileOnlyReason: 'A pack can run commands on this machine, so its directory is written in config.json and the pack waits for your approval.', ...FILE_ONLY,
  },
  {
    id: 'file-pr-flows-rules', path: 'prFlows.rules', title: 'PR flows rules', group: 'lanes-my-prs',
    description: 'Ordered rules for review items on your own pull requests; the first match acts with no click and lands in the Handled list, where Undo reopens it. Each matches on sources (source ids, <pack>/<id> for a pack source), authors (GitHub logins of review comment authors), priority, paths, text, scope and repos (owner/name; every repository when absent), and acts with ask, fix-local, dismiss or run:<action id>.',
    jsonSchema: prFlowRulesJsonSchema(z.array(PrFlowRule)),
    example: [{ name: 'Generated files', paths: ['dist/'], action: 'dismiss', reason: 'Generated output; the source change is reviewed instead.' }, { name: 'Bot nits', authors: ['review-bot[bot]'], priority: ['low'], repos: ['acme/app'], action: 'run:ask-bot' }],
    control: 'json', keywords: ['pull requests', 'review items', 'dismiss', 'automation'], defaultValue: [], takesEffect: 'now',
    fileOnlyReason: 'Rules are written in config.json; Save as rule in My PRs is the one dashboard writer, and it only appends.', ...FILE_ONLY,
  },
  {
    id: 'file-pr-flows-repo-rules', path: 'prFlows.repoRules', title: 'PR flows repository rules', group: 'lanes-my-prs',
    description: 'Deprecated: put repos on each rule in prFlows.rules instead. Rules per repository (owner/name to a list of rules), still checked before prFlows.rules for that repository.',
    jsonSchema: prFlowRulesJsonSchema(z.record(z.string(), z.array(PrFlowRule))),
    example: { 'acme/app': [{ name: 'Docs typos', paths: ['docs/'], text: 'typo', action: 'fix-local' }] },
    control: 'json', keywords: ['pull requests', 'review items', 'repositories'], defaultValue: {}, takesEffect: 'now', fileOnlyReason: STRUCTURED_VALUE, ...FILE_ONLY,
  },
  {
    id: 'file-question-manager-rules', path: 'questionManager.rules', title: 'Question manager rules', group: 'lanes-question-manager',
    description: 'Rules the question manager answers from. An object with name, question (text the question contains) and pick (the exact option labels to choose) answers at once. A plain sentence is a rule a model applies when no object matches; it must cite one rule and pick exact option labels within 60 seconds, or the question comes to you. A question with a risk word such as push, delete or deploy always comes to you.',
    jsonSchema: z.toJSONSchema(z.array(QuestionRule), { io: 'input' }),
    example: [{ name: 'README length', question: 'README', pick: ['Short'] }, 'Prefer the existing library over adding a dependency.'],
    control: 'json', keywords: ['questions', 'rules', 'automation'], defaultValue: [], takesEffect: 'now', fileOnlyReason: STRUCTURED_VALUE, ...FILE_ONLY,
  },
  {
    id: 'file-question-manager-model', path: 'questionManager.model', title: 'Question manager model', group: 'lanes-question-manager',
    description: 'Claude model alias that applies the plain-language question manager rules.',
    control: 'text', keywords: ['questions', 'rules', 'model'], defaultValue: DEFAULT_MODELS.questionManager, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
]);
