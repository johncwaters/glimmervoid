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

One bot for session, review and PostHog alerts.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `telegram.botToken` | Bot token | `""` | Token from @BotFather in Telegram (send /newbot). |
| `telegram.chatId` | Chat id | `""` | Chat the bot posts to, read as message.chat.id from its getUpdates page after you message it. |
| `telegramNotifications` | Send session notifications | `false` | Alert in Telegram when no dashboard is open, or when an alert sits unacknowledged. |

### Sessions

How sessions start, where projects are found, and branch cleanup.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `autoResume` | Auto-resume sessions on startup | `true` | Resume sessions that were live when Glimmervoid last stopped or crashed. |
| `viewTabOrder` | Tab order | `[]` | Order of the dashboard tabs, also set by dragging tabs in the header. |
| `streamerMode` | Streamer mode | `false` | Hide sensitive details while screen sharing. |
| `linkPreviews` | Link page previews | `true` | Resting the pointer on a terminal link for about 600 ms fetches that page from this machine to show its title and icon. Off, the link card shows the address only. |
| `repoRoots` | Repository roots | `[]` | Folders scanned for projects when adding a session. |
| `hiddenAgents` | Agents in Add Session | `[]` | Agents left out of the Add Session picker. Switch an agent off here to hide it; the default agent always stays. |
| `branchGc.deleteUnmerged` | Delete unmerged branches | `false` | Also delete stale remote branches with no proof they were merged. |
| `debugMode` | Debug mode | `false` | Show session-card diagnostics for state, transitions and detection signals. **File-only.** A diagnostic switch kept out of the Settings view; change it in config.json while investigating. |
| `sessionOrder` | Session order | `[]` | Order of sessions within each project in the sidebar and the phone Board, as session ids; a session not listed goes after the listed ones. **File-only.** Set by dragging sessions in the sidebar, or pressing and holding them on the phone Board. |
| `sessionMemoryReserveMB` | Session memory reserve | `600` | Free memory an automatic session start waits for; 0 starts sessions without checking. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

### Sane YOLO

What agents may do without asking, and what Sane YOLO blocks.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `skipPermissionsByDefault` | Skip permission prompts by default | `false` | Skip agent permission prompts for projects that set no choice. |
| `saneYolo` | Sane YOLO | `true` | Block catastrophic commands and credential reads in every session that supports it. Applies to new sessions. |
| `saneYoloUnreadablePaths` | Unreadable folders | `[]` | Extra files and folders agents may not read, where ~ is your home folder. Applies to new sessions. |

### Vault

Approved secrets, the vault companion, and the tokens Glimmervoid itself holds.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `github.readToken` | GitHub read token | `""` | Read-only fine-grained GitHub token lanes use for gh. Team review and community research need it. |
| `vault.host` | Vault companion address | `"127.0.0.1"` | Address the vault companion listener binds. Any address other than this machine needs GLIMMERVOID_VAULT_TOKEN and a fixed vault port. Needs a server restart. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `vault.port` | Vault companion port | `null` | Port the vault companion listener binds; empty picks any free port. Set one for a companion on another machine. Needs a server restart. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |

### Updates

Which version is running, and updating to the newest.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `checkForUpdates` | Check for updates automatically | `true` | Check for a newer version at launch and while the dashboard is open. |

### Remote

Sessions on other machines: hosts running Glimmervoid that this dashboard links over ssh, and Coder workspaces.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `remoteSessions` | Remote Coder sessions | `false` | Offer Coder workspaces when adding a session. |

### Usage

