import { z } from 'zod';
import { PrFlowCommand, PrFlowPrAction, PrFlowRule, PrFlowSourceCommand, prFlowRulesJsonSchema } from '../contracts/pr-flows.ts';
import { DEFAULT_QUESTION_RULES, QuestionRule } from '../contracts/question-manager.ts';

import {
  NON_NEGATIVE_NUMBER_RANGE,
  REACTION_COOLDOWN_MINUTES_RANGE,
  PORT_RANGE,
  POSITIVE_NUMBER_RANGE,
  MEMORY_RESERVE_MB_RANGE,
  WORKTREE_DISK_RESERVE_GB_RANGE,
  PACK_SCHEDULED_SESSIONS_DEFAULT,
  PACK_SCHEDULED_SESSIONS_RANGE,
  REPLAY_BUFFER_KB_RANGE,
  SPAWNED_SESSIONS_DEFAULT,
  SPAWNED_SESSIONS_RANGE,
  TASK_TITLE_TIMEOUT_RANGE,
  USAGE_INTEGER_RANGES,
  USAGE_RETAIN_DAYS_RANGE,
  USAGE_SCAN_INTERVAL_RANGE,
  WORKFLOWS_MAX_ACTIONS_PER_POLL_RANGE,
  WORKFLOWS_MAX_CONCURRENT_SESSIONS_RANGE,
} from '../settings-ranges.ts';
import { USAGE_COST_MODES } from '../usage-config.ts';
import { FILE_ONLY, INVESTIGATIONS, ACTIONS, SESSIONS, SECONDS, MINUTES, HOURS, DAYS, SECONDS_STORED_AS_MS, MINUTES_STORED_AS_MS, HOURS_STORED_AS_MS, USERS, TUNING_KNOB, DIAGNOSTIC, PROCESS_SETTING, STRUCTURED_VALUE, BY_RULE, capitalizedOptions } from './registry-fields.ts';
import type { SettingsSetting } from './registry-fields.ts';
import { DEFAULT_MODELS } from '../contracts/agent-models.ts';

