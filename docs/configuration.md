# Configuration reference

Every setting, config key and environment variable Glimmervoid reads. Generated from the code by `npm run docs:config`, so do not edit it by hand.

## Where the config lives

Glimmervoid uses `~/.glimmervoid/config.json`, creating it with defaults on first run. `GLIMMERVOID_HOME` moves that directory, and `GLIMMERVOID_CONFIG` (or `--config <path>`) points at another file, which must exist.

## Changing a setting

Use the dashboard Settings view, `glimmervoid settings set <key> <value>`, or edit `config.json` directly; the server reloads it on save. Rows marked **File-only** are not in the Settings view, though its search still finds them and shows their key.

Settings in `config.json` apply to this machine. A change to a setting in the tables below takes effect at once unless its row says it applies to new sessions or needs a server restart.

A block key such as `posthog` accepts more nested keys than listed here; `shared/contracts/config.ts` is the full schema.

## Settings

### Telegram

One bot shared by session, PR review and PostHog notifications.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `telegram.botToken` | Bot token | `""` | Credential used by the shared Telegram bot. Create a bot by messaging @BotFather in Telegram and sending /newbot; it replies with this token. When GLIMMERVOID_TELEGRAM_BOT_TOKEN supplies it, this field is read-only. |
| `telegram.chatId` | Chat id | `""` | Destination chat for enabled Telegram lanes. Send your bot any message, then open https://api.telegram.org/bot<token>/getUpdates in a browser and copy the number under message.chat.id. |
| `telegramNotifications` | Send session notifications | `false` | Send session completion, input and failure alerts when no dashboard is open. Unacknowledged alerts also escalate after the phone escalation delay while a dashboard remains open. |

### Sessions

How sessions start, where projects are found, and what the dashboard shows for them.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `autoResume` | Auto-resume sessions on startup | `true` | Resume conversations that were live when Glimmervoid last shut down or crashed, and tell sessions that were mid-turn, or had a background agent, monitor or scheduled wakeup in flight, to continue. |
| `conversationView` | Conversation view (experimental) | `false` | Let each Claude Code and Codex session turn on a Conversation face from its card menu, which renders the transcript as messages, approvals and a composer. Sessions stay on the terminal until you turn it on for them. A Claude Code session started while this is on can answer its permission prompts and questions there. A Codex session connects on its next start, through a local app-server so approvals can be answered from the dashboard; guarded Codex sessions and those that bypass Codex hook trust keep the terminal only. |
| `viewTabOrder` | Tab order | `[]` | The order of the dashboard tabs in every browser: the header on desktop and the More menu on a phone. You can also drag a tab in the desktop header. |
| `remoteSessions` | Remote Coder sessions (experimental) | `false` | Offer the Coder environments in config.json when adding a session, so the session runs in its own Coder workspace instead of on this machine. Off refuses new remote sessions; ones already running keep working until closed. |
| `streamerMode` | Streamer mode | `false` | Hide sensitive details in the dashboard while screen sharing or streaming. |
| `repoRoots` | Repository roots | `[]` | Directories scanned for projects when adding sessions. |
| `debugMode` | Debug mode | `false` | Show session-card diagnostics for state, transitions and detection signals. **File-only.** A diagnostic switch kept out of the Settings view; change it in config.json while investigating. |
| `sessionMemoryReserveMB` | Session memory reserve | `600` | Free memory an automatic session start waits for; 0 starts sessions without checking. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

### Guardrails and unattended

What a guarded session may touch, and which unattended actions automated work may take. Claude Code sessions on Linux and macOS write anywhere this account can, except credentials, Glimmervoid's own state and the blocked folders here.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `skipPermissionsByDefault` | Skip permission prompts by default | `false` | Start sessions whose project sets no permission choice with the agent CLI permission bypass flag. |
| `saneYolo` | Sane YOLO | `true` | Block catastrophic commands in sessions that skip permission prompts when the cc-safety-net executable is available and trusted hooks are installed. Missing or untrusted hooks leave a session unprotected. Applies to new sessions. |
| `rtk` | rtk output compression | `false` | Compress Bash output with the rtk executable. Applies to new sessions. |
| `postTurnChecks.mode` | Post-turn checks mode | `"report"` | Default mode for post-turn checks. Project and individual rule modes override it, so Report can still allow file fixes. |
| `branchGc.deleteUnmerged` | Delete unmerged branches | `false` | Also delete stale remote branches with no merge proof. Off keeps every unmerged branch. |
| `guardrails.unguardedRepos` | Unguarded repositories | `[]` | Folders whose sessions run without guardrails. A session started in one of these folders, or below it, is not guarded. Applies to new sessions. |
| `guardrails.blockedPaths` | Blocked folders | `[]` | Extra folders and files a guarded session cannot write, on top of credentials and Glimmervoid's own state. A leading ~ means the home folder. Applies to new sessions. |
| `guardrails.unreadablePaths` | Unreadable folders | `[]` | Extra folders and files a guarded session cannot read, on top of the built-in credential list. A leading ~ means the home folder. Applies to new sessions. |