Token accounting and estimated-cost budgets.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `usage.enabled` | Track token usage | `true` | Read local agent transcripts for the Usage tab and session cards. |
| `usage.yourDay` | Your day | `true` | Recap yesterday and suggest a pace for today when usage tracking is on. |
| `usage.retainDays` | Retain transcript detail | `90` | How long detailed usage is kept. |
| `usage.budget.dailyUsd` | Daily budget | `null` | Alert at 50%, 75% and 100% of this estimated daily spend, or never at zero. |
| `usage.budget.monthlyUsd` | Monthly budget | `null` | Alert at 50%, 75% and 100% of this estimated monthly spend, or never at zero. |
| `usage.vendors.codex` | Track Codex usage | `true` | Include local Codex CLI transcripts in usage reports. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.vendors.grok` | Track Grok usage | `true` | Include local Grok CLI transcripts in usage reports. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.vendors.kimi` | Track Kimi Code usage | `true` | Include local Kimi Code transcripts in usage reports. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.fetchPricing` | Fetch current model prices | `true` | Load public model prices when usage tracking starts, using a cached table for up to one day. Falls back to cached or bundled prices if the fetch fails; no daily refresh runs while tracking continues. Needs a server restart. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.planLimits` | Show plan limits | `true` | Read the Claude plan limit the CLI reports and show it beside usage. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.scanIntervalMinutes` | Scan interval | `5` | Periodic transcript polling interval. Session activity can also trigger scans between timer ticks. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.warehouseRetainDays` | Retain usage history | `365` | How long the daily usage warehouse keeps rolled-up totals after transcript detail expires. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.sessionBlockHours` | Session block length | `5` | Length of the rolling block the Usage view groups activity into. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.costMode` | Cost mode | `"auto"` | Choose whether recorded costs, calculated costs or both can appear. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `usage.extraProjectsDirs` | Extra transcript folders | `[]` | Absolute paths of additional Claude projects folders the usage scan reads. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

### PostHog

Error monitoring, investigations and traffic-spike alerts.

The PostHog lane only starts when `posthog.host`, `posthog.apiKey`, `telegram.botToken` and `telegram.chatId` are all set: its alerts go to Telegram, so configure the Telegram section first.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `posthog.enabled` | Enable PostHog monitoring | `false` | Watch PostHog error tracking and investigate issues that move. |
| `posthog.host` | Host | `"https://us.posthog.com"` | PostHog cloud or self-hosted URL. |
| `posthog.apiKey` | Personal API key | `""` | Personal API key with read access to your projects. |
| `posthog.readApiKey` | Read-only API key for the watcher | `""` | Personal API key with read scopes only. The watcher uses it to notice new errors and community questions, so Radar and Community stop polling on a timer. |
| `posthog.projects` | Projects | `"all"` | Project ids to watch, where empty watches all and none watches none. |
| `posthog.intervalMinutes` | Poll interval | `15` | Time between PostHog checks. |
| `posthog.maxConcurrentInvestigations` | Max concurrent investigations | `2` | Most investigations running at once. |
| `posthog.minUsersToInvestigate` | Min users to investigate | `1` | Fewest affected users before a new issue is investigated. |
| `posthog.trafficSpikeEnabled` | Traffic spike alerts | `true` | Alert when unique users jump above normal. |
| `posthog.autoFix` | Attempt fixes for major issues | `false` | Let an agent fix an issue on a local branch, opening a pull request only after you approve. |
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

### Reviews

Team review drafts reviews of teammates' pull requests for you to post; My pull requests keeps your own moving.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `teamReview.enabled` | Enable team review | `true` | Draft a review of each open team pull request, posting nothing until you approve or comment. |
| `github.teams` | GitHub teams | `[]` | GitHub teams whose review requests are drafted, as org/team-slug. |
| `teamReview.org` | GitHub organization | `""` | Organization whose pull requests that request your review directly are drafted. Needed only when no GitHub team is set. |
| `teamReview.reReviewAfterHours` | Re-review after | `24` | Review a pull request again after a new push, once this much time has passed. |
| `teamReview.skipIdleAfterDays` | Skip PRs idle for | `14` | Skip pull requests with no activity for this long. |
| `teamReview.skill` | Review skill | `""` | Skill Claude Code follows for each review, or none when empty. |
| `teamReview.reviewer.model` | Review model | `""` | Model for reviews, or the agent's default when empty. |
| `teamReview.reviewer.effort` | Review effort | `""` | Effort for reviews, or the agent's default when empty. |
| `teamReview.stampReviewer.model` | Docs and tests PR model | `""` | Model for pull requests that only touch docs and tests. |
| `teamReview.stampReviewer.effort` | Docs and tests PR effort | `""` | Effort for pull requests that only touch docs and tests. |
| `teamReview.sandbox.loadMcpServers` | Load my MCP servers | `false` | Give the review agent your own MCP servers. |
| `lanes.fetchDomains` | Extra fetch domains | `[]` | Domains lanes may fetch pages from, beyond GitHub and posthog.com. |
| `teamReview.team` | GitHub team (legacy) | `""` | Team slug whose members and review requests are polled. Read only when github.teams is empty. **File-only.** A legacy key: github.teams names teams as org/slug entries and wins whenever it is set. |