export const FILE_ONLY_SETTINGS: readonly SettingsSetting[] = Object.freeze([
  {
    id: 'auto-resume', path: 'autoResume', title: 'Auto-resume sessions on startup', group: 'machine-sessions',
    description: 'Resume sessions that were live when Glimmervoid last stopped or crashed.',
    control: 'toggle', keywords: ['startup', 'conversation'], defaultValue: true, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'spawned-sessions-max', path: 'spawnedSessionsMax', title: 'Spawned sessions per session', group: 'machine-sessions',
    description: 'Most sessions one session may have spawned and live at once; a spawn past it is refused.',
    control: 'number', range: SPAWNED_SESSIONS_RANGE, unit: SESSIONS, keywords: ['spawn', 'children', 'child sessions', 'parallel', 'agent api'], defaultValue: SPAWNED_SESSIONS_DEFAULT, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'tab-order', path: 'viewTabOrder', title: 'Tab order', group: 'machine-sessions',
    description: 'Order of the dashboard tabs, set by dragging tabs in the header.',
    control: 'list', keywords: ['tabs', 'order', 'rearrange', 'reorder', 'header', 'more', 'menu'], defaultValue: [], takesEffect: 'now',
    fileOnlyReason: 'Set by dragging tabs in the header.', ...FILE_ONLY,
  },
  {
    id: 'session-review-model', path: 'sessionReview.model', title: 'Reviewer model', group: 'machine-session-review',
    description: 'Model name passed to the reviewer agent. Empty uses that agent default.',
    control: 'text', keywords: ['review', 'model'], defaultValue: '', takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
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
    id: 'file-worktree-disk-reserve', path: 'worktreeDiskReserveGB', title: 'Worktree disk reserve', group: 'machine-worktrees',
    description: 'Free disk space a new session worktree needs; below it the session is blocked and you are notified. 0 turns the check off.',
    control: 'number', range: WORKTREE_DISK_RESERVE_GB_RANGE, unit: { label: 'GB', storedPerDisplay: 1 }, keywords: ['disk', 'space', 'worktree'], defaultValue: 15,
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
    id: 'file-share-commit-provenance', path: 'shareCommitProvenance', title: 'Share commit provenance', group: 'machine-worktrees',
    description: 'After Merge pushes the base branch, also push the git notes that let glimmervoid why name the agent and session of a commit on any clone. The notes hold a hashed session id and the agent name, never a task or prompt. Off keeps them on this machine.',
    control: 'toggle', keywords: ['git', 'notes', 'why', 'privacy'], defaultValue: true, takesEffect: 'now', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-integration-branch', path: 'worktree.integrationBranch', title: 'Integration branch', group: 'machine-worktrees',
    description: "Base branch for session worktrees. Empty = each repo's default branch. Existing sessions are never retargeted.",
    control: 'text', nullable: true, keywords: ['git', 'merge'], defaultValue: null, takesEffect: 'new-sessions', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-worktree-root', path: 'worktree.root', title: 'Worktree root', group: 'machine-worktrees',
    description: 'Directory that contains session worktrees. Existing worktrees are never relocated.',
    control: 'text', keywords: ['git', 'directory'], defaultValue: '', takesEffect: 'new-sessions', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-agent-rules', path: 'agentRules.rules', title: 'Rules for every session', group: 'machine-detection-sessions',
    description: 'Rules every agent session receives with its Glimmervoid tools, whichever agent runs it, one string per rule, up to 40. Sessions started after a change read it.',
    control: 'list', keywords: ['rules', 'instructions', 'conventions', 'memory', 'agents.md'], defaultValue: [], takesEffect: 'new-sessions', fileOnlyReason: STRUCTURED_VALUE, ...FILE_ONLY,
  },  {
    id: 'file-reactions', path: 'reactions.reactions', title: 'Reactions', group: 'machine-detection-sessions',
    description: 'Up to 20 reactions, each {id, on, project?, action, text?}: on session-failed, session-done, needs-attention or commits-landed, action notify raises a note on the session card and wake types text into the session once idle.',
    control: 'json', keywords: ['reactions', 'automation', 'triggers', 'events', 'hooks'], defaultValue: [], takesEffect: 'now', fileOnlyReason: STRUCTURED_VALUE, ...FILE_ONLY,
  },
  {
    id: 'file-reactions-cooldown', path: 'reactions.cooldownMinutes', title: 'Reaction cooldown', group: 'machine-detection-sessions',
    description: 'How long one reaction waits before reacting to the same session again.',
    control: 'number', range: REACTION_COOLDOWN_MINUTES_RANGE, unit: MINUTES, keywords: ['reactions', 'cooldown'], defaultValue: 10, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },

  {
    id: 'file-worktree-share', path: 'worktree.share', title: 'Shared worktree paths', group: 'machine-worktrees',
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
    id: 'file-branch-gc-enabled', path: 'branchGc.enabled', title: 'Branch cleanup', group: 'machine-worktrees',
    description: 'Enable cleanup of eligible session branches.',
    control: 'toggle', keywords: ['git', 'cleanup'], defaultValue: true, takesEffect: 'now', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-branch-gc-worktrees', path: 'branchGc.worktrees', title: 'Local worktree cleanup', group: 'machine-worktrees',
    description: 'Enable cleanup of eligible local worktrees.',
    control: 'toggle', keywords: ['git', 'worktree', 'cleanup'], defaultValue: true, takesEffect: 'now', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-branch-gc-prefixes', path: 'branchGc.prefixes', title: 'Branch cleanup prefixes', group: 'machine-worktrees',
    description: 'Branch prefixes that filter both remote branch cleanup and local worktree cleanup.',
    control: 'list', keywords: ['git', 'branch'], defaultValue: ['glimmervoid/session/', 'worktree-agent-'], takesEffect: 'now', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-branch-gc-dry-run', path: 'branchGc.dryRun', title: 'Branch cleanup dry run', group: 'machine-worktrees',
    description: 'Report planned cleanup without deleting remote branches.',
    control: 'toggle', keywords: ['git', 'safety'], defaultValue: false, takesEffect: 'now', fileOnlyReason: PROCESS_SETTING, ...FILE_ONLY,
  },
  {
    id: 'file-branch-gc-stale-days', path: 'branchGc.staleDays', title: 'Branch stale days', group: 'machine-worktrees',
    description: 'Age threshold for orphan branch cleanup when unmerged deletion is on.',
    control: 'number', integer: false, step: 'any', range: POSITIVE_NUMBER_RANGE, unit: DAYS, keywords: ['git', 'retention'], defaultValue: 14, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-branch-gc-interval-ms', path: 'branchGc.intervalMs', title: 'Branch cleanup interval', group: 'machine-worktrees',
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
    id: 'usage-retain-days', path: 'usage.retainDays', title: 'Retain transcript detail', group: 'machine-usage',
    description: 'How long detailed usage is kept.',
    control: 'number', range: USAGE_RETAIN_DAYS_RANGE, unit: DAYS, keywords: ['history', 'retention'], defaultValue: 90, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
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
    id: 'file-usage-antigravity', path: 'usage.vendors.antigravity', title: 'Track Antigravity usage', group: 'machine-usage',
    description: 'Include local Antigravity CLI transcripts in usage reports.',
    control: 'toggle', keywords: ['google', 'agy', 'vendor'], defaultValue: true, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-usage-pi', path: 'usage.vendors.pi', title: 'Track pi usage', group: 'machine-usage',
    description: 'Include local pi session transcripts in usage reports.',
    control: 'toggle', keywords: ['pi', 'vendor'], defaultValue: true, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-usage-opencode', path: 'usage.vendors.opencode', title: 'Track OpenCode usage', group: 'machine-usage',
    description: 'Include local OpenCode SQLite usage records in usage reports.',
    control: 'toggle', keywords: ['opencode', 'vendor'], defaultValue: true, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
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
    id: 'posthog-max-investigations', path: 'posthog.maxConcurrentInvestigations', title: 'Max concurrent investigations', group: 'lanes-posthog',
    description: 'Most investigations running at once.',
    control: 'number', range: POSITIVE_NUMBER_RANGE, unit: INVESTIGATIONS, keywords: ['parallel', 'workers'], defaultValue: 2, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'posthog-min-users', path: 'posthog.minUsersToInvestigate', title: 'Min users to investigate', group: 'lanes-posthog',
    description: 'Fewest affected users before a new issue is investigated.',
    control: 'number', range: POSITIVE_NUMBER_RANGE, unit: USERS, keywords: ['threshold', 'affected'], defaultValue: 1, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
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
    id: 'team-review-re-review-after-hours', path: 'teamReview.reReviewAfterHours', title: 'Re-review after', group: 'lanes-team-review',
    description: 'Review a pull request again after a new push, once this much time has passed.',
    control: 'number', range: POSITIVE_NUMBER_RANGE, unit: HOURS, keywords: ['review', 'delay'], defaultValue: 24, integer: false, step: 0.5, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'team-review-skip-idle-after-days', path: 'teamReview.skipIdleAfterDays', title: 'Skip PRs idle for', group: 'lanes-team-review',
    description: 'Skip pull requests with no activity for this long.',
    control: 'number', range: POSITIVE_NUMBER_RANGE, unit: DAYS, keywords: ['idle', 'activity'], defaultValue: 14, integer: false, step: 0.5, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'team-review-extra-skills', path: 'teamReview.extraSkills', title: 'Skills the review skill calls', group: 'lanes-team-review',
    description: "Other skills the review skill may run, whose allowed-tools grants then apply to the review.",
    control: 'list', keywords: ['skill', 'sub-skill', 'claude code', 'pr review'], defaultValue: [], takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'team-review-reviewer-model', path: 'teamReview.reviewer.model', title: 'Review model', group: 'lanes-team-review',
    description: "Model for reviews, or the agent's default when empty.",
    control: 'text', keywords: ['model', 'reviewer'], defaultValue: '', takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'team-review-reviewer-effort', path: 'teamReview.reviewer.effort', title: 'Review effort', group: 'lanes-team-review',
    description: "Effort for reviews, or the agent's default when empty.",
    control: 'text', keywords: ['effort', 'thinking', 'reasoning', 'reviewer'], defaultValue: '', takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'team-review-stamp-reviewer-model', path: 'teamReview.stampReviewer.model', title: 'Docs and tests PR model', group: 'lanes-team-review',
    description: 'Model for pull requests that only touch docs and tests.',
    control: 'text', keywords: ['stamp', 'model', 'small pull requests', 'docs', 'tests'], defaultValue: '', takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'team-review-stamp-reviewer-effort', path: 'teamReview.stampReviewer.effort', title: 'Docs and tests PR effort', group: 'lanes-team-review',
    description: 'Effort for pull requests that only touch docs and tests.',
    control: 'text', keywords: ['stamp', 'effort', 'small pull requests', 'docs', 'tests'], defaultValue: '', takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
  {
    id: 'file-team-review-team', path: 'teamReview.team', title: 'GitHub team (legacy)', group: 'lanes-team-review',
    description: 'Team slug whose members and review requests are polled. Read only when github.teams is empty.',
    control: 'text', keywords: ['github', 'slug', 'legacy'], defaultValue: '', takesEffect: 'now',
    fileOnlyReason: 'A legacy key: github.teams names teams as org/slug entries and wins whenever it is set.', ...FILE_ONLY,
  },
  {
    id: 'workflows-max-concurrent-sessions', path: 'workflows.maxConcurrentSessions', title: 'Concurrent agent sessions', group: 'lanes-my-prs',
    description: 'Most workflow sessions running at once.',
    control: 'number', range: WORKFLOWS_MAX_CONCURRENT_SESSIONS_RANGE, unit: SESSIONS, keywords: ['parallel', 'spawn'], defaultValue: 2, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
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
    description: 'Rules the question manager answers from. The default rule, pick "recommended", picks the one option labeled (Recommended) on each question. An object with name, question (text the question contains) and pick (the exact option labels to choose) answers at once. A plain sentence is a rule a model applies when no object matches; it must cite one rule and pick exact option labels within 60 seconds, or the question comes to you. Your rules replace the default, so [] leaves nothing to answer. A question with a risk word such as push, delete or deploy always comes to you.',
    jsonSchema: z.toJSONSchema(z.array(QuestionRule), { io: 'input' }),
    example: [{ name: 'Take recommended', pick: 'recommended' }, { name: 'README length', question: 'README', pick: ['Short'] }, 'Prefer the existing library over adding a dependency.'],
    control: 'json', keywords: ['questions', 'rules', 'automation', 'recommended'], defaultValue: DEFAULT_QUESTION_RULES, takesEffect: 'now', fileOnlyReason: STRUCTURED_VALUE, ...FILE_ONLY,
  },
  {
    id: 'file-question-manager-model', path: 'questionManager.model', title: 'Question manager model', group: 'lanes-question-manager',
    description: 'Claude model alias that applies the plain-language question manager rules.',
    control: 'text', keywords: ['questions', 'rules', 'model'], defaultValue: DEFAULT_MODELS.questionManager, takesEffect: 'now', fileOnlyReason: TUNING_KNOB, ...FILE_ONLY,
  },
]);