### Updates

See which Glimmervoid version is running, which one is newest, and update in one step.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `updateChannel` | Channel | `"release"` | Track tagged releases or the upstream of the checked-out branch. |
| `checkForUpdates` | Check for updates automatically | `true` | Check for a newer Glimmervoid at launch, while a dashboard is connected, and when this page opens. |

### Usage

Local transcript accounting and estimated-cost budgets.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `usage.enabled` | Track token usage | `true` | Read local CLI transcripts and roll them into the Usage view and session chips. |
| `usage.retainDays` | Retain transcript detail | `90` | How long live transcript detail stays available. A monthly budget keeps detail from the start of the current month when that is longer. |
| `usage.budget.dailyUsd` | Daily budget | `null` | Estimated daily spend alert threshold. Alerts at 50%, 75% and 100% do not stop spending. Zero or below disables the threshold. |
| `usage.budget.monthlyUsd` | Monthly budget | `null` | Estimated monthly spend alert threshold. Alerts at 50%, 75% and 100% do not stop spending. Zero or below disables the threshold. |
| `usage.vendors.codex` | Track Codex usage | `true` | Include local Codex CLI transcripts in usage reports. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.vendors.grok` | Track Grok usage | `true` | Include local Grok CLI transcripts in usage reports. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.fetchPricing` | Fetch current model prices | `true` | Load public model prices when usage tracking starts, using a cached table for up to one day. Falls back to cached or bundled prices if the fetch fails; no daily refresh runs while tracking continues. Needs a server restart. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.planLimits` | Show plan limits | `true` | Read the Claude plan limit the CLI reports and show it beside usage. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.rtkSavings` | Estimate rtk savings | `true` | Estimate the tokens rtk output compression saved and show it in the Usage view. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.scanIntervalMinutes` | Scan interval | `5` | Periodic transcript polling interval. Session activity can also trigger scans between timer ticks. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.warehouseRetainDays` | Retain usage history | `365` | How long the daily usage warehouse keeps rolled-up totals after transcript detail expires. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.sessionBlockHours` | Session block length | `5` | Length of the rolling block the Usage view groups activity into. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.costMode` | Cost mode | `"auto"` | Choose whether recorded costs, calculated costs or both can appear. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.extraProjectsDirs` | Extra transcript folders | `[]` | Absolute paths of additional Claude projects folders the usage scan reads. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

### Visions

Editor-buffer findings, bounded model comments, and the machine-context ingest behind them.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `visions.enabled` | Enable Visions | `false` | Set up supported editors detected on this machine, then show their buffer findings in the Visions view. |
| `visions.dispatch.enabled` | Enable model comments | `false` | Start bounded review sessions for local editor buffers. |
| `visions.dispatch.maxPerHour` | Max per hour | `6` | Maximum review sessions dispatched per hour. One slot is reserved for edit reviews; activity-driven reviews take the rest, up to the activity cap set by visions.dispatch.activityMaxPerHour. |
| `visions.dispatch.model` | Model override | `""` | Leave blank to use the opus model alias. |
| `visions.projects` | Projects | `[]` | Clear every selection, including unavailable projects, to accept buffers from every configured project. |
| `visions.autoFix` | Apply tier 1 fixes | `false` | Allow Visions to edit eligible open Markdown buffers, including inactive buffers, without asking. |
| `ingest.enabled` | Enable machine context ingest | `false` | Enable the local activity feed behind Visions. Turning Visions on enables ingest unless ingest.enabled is explicitly false. |
| `visions.dispatch.quietMs` | Quiet delay | `30000` | Editor quiet time before a scheduled review. Saves and blank-line boundaries can dispatch immediately, subject to the other review limits. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `visions.dispatch.cooldownMs` | Cooldown | `300000` | Minimum delay between reviews of the same document. Initial orientation reviews bypass this delay. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `visions.dispatch.activityMaxPerHour` | Activity max per hour | `2` | Maximum activity-driven reviews dispatched per hour, capped at the overall hourly limit minus one to reserve an edit-review slot. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `visions.dispatch.dispatchTimeoutSeconds` | Dispatch timeout | `180` | Maximum time allowed for one review session. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `visions.intent.threadTtlMs` | Intent thread lifetime | `259200000` | How long an intent thread nobody advanced stays live before it retires. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

### PostHog

Error monitoring, investigations and traffic-spike alerts.

The PostHog lane only starts when `posthog.host`, `posthog.apiKey`, `telegram.botToken` and `telegram.chatId` are all set: its alerts go to Telegram, so configure the Telegram section first.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `posthog.enabled` | Enable PostHog monitoring | `false` | Poll PostHog error tracking and investigate issues that move. |
| `posthog.host` | Host | `"https://us.posthog.com"` | PostHog cloud or self-hosted HTTP URL. |
| `posthog.apiKey` | Personal API key | `""` | Credential with read access to PostHog projects. When GLIMMERVOID_POSTHOG_API_KEY supplies it, this field is read-only. |
| `posthog.projects` | Projects | `"all"` | PostHog project ids to monitor. config.json holds "all" or an array of ids, and an empty array monitors no project. In Settings that empty array shows as none, and an empty list saves "all". |
| `posthog.intervalMinutes` | Poll interval | `15` | Delay between PostHog polling passes. |
| `posthog.maxConcurrentInvestigations` | Max concurrent investigations | `2` | Maximum investigation sessions running together. |
| `posthog.minUsersToInvestigate` | Min users to investigate | `1` | Minimum affected users for a new issue investigation. Regressions, worsening issues and eligible error spikes bypass this minimum. |
| `posthog.trafficSpikeEnabled` | Traffic spike alerts | `true` | Ping when recent unique users exceed a project baseline. |
| `posthog.autoFix` | Attempt fixes for major issues | `false` | Allow an isolated agent to fix an issue, push a branch and open a pull request. |
| `posthog.investigationTimeoutSeconds` | Investigation timeout | `900` | Maximum time allowed for one investigation. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.userEscalationThreshold` | Escalation threshold | `25` | Affected-user count that escalates an issue. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.fixTimeoutSeconds` | Fix timeout | `1800` | Maximum time allowed for one fix session. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.trafficSpikeMultiplier` | Spike multiplier | `3` | Baseline multiplier required to classify a traffic spike. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.trafficSpikeMinUsers` | Min users to alert | `10` | Minimum recent unique users for an initial traffic-spike alert. Escalation and recovery alerts bypass this minimum. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.trafficSpikeCooldownMinutes` | Spike cooldown | `360` | Cooldown for new traffic spikes. Escalation and recovery alerts bypass it. Zero removes the time delay; repeated active-spike alerts are still suppressed. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.trafficSpikeBaselineDays` | Baseline window | `7` | Historical window used to calculate normal hourly traffic. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.recurrenceDedupe` | Deduplicate recurring issues | `true` | Treat an issue seen again inside the recurrence window as the same investigation instead of opening a new one. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.recurrenceWindowDays` | Recurrence window | `7` | How far back an issue counts as a recurrence of an investigated one. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.transientRecurrenceLimit` | Transient recurrence limit | `3` | How many times a transient issue may recur before it is investigated again. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.repoPath` | Repository path | `""` | Absolute path of the local checkout investigations read and fixes branch from, for every project the project map does not name. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.projectMap` | Project map | `{}` | PostHog project id to a label: the name shown for that project, and, when it is an absolute path to a checkout, the repository its issues are investigated in. **File-only.** A structured value with no dashboard control; edit it in config.json. |