### My pull requests

Keep your own pull requests rebased, mergeable and merged, and run workflow rules on their events.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `teamReview.autoRebaseMyPrs` | Keep my pull requests rebased | `false` | Rebase your open pull requests when they fall behind their base branch. |
| `teamReview.keepMergeableEnabled` | Keep mergeable | `true` | Offer Keep mergeable: an agent fixes conflicts and failing checks on your pull requests. |
| `teamReview.keepMergeableTimeoutMinutes` | Keep mergeable deadline | `30` | Longest a Keep mergeable repair may run. |
| `teamReview.mergeQueueEnabled` | Merge when ready | `true` | Offer Merge when ready: queued pull requests merge once they pass. |
| `workflows.enabled` | Run workflows | `true` | Watch the repositories your rules name and run their actions. |
| `workflows.maxConcurrentSessions` | Concurrent agent sessions | `2` | Most workflow sessions running at once. |
| `workflows.maxActionsPerPoll` | Actions per poll | `20` | Most actions run in one poll. The rest are dropped and logged. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `workflows.rules` | Workflow rule definitions | `[]` | The rules My pull requests switches on and off: each names its repositories, one pull request event, its filters and its actions. **File-only.** Rule definitions are written in config.json; My pull requests only switches each rule on or off. |
| `prFlows.sources` | PR flows sources | `[]` | Commands that report review findings for your own pull requests, run without a shell on each new head once you approve the exact command in My PRs. Each entry has id, label, command (an argv array; {prUrl}, {repo}, {number} and {head} expand inside one argument, and GLIMMERVOID_PR_URL, GLIMMERVOID_PR_REPO, GLIMMERVOID_PR_NUMBER and GLIMMERVOID_PR_HEAD are set), timeoutSeconds and optional repos (owner/name; every repository when absent), and prints {"findings": [{"path", "lineStart", "lineEnd", "priority", "body", "url"}], "status": [{"label", "state"}]} JSON. Each id is unique within the list. Check entries with glimmervoid pr-flows check. **File-only.** Commands run on this machine, so they are written in config.json and each one waits for your approval in My PRs. |
| `prFlows.actions` | PR flows actions | `[]` | Commands that act on a review item of your own pull request, shown as a button with their label and named by rules as run:<id>. Each entry has id, label, command and timeoutSeconds like a source, also expands {itemPath} and {itemLine}, gets the item as GLIMMERVOID_ITEM_JSON, waits for your approval in My PRs, and has an id unique within the list. Exit 0 is done and non-zero failed, unless stdout prints {"outcome": "done" \| "started" \| "refused" \| "failed", "message"} JSON. **File-only.** Commands run on this machine, so they are written in config.json and each one waits for your approval in My PRs. |
| `prFlows.prActions` | PR flows PR actions | `[]` | Commands that act on a whole pull request of yours, shown as a button next to Keep mergeable and Merge when ready and run once per click, never by a rule. Each entry has id, label, command and timeoutSeconds like an action, plus optional repos (owner/name; every repository when absent), expands {headRef} and {baseRef} instead of the item placeholders, gets GLIMMERVOID_PR_HEAD_REF, GLIMMERVOID_PR_BASE_REF and the pull request as GLIMMERVOID_PR_JSON, and waits for your approval in My PRs. Exit 0 is done and non-zero failed, unless stdout prints {"outcome": "done" \| "started" \| "refused" \| "failed", "message"} JSON. **File-only.** Commands run on this machine, so they are written in config.json and each one waits for your approval in My PRs. |
| `prFlows.rules` | PR flows rules | `[]` | Ordered rules for review items on your own pull requests; the first match acts with no click and lands in the Handled list, where Undo reopens it. Each matches on sources (source ids, <pack>/<id> for a pack source), authors (GitHub logins of review comment authors), priority, paths, text, scope and repos (owner/name; every repository when absent), and acts with ask, fix-local, dismiss or run:<action id>. **File-only.** Rules are written in config.json; Save as rule in My PRs is the one dashboard writer, and it only appends. |
| `prFlows.repoRules` | PR flows repository rules | `{}` | Deprecated: put repos on each rule in prFlows.rules instead. Rules per repository (owner/name to a list of rules), still checked before prFlows.rules for that repository. **File-only.** A structured value with no dashboard control; edit it in config.json. |

### Benchmarks

Compare agent setups on frozen benchmark cases.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `benchmarks.enabled` | Enable benchmarks | `false` | Show the Bench tab, where nothing runs until you start it. |

### Coherence

Coherence hook status and decision journal per session.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `coherence.enabled` | Show session Coherence | `true` | Show the Coherence hook status and decisions of each session in a repository with a coherence.config.json (needs @posthog/coherence 1.8 or newer). |

### Issues

GitHub issues from your projects and teams.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `issues.enabled` | Show the Issues tab | `false` | Show an Issues tab listing GitHub issues for your projects and teams. |

### Community

Research new posthog.com community questions and draft replies.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `community.enabled` | Show the Community tab | `false` | Research new community questions and draft a reply for each. |
| `community.skill` | Research skill | `""` | Skill the research agent follows, or none when empty. |
| `community.projectId` | PostHog project | `2` | PostHog project holding the community forum and Discord data. |
| `community.intervalMinutes` | Poll interval | `30` | Time between community checks. |
| `community.discordChannels` | Discord channels | `[]` | Discord channels to watch for questions, without the #, or none to skip Discord. |

### Privacy

What Glimmervoid sends about itself.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `telemetry.enabled` | Send usage data | `true` | Helps us improve Glimmervoid. Sent under a random install id: version, platform, app starts, daily activity, session starts and ends with agent kind, exit kind and duration, errors as their type, error code and scrubbed stack frames, per session token counts, models and estimated costs from the usage scan, and a salted one-way hash of your Claude and Codex account ids so installs of one account count together. The text of errors the dashboard shows in its header line, with your home folder shown as ~, which can name a session, folder or branch. Otherwise never prompts, project information, other error messages, paths, repository or branch names, objectives, terminal output, emails or names. Delete my data asks for everything sent under this install to be erased and starts a new install id. GLIMMERVOID_TELEMETRY=0, DO_NOT_TRACK=1 or CI=true turn it off regardless. |

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
| `worktree.autoRebase` | Worktree auto-rebase | `true` | Rebase eligible session worktrees when the integration branch moves. Applies to new sessions. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktree.syncOnStart` | Worktree sync on start | `true` | Fetch origin and fast-forward the local integration branch before a session starts its worktree. Applies to new sessions. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktree.cloneDependencies` | Worktree dependencies | `true` | Give a session worktree its node_modules before the agent starts: on macOS, clone the main checkout's when it matches the worktree's lockfile, then, except on Windows, install each folder still without one from its package-lock.json or pnpm-lock.yaml, with no package scripts. Applies to new sessions. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktree.rerere` | Worktree rerere | `true` | Reuse recorded Git conflict resolutions. Needs a server restart. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `shareCommitProvenance` | Share commit provenance | `true` | After Merge pushes the base branch, also push the git notes that let glimmervoid why name the agent and session of a commit on any clone. The notes hold a hashed session id and the agent name, never a task or prompt. Off keeps them on this machine. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktree.integrationBranch` | Integration branch | `null` | Base branch for session worktrees. Empty = each repo's default branch. Existing sessions are never retargeted. Applies to new sessions. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktree.root` | Worktree root | `""` | Directory that contains session worktrees. Existing worktrees are never relocated. Applies to new sessions. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktree.share` | Shared worktree paths | `[".env*",".claude"]` | Local paths copied or linked during worktree preparation. A * matches names at the project root, never one containing production; name such a file in full to share it. Applies to new sessions. **File-only.** Never editable from the dashboard by rule; edit it in config.json. |
| `port` | Local port | `3000` | Port used by the local dashboard listener. Needs a server restart. **File-only.** Never editable from the dashboard by rule; edit it in config.json. |
| `notifyDebounceMs` | Notification grouping window | `3000` | Alerts from any session within this long of the first one fold into one sound, one desktop notification and one Telegram message. Applies to new sessions. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `phoneEscalationMs` | Phone escalation delay | `300000` | Delay before off-dashboard escalation. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
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

### Packs

Packs other people share, each waiting for your approval before anything in it runs.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `packs` | Packs | `[]` | More pack directories to load besides every directory under ~/.glimmervoid/packs/. A pack is a pack.json (name, version, description, requires, and sections such as prFlows with prActions, sources, actions, rules and a repos default for them) plus the files it uses, shared by copying the directory; its commands can use {packDir}, its ids show as <pack>/<id>, and it waits for one approval in Settings, Packs that any edit to a file in it asks again. **File-only.** A pack can run commands on this machine, so its directory is written in config.json and the pack waits for your approval. |