### Team review

Draft reviews of teammates' pull requests for you to post from the Reviews tab.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `teamReview.enabled` | Enable team review | `false` | Poll open pull requests from the team and draft a review of each one. Nothing is posted until you choose Approve or Comment. |
| `github.teams` | GitHub teams | `[]` | Teams to search for review requests and members, one org/slug per entry. Leave empty to fall back to the legacy teamReview.org and teamReview.team keys in config.json. |
| `teamReview.reReviewAfterHours` | Re-review after | `24` | When a reviewed PR has a new head, review it again after this long since its last review. Re-run review runs it at any time. |
| `teamReview.skipIdleAfterDays` | Skip PRs idle for | `14` | Leave pull requests without GitHub activity for this long out of automatic review. |
| `teamReview.skill` | Review skill | `""` | Name of a Claude Code skill installed for the review agent, for example your own PR review skill. Leave empty to let the agent review with whatever skills it has. |
| `teamReview.autoRebaseMyPrs` | Keep my pull requests rebased | `false` | On each poll, rebase your open, non-draft pull requests that are behind their base branch. A pull request with conflicts or checks still running is left alone, and a failed rebase is not retried until you push again. |
| `teamReview.keepMergeableEnabled` | Keep mergeable | `true` | Offer Keep mergeable on your pull requests: a guarded agent repairs conflicts and failing checks and pushes the repair. Off hides the control and starts no repair; the pull requests you chose stay chosen for when you turn it back on. |
| `teamReview.keepMergeableTimeoutMinutes` | Keep mergeable deadline | `30` | Longest a Keep mergeable repair session may run before it is stopped and nothing is pushed. |
| `teamReview.mergeQueueEnabled` | Merge when ready | `true` | Offer Merge when ready on your pull requests: queued pull requests are rebased when behind and merged once ready, one per repository per poll. Off hides the control and merges nothing; the queue is kept for when you turn it back on. |
| `teamReview.org` | GitHub organization (legacy) | `""` | Organization login that owns the team, for example PostHog. Read only when github.teams is empty. **File-only.** A legacy key: github.teams names teams as org/slug entries and wins whenever it is set. |
| `teamReview.team` | GitHub team (legacy) | `""` | Team slug whose members and review requests are polled. Read only when github.teams is empty. **File-only.** A legacy key: github.teams names teams as org/slug entries and wins whenever it is set. |