### Question manager

Rules that answer a session question in the sessions you switch the question manager on for.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `questionManager.rules` | Question manager rules | `[]` | Rules the question manager answers from. An object with name, question (text the question contains) and pick (the exact option labels to choose) answers at once. A plain sentence is a rule a model applies when no object matches; it must cite one rule and pick exact option labels within 60 seconds, or the question comes to you. A question with a risk word such as push, delete or deploy always comes to you. **File-only.** A structured value with no dashboard control; edit it in config.json. |
| `questionManager.model` | Question manager model | `"haiku"` | Claude model alias that applies the plain-language question manager rules. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

## Keys outside the Settings view

Edit these in `config.json` unless the note names another dashboard surface.

| Key | Default | Notes |
|-----|---------|-------|
| `coder` |  | Set `coder.appSlug` to an existing `coder_app` slug on the workspace agent to prevent Coder autostop while Glimmervoid sessions are running. Requires `CODER_AGENT_URL` and `CODER_AGENT_TOKEN` (or `CODER_AGENT_TOKEN_FILE`) in the environment; Coder supplies them when started from a workspace terminal or startup script. |
| `guardrails` |  | Retired and ignored: sessions no longer run inside an OS sandbox, and a leftover block logs one line at startup. `guardrails.unreadablePaths` moved to `saneYoloUnreadablePaths`. |
| `hooks` |  | Operator-defined hooks per project, managed from the dashboard Hooks panel. |
| `remote` | `{"port":null,"publicHost":"","allowedOrigins":[]}` | Remote listener, always on and answering paired devices only: `port` (a free port the system picks when unset, published in `~/.glimmervoid/remote-listener/<local port>.port`; must differ from the local port), `publicHost`, `allowedOrigins` and `ownerLogin` (when set, only that Tailscale login is answered; trustworthy only when the remote port is reached solely through HTTP-mode `tailscale serve`, since any other proxy, or `tailscale serve --tcp` or `--tls-terminated-tcp`, lets a client send its own `Tailscale-User-Login`), and `doormanUrl` (a doorman on another machine that hosts its watcher, https or http only for this machine; unset, the server starts its own doorman on this machine, kept in `~/.glimmervoid/doorman/<port>/`). Needs a server restart. See [Remote access](../README.md#remote-access). |
| `hosts` |  | Other machines running Glimmervoid that this dashboard links over ssh and shows in the sidebar. Each entry has `id` (lowercase letters, digits and dashes), `name`, `sshTarget` (an ssh host or `~/.ssh/config` alias, never starting with a dash) and `dashboardPort` (that machine's loopback dashboard port). The tunnel runs `ssh` with `BatchMode=yes` and `StrictHostKeyChecking=yes`, so the host key must already be known. A host on a different Glimmervoid version is refused. Managed from Settings, Remote, or with `glimmervoid host add`, `list` and `remove`; a running Glimmervoid applies a change without a restart. |
| `projects` | `[]` | Projects shown in the dashboard, added from the Add Session dialog. Each entry has `path` (required), optional `name`, `repos` (two or more member repositories for a workspace session), `baseBranch` (the branch sessions of this project start from and merge back into, set by Open in session on a team review pull request), `agent` (an agent id, see `customAgents`) and `codexBypassHookTrust` (file-only, default off). |

## Environment variables

Rows marked internal are set by Glimmervoid itself for its child processes; they are listed so nothing it reads is undocumented.

| Variable | Audience | Effect |
|----------|----------|--------|
| `GLIMMERVOID_HOME` | operator | Directory holding `config.json` and all machine state (pairings, recordings). Defaults to `~/.glimmervoid`. |
| `GLIMMERVOID_CONFIG` | operator | Path to the config file, winning over `GLIMMERVOID_HOME`. The file must exist or the server exits with `Config file not found`. `--config <path>` sets it. |
| `GLIMMERVOID_PORT` | operator | Local dashboard port, overriding `port` in `config.json`. `--port <number>` sets it. |
| `GLIMMERVOID_HOST` | operator | Bind address for both listeners. Defaults to `127.0.0.1`; any non-loopback value is refused unless `GLIMMERVOID_INSECURE_BIND=1`. |
| `GLIMMERVOID_INSECURE_BIND` | operator | Set to `1` to allow a non-loopback `GLIMMERVOID_HOST`. The local listener has no authentication, so this exposes full control of the machine to anyone who can reach the port. |
| `GLIMMERVOID_SUPERVISOR` | operator | Set to `launchd` in a launchd job that keeps Glimmervoid alive, so Restart exits with code 75 for launchd to start it again instead of starting its own replacement. A systemd unit needs nothing: its `INVOCATION_ID` does the same. |
| `GLIMMERVOID_POSTHOG_API_KEY` | operator | Supplies `posthog.apiKey`, overriding the stored value. It is stripped from every write, so a dashboard save never persists it. |
| `GLIMMERVOID_TELEGRAM_BOT_TOKEN` | operator | Supplies `telegram.botToken`, overriding the stored value. It is stripped from every write, so a dashboard save never persists it. |
| `GLIMMERVOID_POSTHOG_READ_API_KEY` | operator | Supplies `posthog.readApiKey`, the read-only PostHog key the watcher uses, overriding the stored value. It is stripped from every write, so a dashboard save never persists it. |
| `GLIMMERVOID_GITHUB_READ_TOKEN` | operator | Supplies `github.readToken`, the read-only GitHub token lanes use for gh, overriding the stored value. It is stripped from every write, so a dashboard save never persists it. |
| `GLIMMERVOID_VAULT_TOKEN` | operator | Supplies `vault.token`, the bearer token a vault companion sends to this server's vault companion listener; set the same value where `glimmervoid vault` runs. Unset, the server makes one per boot and hands it to a companion on this machine. A companion on another machine (`glimmervoid vault --server <url>`) also needs the listener reachable there: a fixed `vault.port`, and either a non-loopback `vault.host` (which this token permits) or an ssh tunnel to the loopback port, behind https. Stripped from every write and from every agent session's environment. |
| `GLIMMERVOID_CLAUDE_OAUTH_TOKEN` | operator | A long-lived Claude Code token (`claude setup-token`) that benchmark arms authenticate with instead of the login token Glimmervoid reads from the keychain or `~/.claude/.credentials.json`. Passed only to benchmark sessions, never stored. |
| `GLIMMERVOID_TELEMETRY` | operator | Set to `0` to turn off usage and error telemetry (error type, error code and scrubbed stack frames, never messages or paths) whatever `telemetry.enabled` says. `DO_NOT_TRACK=1` and `CI=true` turn it off too. |
| `GLIMMERVOID_TELEMETRY_PROJECT_TOKEN` | internal | Sends telemetry to another PostHog project instead of the Glimmervoid one, so end-to-end checks of a development build stay out of real usage data. Not an operator setting. |
| `GLIMMERVOID_DEBUG_SPAWN` | operator | Any non-empty value logs which executable each agent command resolved to at spawn. |
| `GLIMMERVOID_GITHUB_API_BASE` | internal | Points GitHub probes at a fake GitHub API for the end-to-end runs. Honored only on a loopback address; any other value is ignored with one warning. Not an operator setting. |
| `GLIMMERVOID_POSTHOG_INGEST_HOST` | internal | Sends telemetry to a fake PostHog ingest for the end-to-end runs. Honored only on a loopback address; any other value is ignored with one warning. Not an operator setting. |
| `GLIMMERVOID_SANE_YOLO_PATH` | internal | Names the Sane YOLO binary only in supervised sessions, so an installed Grok hook stays inert outside Glimmervoid. Not an operator setting. |
| `GLIMMERVOID_HOOK_URL` | internal | Set by Glimmervoid in each session environment as the hook relay target. Not an operator setting. |
| `GLIMMERVOID_AGENT_URL` | internal | Set by Glimmervoid in each session environment; `glimmervoid push`, `spawn`, `attention` and `sessions` read it. Not an operator setting. |
| `GLIMMERVOID_CODEX_REMOTE_TOKEN` | internal | Set by Glimmervoid in the environment of a Codex session that runs in a Coder workspace; the Codex TUI sends it as the bearer token to the forwarded app-server. Not an operator setting. |
| `GLIMMERVOID_PR_ACTION_REPORT_URL` | internal | Set by Glimmervoid in the environment of each `prFlows.prActions` run; `glimmervoid pr-action report` posts the run outcome there. Not an operator setting. |
| `GLIMMERVOID_PR_ACTION_TOKEN` | internal | The per-run token `glimmervoid pr-action report` sends with a report; it stops working once the run has a final outcome. Not an operator setting. |
| `GLIMMERVOID_SIGN_URL` | internal | Set by Glimmervoid in each operator session environment; `glimmervoid ssh-sign`, which git runs to sign a commit, posts there so the server signs with the operator's forwarded ssh agent. Not an operator setting. |

## Telemetry

Glimmervoid sends usage and error events to its own PostHog project, under a random install id kept in `telemetry.json` in the Glimmervoid home (`~/.glimmervoid`, or `$GLIMMERVOID_HOME`). That id gets a PostHog person profile, which `app_started` and `app_active` fill with the first version, platform and install flavor seen, plus a salted one-way hash of the Claude Code account id and the Codex user id when logged in; never the ids themselves, an email, a name or a token. Only `header_error_shown` carries free text: the message of an error the dashboard showed in its header line, which can name a session, folder or branch, with the home folder shown as `~`. Nothing else names a path, repository, branch, session, prompt, error message or terminal output. A crash is kept in `telemetry-pending-crash.json` beside it until the next start sends it, or deletes it unsent when telemetry is off. It prints a notice once on first start. Turn it off with `telemetry.enabled`, `GLIMMERVOID_TELEMETRY=0`, `DO_NOT_TRACK=1` or `CI=true`.

At start and once a day it also asks PostHog for the `telemetry-enabled` flag for its install id. It also checks when telemetry is turned back on. Once that flag comes back disabled it sends nothing, across restarts too, until a later check returns it enabled; a failed check or a missing flag changes nothing. The maintainers stop all sending by setting the flag's rollout to 0%; deactivating or deleting the flag does not stop installs, because PostHog then leaves it out of the answer. That request is skipped whenever telemetry is off.

Every event also carries `app_version`, `os_platform`, `node_major`, `install_flavor`, `is_bundled`, `is_dev_install`, where `is_dev_install` is true for a git clone, a source checkout or a Glimmervoid home other than `~/.glimmervoid`, plus `$release_id` on a published build linked to its PostHog release.

| Event | Properties | When |
|-------|------------|------|
| `app_started` | `is_first_start`, `$set`, `$set_once` | The server started listening, and whether this is the first start, with no Glimmervoid config file yet. Also sets the person properties: a one-way hash of the Claude Code account id and the Codex user id when logged in, and the first version, platform and install flavor seen. |
| `app_active` | `active_session_count`, `watcher_probe_count`, `watcher_covered_probe_count`, `watcher_nudge_count`, `$set`, `$set_once` | Once a day while the server runs, with how many sessions are live, how many probes the watcher was handed and how many of them it covers, and how many watcher nudges arrived since the last one, and the same person properties as app_started. |
| `session_started` | `adapter` | A session spawned, with which kind of agent (any custom agent counts as `custom`). |
| `session_ended` | `adapter`, `exit_kind`, `duration_seconds` | A session ended: how it exited, or that it was removed, replaced by a settings change or stopped with the server, and how long it ran, in whole seconds. |
| `$exception` | `$exception_list`, `$exception_level` | An error in the server or the dashboard: its type, an error code when it has one, and stack frames with file paths cut to the package or URL path. Never the error message. Each distinct error is sent once per run, and a crash is sent on the next start. |
| `$ai_generation` | `$ai_trace_id`, `$ai_provider`, `$ai_model`, `$ai_input_tokens`, `$ai_output_tokens`, `$ai_cache_read_input_tokens`, `$ai_cache_creation_input_tokens`, `$ai_total_cost_usd`, `agent_adapter` | Per agent session and model, after each usage scan, for usage recorded in the last 24 hours: token counts, the model name and estimated cost, under a one-way hash of the session. A model name outside the shipped pricing table is sent as unknown. No prompts or output. |
| `command_hint_shown` | `command`, `adapter` | An agent was handed a one-time line naming a Glimmervoid command when its tool call made the command fit, with which command and which kind of agent. Never the tool call. |
| `command_hint_followed` | `command`, `adapter` | An agent ran a Glimmervoid command it had been handed a one-time line about earlier in the same conversation, with which command and which kind of agent. |
| `view_shown` | `view` | A dashboard tab opened, on desktop or phone, with which tab. Sent on every open. |
| `operator_action` | `surface`, `action` | An action taken in the Usage, Issues, Radar or Reviews tab, the first-run checklist or the GitHub star card: which surface and which action, from a fixed list. Never which repository, pull request, issue or session it was taken on. |
| `onboarding_step` | `step`, `state` | The first-run checklist moved a step to current or done, with which step. Sent once per change while the page is open. |
| `header_error_shown` | `source`, `message` | An error the dashboard showed in its header line: which part of the dashboard raised it and the message text, cut to 512 characters, with your home folder shown as ~. The message can name a session, folder or branch. Each distinct message is sent once per page load. |
| `team_review_drafted` | `inline_comment_count` | A team review draft became ready, with how many inline comments it drafted. |
| `team_review_settled` | `duration_ms`, `outcome`, `drafted_comment_count`, `posted_comment_count` | A team review draft was posted (approve, comment or approve-only), discarded, or restored from discarded (which undoes that discard), with how many inline comments were drafted and how many were posted, plus the total action duration in milliseconds. |
| `team_review_post_refused` | `duration_ms`, `reason` | Posting a team review was refused, with a reason from a fixed list and the total action duration in milliseconds. Never the error text. |
| `radar_investigation_finished` | `verdict`, `mode`, `error_reason` | A Radar investigation or fix run finished, with its verdict and mode, plus a reason from a fixed list when it ended in ERROR. Never the summary text. |
| `radar_fix_handoff_failed` | `step` | Committing or checking a Radar fix branch failed, with which step failed. Never the branch or the error text. |
| `data_deletion_requested` | none | Delete my data was confirmed in Settings > Privacy, with no properties. Sent under the old install id even when telemetry is off, unless the maintainers stopped all sending, and then the install id is replaced. PostHog deletes the person and every event under that id on receipt. |
| `watcher_probe_failing` | `lane`, `credential`, `failure_kind` | A watcher probe started failing: which lane and which kind of read credential it uses, and a failure kind from a fixed list. Never the URL, repository, token or error text. |
| `watcher_probe_recovered` | `lane`, `credential`, `failing_seconds` | A failing watcher probe answered again: which lane and kind of read credential, and how long it was failing, in whole seconds. |
| `watcher_nudge_received` | `lane`, `kind` | The watcher told a lane its answer changed or recovered: which lane and which of the two. Never the probe, URL or repository. |
| `vault_companion_connection` | `state`, `refusal_kind`, `connected_seconds` | A vault companion connected, disconnected (with how long it stayed, in whole seconds) or was refused (because it asked for the wrong path or brought the wrong token; once per reason until a companion connects). Never the token, address or account. |
| `vault_secret_answered` | `delivered_count`, `pending_count`, `denied_count`, `companion_offline_count`, `failed_count` | An agent asked for secrets by name and got its answer: how many names came back delivered, pending, denied, companion offline or failed. Never the names, values or project. |

## Browser preferences

Stored in each browser, not in `config.json`, so every device keeps its own. Change them in Settings.

| Setting | Default | Notes |
|---------|---------|-------|
| Theme | `"glimmer"` | Color scheme for the dashboard. |
| Swipe arrow pad on phone | `false` | Swap the phone arrow keys for one pad you swipe on. |
| Flying animals | `false` | Show animated animals flying across the dashboard. |
| Time between flights: minimum | `20` | Shortest pause between flights. |
| Time between flights: maximum | `40` | Longest pause between flights. |
| Flight duration: minimum | `6.9` | Shortest flight, for faster animals. |
| Flight duration: maximum | `11.5` | Longest flight, for slower animals. |
| Size multiplier | `1` | Scale applied on top of the viewport size. |
| Show on phone layout | `true` | Allow flights on the phone layout. |
| Reviewing now limit | `5` | How many pull requests the Reviews Reviewing now column holds at once. 0 means no cap. |
| Alert sounds | `true` | Play a sound when a session needs you, like the note button in the header. |
| Alert sound | `"chime"` | Sound played when a session needs you, including files you add to ~/.glimmervoid/sounds/. |
| Desktop notifications | `true` | Notify you when a session needs you and the dashboard is in the background. |
| Jump to the next session needing you | `"KeyJ"` | Key held with Cmd on a Mac, or Alt elsewhere, to jump to the next session that needs you. |