### Workflows

Rules that act on pull request events in the repositories you choose.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `workflows.enabled` | Run workflows | `true` | Poll the repositories your enabled rules watch and run their actions. Off stops polling and every action, whatever each rule says. |
| `workflows.maxConcurrentSessions` | Concurrent agent sessions | `2` | Most workflow agent sessions running at once. Up to twenty later spawns wait for a free slot; additional spawns are dropped and logged. |
| `workflows.maxActionsPerPoll` | Actions per poll | `20` | Most actions run in one poll. The rest are dropped and logged. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `workflows.rules` | Workflow rule definitions | `[]` | The rules the Workflows section switches on and off: each names its repositories, one pull request event, its filters and its actions. **File-only.** Rule definitions are written in config.json; the Workflows section only switches each rule on or off. |

### Benchmarks

Compare agent setups on frozen cases from the suites in the benchmarks folder of the Glimmervoid home.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `benchmarks.enabled` | Enable benchmarks | `false` | Show the Bench tab. Nothing runs until you choose Mine or Run there. |

### Coherence (experimental)

Per-session Coherence hook status and decision journal for agent sessions.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `coherence.enabled` | Show session Coherence | `false` | Shows each session's Coherence hook status and decision journal when the repository installed @posthog/coherence 1.8 or newer. Off by default. |

### Privacy

What Glimmervoid sends about itself.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `telemetry.enabled` | Send usage data | `true` | Helps us improve Glimmervoid. Sent under a random install id: version, platform, app starts, daily activity, session starts and ends with agent kind, exit kind and duration, errors as their type, error code and scrubbed stack frames, per session token counts, models and estimated costs from the usage scan, and a salted one-way hash of your Claude and Codex account ids so installs of one account count together. Never prompts, project information, error messages, paths, repository or branch names, objectives, terminal output, emails or names. Delete my data asks for everything sent under this install to be erased and starts a new install id. GLIMMERVOID_TELEMETRY=0, DO_NOT_TRACK=1 or CI=true turn it off regardless. |

### Terminal

Terminal behavior shared by dashboard clients.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `replayBufferKB` | Replay buffer | `512` | PTY output retained for clients that reconnect or join late. Applies to new sessions. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `cursorBlink` | Cursor blink | `false` | Blink the cursor in every terminal. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

### Detection and sessions

Config-file-only detection, timing, worktree and process settings.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `detectBackgroundAgents` | Detect background agents | `true` | Hold completion while tracked background work is active. Applies to new sessions. **File-only.** A diagnostic switch kept out of the Settings view; change it in config.json while investigating. |
| `recordSignals` | Record structural signals | `true` | Keep forensic status and hook recordings for each session. Full capture (capture.enabled) records these signals even when this is off. Applies to new sessions. **File-only.** A diagnostic switch kept out of the Settings view; change it in config.json while investigating. |
| `trace.enabled` | Capture session traces | `true` | Keep normalized Claude transcript traces for session debugging. Needs a server restart. **File-only.** A diagnostic switch kept out of the Settings view; change it in config.json while investigating. |
| `detectScheduledWakeups` | Detect scheduled wakeups | `true` | Surface advisory wakeup timing for scheduled sessions. Needs a server restart. **File-only.** A diagnostic switch kept out of the Settings view; change it in config.json while investigating. |
| `worktreeAutoRebase` | Worktree auto-rebase | `true` | Rebase eligible session worktrees when the integration branch moves. Applies to new sessions. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktreeSyncOnStart` | Worktree sync on start | `true` | Fetch origin and fast-forward the local integration branch before a session starts its worktree. Applies to new sessions. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktreeRerere` | Worktree rerere | `true` | Reuse recorded Git conflict resolutions. Needs a server restart. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `integrationBranch` | Integration branch | `null` | Base branch for session worktrees. Empty = each repo's default branch. Existing sessions are never retargeted. Applies to new sessions. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktreeRoot` | Worktree root | `""` | Directory that contains session worktrees. Existing worktrees are never relocated. Applies to new sessions. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktreeShare` | Shared worktree paths | `["node_modules",".env",".env.local",".claude"]` | Local paths copied or linked during worktree preparation. Applies to new sessions. **File-only.** Never editable from the dashboard by rule; edit it in config.json. |
| `port` | Local port | `3000` | Port used by the local dashboard listener. Needs a server restart. **File-only.** Never editable from the dashboard by rule; edit it in config.json. |
| `notifyDebounceMs` | Notification debounce | `3000` | Delay used to coalesce notification state changes. Applies to new sessions. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `phoneEscalationMs` | Phone escalation delay | `300000` | Delay before off-dashboard escalation. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `postTurnChecks` | Post-turn checks | `{"enabled":true,"mode":"report","rules":{"trailingWs":true,"finalNewline":true,"bom":true,"slop":false}}` | Deterministic checks run after eligible turns. The global mode is a default; project and individual rule modes can select fixes even when the global mode is report. **File-only.** A structured value with no dashboard control; edit it in config.json. |
| `branchGc.enabled` | Branch cleanup | `true` | Enable cleanup of eligible session branches. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `branchGc.worktrees` | Local worktree cleanup | `true` | Enable cleanup of eligible local worktrees. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `branchGc.prefixes` | Branch cleanup prefixes | `["glimmervoid/session/","worktree-agent-"]` | Branch prefixes that filter both remote branch cleanup and local worktree cleanup. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `branchGc.dryRun` | Branch cleanup dry run | `false` | Report planned cleanup without deleting remote branches. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `branchGc.staleDays` | Branch stale days | `14` | Age threshold for orphan branch cleanup when unmerged deletion is on. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `branchGc.intervalMs` | Branch cleanup interval | `21600000` | Delay between branch cleanup passes. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `customAgents` | Custom agents | `[]` | Extra agent CLIs a session can be spawned with. The Sessions section lists the declared agents and whether each command resolves. Applies to new sessions. **File-only.** Never editable from the dashboard by rule; edit it in config.json. |
| `taskTitle.refiner.enabled` | Refine task titles | `true` | Keep session card titles useful when prompts change topic by asking a model for a short title. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `taskTitle.refiner.model` | Task title model | `"haiku"` | Claude model alias the title refiner asks. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `taskTitle.refiner.minIntervalSeconds` | Task title refresh interval | `60` | Shortest pause between two title refinements of one session. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `taskTitle.refiner.timeoutSeconds` | Task title timeout | `60` | Maximum time allowed for one title refinement. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

### Ingest

The machine-context sources behind Visions.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `ingest.sources.terminal.enabled` | Terminal output source | `false` | Include terminal output in the ingest feed. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `ingest.sources.agentLogs.enabled` | Agent logs source | `false` | Include local agent logs in the ingest feed. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `ingest.sources.git.enabled` | Git activity source | `false` | Include local Git activity in the ingest feed. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `ingest.sources.fs.enabled` | File changes source | `false` | Include watched file changes in the ingest feed. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `ingest.sources.shellHistory.enabled` | Shell history source | `false` | Include local shell history in the ingest feed. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `ingest.sources.editor.enabled` | Editor events source | `false` | Include local editor events in the ingest feed. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

## Keys outside the Settings view

Edit these in `config.json` unless the note names another dashboard surface.

| Key | Default | Notes |
|-----|---------|-------|
| `coder` |  | Set `coder.appSlug` to an existing `coder_app` slug on the workspace agent to prevent Coder autostop while Glimmervoid sessions are running. Requires `CODER_AGENT_URL` and `CODER_AGENT_TOKEN` (or `CODER_AGENT_TOKEN_FILE`) in the environment; Coder supplies them when started from a workspace terminal or startup script. |
| `planReview` | `{"enabled":true}` | Hold Claude Code plan approvals (`ExitPlanMode`) so the plan can be read and approved from the dashboard or phone (`planReview.enabled`). |
| `hooks` |  | Operator-defined hooks per project, managed from the dashboard Hooks panel. |
| `remote` | `{"enabled":false,"port":null,"publicHost":"","allowedOrigins":[]}` | Opt-in remote listener: `enabled`, `port` (required when enabled, must differ from the local port), `publicHost`, `allowedOrigins` and `ownerLogin` (when set, only that Tailscale login is answered; trustworthy only when the remote port is reached solely through HTTP-mode `tailscale serve`, since any other proxy, or `tailscale serve --tcp` or `--tls-terminated-tcp`, lets a client send its own `Tailscale-User-Login`). Needs a server restart. See [Remote access](../README.md#remote-access). |
| `projects` | `[]` | Projects shown in the dashboard, added from the Add Session dialog. Each entry has `path` (required), optional `name`, `repos` (two or more member repositories for a workspace session), `baseBranch` (the branch sessions of this project start from and merge back into, set by Open in session on a team review pull request), `agent` (an agent id, see `customAgents`), `codexBypassHookTrust` (file-only, default off), `conversationView` (set from the card menu while the Conversation view setting is on, default off). |

## Environment variables

Rows marked internal are set by Glimmervoid itself for its child processes; they are listed so nothing it reads is undocumented.

| Variable | Audience | Effect |
|----------|----------|--------|
| `GLIMMERVOID_HOME` | operator | Directory holding `config.json` and all machine state (pairings, recordings). Defaults to `~/.glimmervoid`. |
| `GLIMMERVOID_CONFIG` | operator | Path to the config file, winning over `GLIMMERVOID_HOME`. The file must exist or the server exits with `Config file not found`. `--config <path>` sets it. |
| `GLIMMERVOID_PORT` | operator | Local dashboard port, overriding `port` in `config.json`. `--port <number>` sets it. The Visions relay also reads it to find the server. |
| `GLIMMERVOID_HOST` | operator | Bind address for both listeners. Defaults to `127.0.0.1`; any non-loopback value is refused unless `GLIMMERVOID_INSECURE_BIND=1`. |
| `GLIMMERVOID_INSECURE_BIND` | operator | Set to `1` to allow a non-loopback `GLIMMERVOID_HOST`. The local listener has no authentication, so this exposes full control of the machine to anyone who can reach the port. |
| `GLIMMERVOID_POSTHOG_API_KEY` | operator | Supplies `posthog.apiKey`, overriding the stored value. It is stripped from every write, so a dashboard save never persists it. |
| `GLIMMERVOID_TELEGRAM_BOT_TOKEN` | operator | Supplies `telegram.botToken`, overriding the stored value. It is stripped from every write, so a dashboard save never persists it. |
| `GLIMMERVOID_CLAUDE_OAUTH_TOKEN` | operator | A long-lived Claude Code token (`claude setup-token`) that benchmark arms authenticate with instead of the login token Glimmervoid reads from the keychain or `~/.claude/.credentials.json`. Passed only to benchmark sessions, never stored. |
| `GLIMMERVOID_TELEMETRY` | operator | Set to `0` to turn off usage and error telemetry (error type, error code and scrubbed stack frames, never messages or paths) whatever `telemetry.enabled` says. `DO_NOT_TRACK=1` and `CI=true` turn it off too. |
| `GLIMMERVOID_TELEMETRY_PROJECT_TOKEN` | internal | Sends telemetry to another PostHog project instead of the Glimmervoid one, so end-to-end checks of a development build stay out of real usage data. Not an operator setting. |
| `GLIMMERVOID_DEBUG_SPAWN` | operator | Any non-empty value logs which executable each agent command resolved to at spawn. |
| `GLIMMERVOID_SANE_YOLO_PATH` | internal | Names the Sane YOLO binary only in supervised sessions, so an installed Grok hook stays inert outside Glimmervoid. Not an operator setting. |
| `GLIMMERVOID_RTK_PATH` | internal | Set by Glimmervoid in the rtk hook relay environment to name the rtk binary. Not an operator setting. |
| `GLIMMERVOID_HOOK_URL` | internal | Set by Glimmervoid in each session environment as the hook relay target. Not an operator setting. |
| `GLIMMERVOID_AGENT_URL` | internal | Set by Glimmervoid in each session environment; `glimmervoid push`, `spawn`, `attention` and `board` read it. Not an operator setting. |
| `GLIMMERVOID_CODEX_REMOTE_TOKEN` | internal | Set by Glimmervoid in the environment of a Codex session that runs through its local app-server (Conversation view); the Codex TUI sends it as the bearer token to that app-server. Not an operator setting. |
| `GLIMMERVOID_SIGN_URL` | internal | Set by Glimmervoid in each operator session environment; `glimmervoid ssh-sign`, which git runs to sign a commit, posts there so the server signs with the operator's forwarded ssh agent. Not an operator setting. |
| `GLIMMERVOID_HOOK_VIA_GUARDRAILS_PROXY` | internal | Set by Glimmervoid inside guardrails whose network is a domain list, so the hook relays post through the guardrails proxy and nowhere else. Not an operator setting. |

## Telemetry

Glimmervoid sends usage and error events to its own PostHog project, under a random install id kept in `telemetry.json` in the Glimmervoid home (`~/.glimmervoid`, or `$GLIMMERVOID_HOME`). That id gets a PostHog person profile, which `app_started` and `app_active` fill with the first version, platform and install flavor seen, plus a salted one-way hash of the Claude Code account id and the Codex user id when logged in; never the ids themselves, an email, a name or a token. Nothing names a path, repository, branch, session, prompt, error message or terminal output. A crash is kept in `telemetry-pending-crash.json` beside it until the next start sends it, or deletes it unsent when telemetry is off. It prints a notice once on first start. Turn it off with `telemetry.enabled`, `GLIMMERVOID_TELEMETRY=0`, `DO_NOT_TRACK=1` or `CI=true`.

At start and once a day it also asks PostHog for the `telemetry-enabled` flag for its install id. It also checks when telemetry is turned back on. Once that flag comes back disabled it sends nothing, across restarts too, until a later check returns it enabled; a failed check or a missing flag changes nothing. The maintainers stop all sending by setting the flag's rollout to 0%; deactivating or deleting the flag does not stop installs, because PostHog then leaves it out of the answer. That request is skipped whenever telemetry is off.

Every event also carries `app_version`, `os_platform`, `node_major`, `install_flavor`, `is_bundled`, `is_dev_install`, where `is_dev_install` is true for a git clone, a source checkout or a Glimmervoid home other than `~/.glimmervoid`, plus `$release_id` on a published build linked to its PostHog release.

| Event | Properties | When |
|-------|------------|------|
| `app_started` | `is_first_start`, `$set`, `$set_once` | The server started listening, and whether this is the first start, with no Glimmervoid config file yet. Also sets the person properties: a one-way hash of the Claude Code account id and the Codex user id when logged in, and the first version, platform and install flavor seen. |
| `app_active` | `active_session_count`, `$set`, `$set_once` | Once a day while the server runs, with how many sessions are live, and the same person properties as app_started. |
| `session_started` | `adapter` | A session spawned, with which kind of agent (any custom agent counts as `custom`). |
| `session_ended` | `adapter`, `exit_kind`, `duration_seconds` | A session ended: how it exited, or that it was removed, replaced by a settings change or stopped with the server, and how long it ran, in whole seconds. |
| `$exception` | `$exception_list`, `$exception_level` | An error in the server or the dashboard: its type, an error code when it has one, and stack frames with file paths cut to the package or URL path. Never the error message. Each distinct error is sent once per run, and a crash is sent on the next start. |
| `$ai_generation` | `$ai_trace_id`, `$ai_provider`, `$ai_model`, `$ai_input_tokens`, `$ai_output_tokens`, `$ai_cache_read_input_tokens`, `$ai_cache_creation_input_tokens`, `$ai_total_cost_usd`, `agent_adapter` | Per agent session and model, after each usage scan, for usage recorded in the last 24 hours: token counts, the model name and estimated cost, under a one-way hash of the session. A model name outside the shipped pricing table is sent as unknown. No prompts or output. |
| `view_shown` | `view` | A dashboard tab opened, on desktop or phone, with which tab. Sent on every open. |
| `operator_action` | `surface`, `action` | An action taken in the Usage, Issues, Radar or Reviews tab or the first-run checklist: which tab and which action, from a fixed list. Never which repository, pull request, issue or session it was taken on. |
| `onboarding_step` | `step`, `state` | The first-run checklist moved a step to current or done, with which step. Sent once per change while the page is open. |
| `team_review_drafted` | `inline_comment_count` | A team review draft became ready, with how many inline comments it drafted. |
| `team_review_settled` | `duration_ms`, `outcome`, `drafted_comment_count`, `posted_comment_count` | A team review draft was posted (approve, comment or approve-only) or discarded, with how many inline comments were drafted and how many were posted, plus the total action duration in milliseconds. |
| `team_review_post_refused` | `duration_ms`, `reason` | Posting a team review was refused, with a reason from a fixed list and the total action duration in milliseconds. Never the error text. |
| `radar_investigation_finished` | `verdict`, `mode`, `error_reason` | A Radar investigation or fix run finished, with its verdict and mode, plus a reason from a fixed list when it ended in ERROR. Never the summary text. |
| `radar_fix_handoff_failed` | `step` | Handing a Radar fix over as a pull request failed, with which step failed. Never the branch or the error text. |
| `data_deletion_requested` | none | Delete my data was confirmed in Settings > Privacy, with no properties. Sent under the old install id even when telemetry is off, unless the maintainers stopped all sending, and then the install id is replaced. PostHog deletes the person and every event under that id on receipt. |

## Browser preferences

Stored in each browser, not in `config.json`, so every device keeps its own. Change them in Settings.

| Setting | Default | Notes |
|---------|---------|-------|
| Theme | `"phyrexian"` | Color scheme for the dashboard. |
| Show usage on session cards | `false` | Shows each card's transcript token count and CLI-reported cost when available, otherwise a calculated API list-price estimate. |
| Swipe arrow pad on phone (experimental) | `false` | Replace the four arrow keys above the phone keyboard with one pad: swipe on it to send arrow keys, one per short drag. |
| Flying animals | `false` | Show animated animals flying across the dashboard. |
| Time between flights: minimum | `20` | Shortest pause between flights. |
| Time between flights: maximum | `40` | Longest pause between flights. |
| Flight duration: minimum | `6.9` | Shortest flight, for faster animals. |
| Flight duration: maximum | `11.5` | Longest flight, for slower animals. |
| Size multiplier | `1` | Scale applied on top of the viewport size. |
| Show on phone layout | `true` | Allow flights on the phone layout. |
| Alert sounds | `true` | Play sounds when a session needs attention and when a merge celebration plays. The same switch as the note button in the desktop header. |
| Alert sound | `"chime"` | Sound played when a session needs attention. Your own .ogg, .mp3, .wav, .m4a or .webm files dropped into the sounds folder of the Glimmervoid home (~/.glimmervoid/sounds/, or $GLIMMERVOID_HOME/sounds/) are listed after the built-in sounds. Glimmervoid never creates that folder, so make it yourself; new files show up the next time Settings opens. |
| Desktop notifications | `true` | Raise a browser notification when a session needs attention while this dashboard is in the background. |
| Jump to the next session needing you | `"KeyJ"` | The key held with Cmd on a Mac, or Alt elsewhere, that jumps to the next session needing you. Record a new one by pressing the whole shortcut. |
