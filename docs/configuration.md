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
| `telegram.chatId` | Chat id | `""` | Chat the bot posts to, read as message.chat.id from its getUpdates page after you message it. Session notifications send automatically once both bot token and chat id are saved. |
| `telegram.acceptReplies` | Take replies | `false` | Reply to an alert in Telegram to answer the question a session holds or send it text. Only messages you send in your private chat with the bot are read, so the chat id must be your own user id; group chats are never read. |

### Slack

Session alerts posted to one Slack channel through an incoming webhook.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `slack.webhookUrl` | Webhook URL | `""` | Incoming webhook URL from your Slack app (Incoming Webhooks, Add New Webhook). Session notifications send automatically once saved. |

### Sessions

How sessions start and where projects are found.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `loopGuard.maxTurnsWithoutProgress` | Turns without progress | `null` | Act on a session after this many turns in a row end with its worktree unchanged and no input from you, another session or a wake, or never at zero. |
| `loopGuard.onStuck` | When a session is stuck | `"flag"` | Flag asks for your attention; Stop also ends the session. |
| `linkPreviews` | Link page previews | `true` | Resting the pointer on a terminal link for about 600 ms fetches that page from this machine to show its title and icon. Off, the link card shows the address only. |
| `repoRoots` | Repository roots | `[]` | Folders scanned for projects when adding a session. |
| `hiddenAgents` | Agents in Add Session | `[]` | Agents left out of the Add Session picker. Switch an agent off here to hide it; the default agent always stays. |
| `autoResume` | Auto-resume sessions on startup | `true` | Resume sessions that were live when Glimmervoid last stopped or crashed. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `spawnedSessionsMax` | Spawned sessions per session | `3` | Most sessions one session may have spawned and live at once; a spawn past it is refused. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `viewTabOrder` | Tab order | `[]` | Order of the dashboard tabs, set by dragging tabs in the header. **File-only.** Set by dragging tabs in the header. |
| `debugMode` | Debug mode | `false` | Show session-card diagnostics for state, transitions and detection signals. **File-only.** A diagnostic switch kept out of the Settings view; change it in config.json while investigating. |
| `sessionOrder` | Session order | `[]` | Order of sessions within each project in the sidebar and the phone Board, as session ids; a session not listed goes after the listed ones. **File-only.** Set by dragging sessions in the sidebar, or pressing and holding them on the phone Board. |
| `operatorTimezone` | Operator timezone | `null` | Timezone that wake times, day boundaries and shown times use; until a dashboard reports one, the machine timezone. **File-only.** Set by the dashboard from the browser timezone each time it connects with a different one. |
| `sessionMemoryReserveMB` | Session memory reserve | `600` | Free memory an automatic session start waits for; 0 starts sessions without checking. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `packScheduledSessionsMax` | Scheduled pack sessions | `3` | Most sessions that pack launcher schedules keep live at once; a scheduled run past it is skipped. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

### Worktrees

Session worktrees and branch cleanup.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `branchGc.deleteUnmerged` | Delete unmerged branches | `false` | Also delete stale remote branches with no proof they were merged. |
| `worktreeDiskReserveGB` | Worktree disk reserve | `15` | Free disk space a new session worktree needs; below it the session is blocked and you are notified. 0 turns the check off. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `shareCommitProvenance` | Share commit provenance | `true` | After Merge pushes the base branch, also push the git notes that let glimmervoid why name the agent and session of a commit on any clone. The notes hold a hashed session id and the agent name, never a task or prompt. Off keeps them on this machine. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktree.integrationBranch` | Integration branch | `null` | Base branch for session worktrees. Empty = each repo's default branch. Existing sessions are never retargeted. Applies to new sessions. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktree.root` | Worktree root | `""` | Directory that contains session worktrees. Existing worktrees are never relocated. Applies to new sessions. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `worktree.share` | Shared worktree paths | `[".env*",".claude"]` | Local paths copied or linked during worktree preparation. A * matches names at the project root, never one containing production; name such a file in full to share it. Applies to new sessions. **File-only.** Never editable from the dashboard by rule; edit it in config.json. |
| `branchGc.prefixes` | Branch cleanup prefixes | `["glimmervoid/session/","worktree-agent-"]` | Branch prefixes that filter both remote branch cleanup and local worktree cleanup. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |
| `branchGc.dryRun` | Branch cleanup dry run | `false` | Report planned cleanup without deleting remote branches. **File-only.** Changes how the server process or its worktrees behave, so it is set in config.json with a restart or new sessions in mind. |

### Session review

The read-only reviewer the Review button in Changes starts on a session diff.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `sessionReview.agent` | Reviewer agent | `"claude-code"` | Agent that reviews the diff. Pick one other than the session agent for a second opinion. Codex sees only the diff, not the checkout. |
| `sessionReview.model` | Reviewer model | `""` | Model name passed to the reviewer agent. Empty uses that agent default. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

### Plan approval

Hold a plan an agent proposes until you approve or reject it on the dashboard.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `planGate.enabled` | Approve plans on the dashboard | `false` | Claude Code waits on its proposed plan until you decide on the card. Codex shows the plan on the card, and your decision is typed into it. Other agents keep approving in the terminal. |

### Chat view

Run a session from a chat page instead of its terminal.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `sessionChat.enabled` | Chat view for sessions | `false` | Adds a Chat page beside the terminal on every session. Still being built, so turning it on changes nothing yet. |

### Sane YOLO

What agents may do without asking, and what Sane YOLO blocks.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `skipPermissionsByDefault` | Skip permission prompts by default | `true` | Skip agent permission prompts for projects that set no choice. |
| `saneYolo` | Sane YOLO | `true` | Block catastrophic commands and credential reads in every session that supports it. Applies to new sessions. |
| `saneYoloUnreadablePaths` | Unreadable folders | `[]` | Extra files and folders agents may not read, where ~ is your home folder. Applies to new sessions. |
| `sandboxAllowedHosts` | Sandbox allowed hosts | `[]` | Extra hosts a sandboxed session may reach, on top of the model, GitHub and package registry hosts. Only used when sessionSandbox is on. Applies to new sessions. |
| `sandboxWeakerNetworkIsolation` | macOS certificate checks | `false` | Lets a sandboxed macOS session ask trustd, the macOS certificate service, to verify TLS. While off, gh and other Go tools fail TLS certificate checks inside a macOS session. Only used when sessionSandbox is on. Applies to new sessions. |

### Vault

Where agents read secrets from, the names they may read, and the tokens Glimmervoid itself holds.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `vault.manager` | Source | `"age"` | Where agents read the secrets you allow. Age file keeps them encrypted on this machine and needs no password manager; you type each value on the request card the first time an agent asks. |
| `vault.lookIn` | Look in | `""` | The 1Password vault agents read secrets from, only for the names you allow. Unused with Age file. Opening Settings never asks 1Password; Test connection does. |
| `github.readToken` | GitHub read token | `""` | Read-only fine-grained GitHub token lanes use for gh. Team review and community research need it. |

### Updates

Which version is running, and updating to the newest.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `checkForUpdates` | Check for updates automatically | `true` | Check for a newer version at launch and while the dashboard is open. |

### Usage

Token accounting and estimated-cost budgets.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `usage.enabled` | Track token usage | `true` | Read local agent transcripts for the Usage tab and session cards. |
| `usage.budget.dailyUsd` | Daily budget | `null` | Alert at 50%, 75% and 100% of this estimated daily spend, or never at zero. |
| `usage.budget.monthlyUsd` | Monthly budget | `null` | Alert at 50%, 75% and 100% of this estimated monthly spend, or never at zero. |
| `usage.budget.pauseAtLimit` | Pause at budget | `false` | At 100% of a budget, snooze live sessions and hold agent spawns and wakes until the day or month rolls over. |
| `usage.retainDays` | Retain transcript detail | `90` | How long detailed usage is kept. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
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
| `posthog.trafficSpikeEnabled` | Traffic spike alerts | `true` | Alert when unique users jump above normal. |
| `posthog.autoFix` | Attempt fixes for major issues | `false` | Let an agent fix an issue on a local branch, opening a pull request only after you approve. |
| `posthog.maxConcurrentInvestigations` | Max concurrent investigations | `2` | Most investigations running at once. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.minUsersToInvestigate` | Min users to investigate | `1` | Fewest affected users before a new issue is investigated. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.repoPath` | Repository path | `""` | Absolute path of the local checkout investigations read and fixes branch from, for every project the project map does not name. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `posthog.projectMap` | Project map | `{}` | PostHog project id to a label: the name shown for that project, and, when it is an absolute path to a checkout, the repository its issues are investigated in. **File-only.** A structured value with no dashboard control; edit it in config.json. |

### Reviews

Team review drafts reviews of teammates' pull requests for you to post; My pull requests keeps your own moving.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `teamReview.enabled` | Enable team review | `true` | Draft a review of each open team pull request, posting nothing until you approve or comment. |
| `github.teams` | GitHub teams | `[]` | GitHub teams whose review requests are drafted, as org/team-slug. |
| `teamReview.org` | GitHub organization | `""` | Organization whose pull requests that request your review directly are drafted. Needed only when no GitHub team is set. |
| `teamReview.skill` | Review skill | `""` | Skill Claude Code follows for each review, or none when empty. |
| `teamReview.sandbox.loadMcpServers` | Load my MCP servers | `false` | Give the review agent your own MCP servers. |
| `teamReview.reReviewAfterHours` | Re-review after | `24` | Review a pull request again after a new push, once this much time has passed. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `teamReview.skipIdleAfterDays` | Skip PRs idle for | `14` | Skip pull requests with no activity for this long. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `teamReview.extraSkills` | Skills the review skill calls | `[]` | Other skills the review skill may run, whose allowed-tools grants then apply to the review. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `teamReview.reviewer.model` | Review model | `""` | Model for reviews, or the agent's default when empty. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `teamReview.reviewer.effort` | Review effort | `""` | Effort for reviews, or the agent's default when empty. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `teamReview.stampReviewer.model` | Docs and tests PR model | `""` | Model for pull requests that only touch docs and tests. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `teamReview.stampReviewer.effort` | Docs and tests PR effort | `""` | Effort for pull requests that only touch docs and tests. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

### My pull requests

Keep your own pull requests rebased, mergeable and merged, and run workflow rules on their events.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `teamReview.autoRebaseMyPrs` | Keep my pull requests rebased | `false` | Rebase your open pull requests when they fall behind their base branch. |
| `workflows.enabled` | Run workflows | `true` | Watch the repositories your rules name and run their actions. |
| `workflows.maxConcurrentSessions` | Concurrent agent sessions | `2` | Most workflow sessions running at once. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `workflows.rules` | Workflow rule definitions | `[]` | The rules My pull requests switches on and off: each names its repositories, one pull request event, its filters and its actions. **File-only.** Rule definitions are written in config.json; My pull requests only switches each rule on or off. |
| `prFlows.sources` | PR flows sources | `[]` | Commands that report review findings for your own pull requests, run without a shell on each new head once you approve the exact command in My PRs. Each entry has id, label, command (an argv array; {prUrl}, {repo}, {number} and {head} expand inside one argument, and GLIMMERVOID_PR_URL, GLIMMERVOID_PR_REPO, GLIMMERVOID_PR_NUMBER and GLIMMERVOID_PR_HEAD are set), timeoutSeconds and optional repos (owner/name; every repository when absent), and prints {"findings": [{"path", "lineStart", "lineEnd", "priority", "body", "url"}], "status": [{"label", "state"}]} JSON. Each id is unique within the list. Check entries with glimmervoid pr-flows check. **File-only.** Commands run on this machine, so they are written in config.json and each one waits for your approval in My PRs. |
| `prFlows.actions` | PR flows actions | `[]` | Commands that act on a review item of your own pull request, shown as a button with their label and named by rules as run:<id>. Each entry has id, label, command and timeoutSeconds like a source, also expands {itemPath} and {itemLine}, gets the item as GLIMMERVOID_ITEM_JSON, waits for your approval in My PRs, and has an id unique within the list. Exit 0 is done and non-zero failed, unless stdout prints {"outcome": "done" \| "started" \| "refused" \| "failed", "message"} JSON. **File-only.** Commands run on this machine, so they are written in config.json and each one waits for your approval in My PRs. |
| `prFlows.prActions` | PR flows PR actions | `[]` | Commands that act on a whole pull request of yours, shown as a button next to Keep mergeable and Merge when ready and run once per click, never by a rule. Each entry has id, label, command and timeoutSeconds like an action, plus optional repos (owner/name; every repository when absent), expands {headRef} and {baseRef} instead of the item placeholders, gets GLIMMERVOID_PR_HEAD_REF, GLIMMERVOID_PR_BASE_REF and the pull request as GLIMMERVOID_PR_JSON, and waits for your approval in My PRs. Exit 0 is done and non-zero failed, unless stdout prints {"outcome": "done" \| "started" \| "refused" \| "failed", "message"} JSON. **File-only.** Commands run on this machine, so they are written in config.json and each one waits for your approval in My PRs. |
| `prFlows.rules` | PR flows rules | `[]` | Ordered rules for review items on your own pull requests; the first match acts with no click and lands in the Handled list, where Undo reopens it. Each matches on sources (source ids, <pack>/<id> for a pack source), authors (GitHub logins of review comment authors), priority, paths, text, scope and repos (owner/name; every repository when absent), and acts with ask, fix-local, dismiss or run:<action id>. **File-only.** Rules are written in config.json; Save as rule in My PRs is the one dashboard writer, and it only appends. |
| `prFlows.repoRules` | PR flows repository rules | `{}` | Deprecated: put repos on each rule in prFlows.rules instead. Rules per repository (owner/name to a list of rules), still checked before prFlows.rules for that repository. **File-only.** A structured value with no dashboard control; edit it in config.json. |

### Community

Research new posthog.com community questions and draft replies.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `community.enabled` | Show the Community tab | `false` | Research new community questions and draft a reply for each. |
| `community.skill` | Research skill | `""` | Skill the research agent follows, or none when empty. |
| `community.projectId` | PostHog project | `2` | PostHog project holding the community forum and Discord data. |
| `community.discordChannels` | Discord channels | `[]` | Discord channels to watch for questions, without the #, or none to skip Discord. |

### Privacy

What Glimmervoid sends about itself and where lanes may fetch.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `telemetry.enabled` | Send usage data | `true` | Helps us improve Glimmervoid. Sent under a random install id, never with prompts, paths, notice text or terminal output, and never sold. GLIMMERVOID_TELEMETRY=0, DO_NOT_TRACK=1 or CI=true turn it off regardless. |
| `lanes.fetchDomains` | Extra fetch domains | `[]` | Domains lanes may fetch pages from, beyond GitHub and posthog.com. |

### Detection and sessions

Config-file-only detection, timing and process settings.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `agentRules.rules` | Rules for every session | `[]` | Rules every agent session receives with its Glimmervoid tools, whichever agent runs it, one string per rule, up to 40. Sessions started after a change read it. Applies to new sessions. **File-only.** A structured value with no dashboard control; edit it in config.json. |
| `reactions.reactions` | Reactions | `[]` | Up to 20 reactions, each {id, on, project?, action, text?}: on session-failed, session-done, needs-attention or commits-landed, action notify raises a note on the session card and wake types text into the session once idle. **File-only.** A structured value with no dashboard control; edit it in config.json. |
| `reactions.cooldownMinutes` | Reaction cooldown | `10` | How long one reaction waits before reacting to the same session again. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |
| `port` | Local port | `3000` | Port used by the local dashboard listener. Needs a server restart. **File-only.** Never editable from the dashboard by rule; edit it in config.json. |
| `customAgents` | Custom agents | `[]` | Extra agent CLIs a session can be spawned with. The Sessions section lists the declared agents and whether each command resolves. Applies to new sessions. **File-only.** Never editable from the dashboard by rule; edit it in config.json. |
| `taskTitle.refiner.enabled` | Refine task titles | `true` | Keep session card titles useful when prompts change topic by asking a model for a short title. **File-only.** A tuning knob kept out of the Settings view; the default suits almost every install. |

### Packs

Packs other people share, each waiting for your approval before anything in it runs.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `packs` | Packs | `[]` | More pack directories to load besides every directory under ~/.glimmervoid/packs/. A pack is a pack.json (name, version, description, requires, and sections such as prFlows with prActions, sources, actions, rules and a repos default for them) plus the files it uses, shared by copying the directory; its commands can use {packDir}, its ids show as <pack>/<id>, and it waits for one approval in the Packs tab that any edit to a file in it asks again. **File-only.** A pack can run commands on this machine, so its directory is written in config.json and the pack waits for your approval. |

### Question manager

Rules that answer a session question in the sessions you switch the question manager on for.

| Key | Setting | Default | Notes |
|-----|---------|---------|-------|
| `questionManager.rules` | Question manager rules | `[{"name":"Take recommended","pick":"recommended"}]` | Rules the question manager answers from. The default rule, pick "recommended", picks the one option labeled (Recommended) on each question. An object with name, question (text the question contains) and pick (the exact option labels to choose) answers at once. A plain sentence is a rule a model applies when no object matches; it must cite one rule and pick exact option labels within 60 seconds, or the question comes to you. Your rules replace the default, so [] leaves nothing to answer. A question with a risk word such as push, delete or deploy always comes to you. **File-only.** A structured value with no dashboard control; edit it in config.json. |

## Keys outside the Settings view

Edit these in `config.json` unless the note names another dashboard surface.

| Key | Default | Notes |
|-----|---------|-------|
| `guardrails` |  | Retired and ignored: a leftover block logs one line at startup. `guardrails.unreadablePaths` moved to `saneYoloUnreadablePaths`. Hosted boxes sandbox sessions through `sessionSandbox` instead. |
| `verification` |  | File-only. Checks each session runs in its worktree at turn end, keyed by repository path: `{ "repos": { "<repo path>": { "checks": [{ "id": "test", "command": "npm test" }], "timeoutSeconds": 300, "gate": { "enabled": true, "required": ["test"] } } } }`. A command is a plain program and arguments, never run through a shell; one with shell syntax is skipped. The Changes panel shows each check with its output tail. With `gate.enabled`, `glimmervoid push` and a session finish refuse to merge while the worktree has uncommitted changes, and until every required check (all checks when `required` is unset) passed on the current commit, running them first when that commit or the checks changed since the last passing run; an invalid entry refuses every merge in that repository. Checks run with a minimal environment, and do not run at all while `sessionSandbox` is on, because they would run agent-edited code outside the sandbox. |
| `sessionSandbox` |  | File-only, default off, Linux and macOS. On, every session started from a project starts inside an OS sandbox (`@anthropic-ai/sandbox-runtime` on Linux, a generated Seatbelt profile under `/usr/bin/sandbox-exec` on macOS) that keeps the Glimmervoid home, the vault and the box's credentials out of the agent's reach and limits network access to the model, GitHub and package registry hosts, while the agent keeps its own repos and logins. Lane sessions (team review, Radar, community, task titles, the question manager) still run outside it. Wargames seats always start inside it, whatever this setting says, with every other seat folder hidden, and a match start is refused where the sandbox cannot run. On macOS the session reaches only the agent endpoint port on loopback, never the dashboard, and cannot listen on a TCP port. The server refuses to start with it on any other platform, and on Linux a session start is refused when `socat` is not on `PATH`. |
| `agentAccounts` |  | Added agent accounts, each with `id`, `agent`, `label` and `folder` (the signed-in agent home that account runs from). A Claude Code account folder keeps its own login, `.claude.json` and org policy files, and links everything else to the real `~/.claude`; its `mcpServers` are copied from the real `.claude.json` at each spawn. |
| `agentAccountDefaults` |  | The account Add session preselects for a new session of each agent, keyed by agent id, for example `{ "claude-code": "claude-a1b2c3" }`. Unset, or naming an account that no longer exists, a new session runs on the machine's own login. Set it with Make default in Settings > General. A session from Quick session keeps its source session's account; sessions opened from an issue, a pull request or Arena run on the machine's own login. |
| `laneAccounts` |  | The Claude Code account each lane runs under, keyed by lane (`team-review`, `radar`, `community`, `task-title`, `question-manager`): an `agentAccounts` id, or `null` for the machine's own login. A lane left out runs under the Claude Code entry of `agentAccountDefaults`. Lanes running another agent always use the machine's own login. Set it in Settings > General. |
| `hooks` |  | Operator-defined hooks per project, managed from the dashboard Hooks panel. |
| `remote` | `{"port":null,"publicHost":"","allowedOrigins":[]}` | Remote listener, always on and answering paired devices only: `port` (a free port the system picks when unset, published in `~/.glimmervoid/remote-listener/<local port>.port`; must differ from the local port), `publicHost`, `allowedOrigins` and `ownerLogin` (when set, only that Tailscale login is answered; trustworthy only when the remote port is reached solely through HTTP-mode `tailscale serve`, since any other proxy, or `tailscale serve --tcp` or `--tls-terminated-tcp`, lets a client send its own `Tailscale-User-Login`), and `doormanUrl` (a doorman on another machine that hosts its watcher, https or http only for this machine; unset, the server starts its own doorman on this machine, kept in `~/.glimmervoid/doorman/<port>/`). Needs a server restart. See [Remote access](../README.md#remote-access). |
| `projects` | `[]` | Projects shown in the dashboard, added from the Add Session dialog. Each entry has `path` (required), optional `name`, `repos` (two or more member repositories for a workspace session), `baseBranch` (the branch sessions of this project start from and merge back into, set by Open in session on a team review pull request), `agent` (an agent id, see `customAgents`), `accountId` (the `agentAccounts` entry the session runs under; unset, the machine's own login) and `codexBypassHookTrust` (file-only, default off). |

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
| `GLIMMERVOID_MANAGED_BY` | operator | Name of whoever installs and pins this Glimmervoid, such as a hosting service. When set, Settings > Updates says that name manages the version, offers no update and the server makes no release check. |
| `GLIMMERVOID_POSTHOG_API_KEY` | operator | Supplies `posthog.apiKey`, overriding the stored value. It is stripped from every write, so a dashboard save never persists it. |
| `GLIMMERVOID_TELEGRAM_BOT_TOKEN` | operator | Supplies `telegram.botToken`, overriding the stored value. It is stripped from every write, so a dashboard save never persists it. |
| `GLIMMERVOID_SLACK_WEBHOOK_URL` | operator | Supplies `slack.webhookUrl`, overriding the stored value. It is stripped from every write, so a dashboard save never persists it. |
| `GLIMMERVOID_POSTHOG_READ_API_KEY` | operator | Supplies `posthog.readApiKey`, the read-only PostHog key the watcher uses, overriding the stored value. It is stripped from every write, so a dashboard save never persists it. |
| `GLIMMERVOID_GITHUB_READ_TOKEN` | operator | Supplies `github.readToken`, the read-only GitHub token lanes use for gh, overriding the stored value. It is stripped from every write, so a dashboard save never persists it. |
| `GLIMMERVOID_TELEMETRY` | operator | Set to `0` to turn off usage and error telemetry (error type, error code and scrubbed stack frames, never messages or paths) whatever `telemetry.enabled` says. `DO_NOT_TRACK=1` and `CI=true` turn it off too. |
| `GLIMMERVOID_TELEMETRY_PROJECT_TOKEN` | internal | Sends telemetry to another PostHog project instead of the Glimmervoid one, so end-to-end checks of a development build stay out of real usage data. Not an operator setting. |
| `GLIMMERVOID_DEBUG_SPAWN` | operator | Any non-empty value logs which executable each agent command resolved to at spawn. |
| `GLIMMERVOID_GITHUB_API_BASE` | internal | Points GitHub probes at a fake GitHub API for the end-to-end runs. Honored only on a loopback address; any other value is ignored with one warning. Not an operator setting. |
| `GLIMMERVOID_POSTHOG_INGEST_HOST` | internal | Sends telemetry to a fake PostHog ingest for the end-to-end runs. Honored only on a loopback address; any other value is ignored with one warning. Not an operator setting. |
| `GLIMMERVOID_SANE_YOLO_PATH` | internal | Names the Sane YOLO binary only in supervised sessions, so an installed Grok hook stays inert outside Glimmervoid. Not an operator setting. |
| `GLIMMERVOID_PACK_HOOK_FILES` | internal | Set by Glimmervoid in each session environment when an approved pack carries hooks; lists the hook files the hook tool relay runs before a tool call. Not an operator setting. |
| `GLIMMERVOID_HOOK_URL` | internal | Set by Glimmervoid in each session environment as the hook relay target. Not an operator setting. |
| `GLIMMERVOID_AGENT_URL` | internal | Set by Glimmervoid in each session environment; `glimmervoid push`, `spawn`, `attention` and `sessions` read it. Not an operator setting. |
| `GLIMMERVOID_MCP_TOKEN` | internal | Set by Glimmervoid in each supervised session environment as the bearer credential for the local Glimmervoid MCP endpoint. Not an operator setting. |
| `GLIMMERVOID_PR_ACTION_REPORT_URL` | internal | Set by Glimmervoid in the environment of each `prFlows.prActions` run; `glimmervoid pr-action report` posts the run outcome there. Not an operator setting. |
| `GLIMMERVOID_PR_ACTION_TOKEN` | internal | The per-run token `glimmervoid pr-action report` sends with a report; it stops working once the run has a final outcome. Not an operator setting. |
| `GLIMMERVOID_SIGN_URL` | internal | Set by Glimmervoid in each operator session environment; `glimmervoid ssh-sign`, which git runs to sign a commit, posts there so the server signs with the operator's forwarded ssh agent. Not an operator setting. |
| `GLIMMERVOID_GIT_CREDENTIAL_URL` | internal | Set by Glimmervoid in each operator session environment when no git credential helper already covers github.com; `glimmervoid git-credential`, which git runs as that helper, posts there so the server answers with the connected GitHub user token. Not an operator setting. |

## Telemetry

Glimmervoid sends usage and error events to its own PostHog project, under a random install id kept in `telemetry.json` in the Glimmervoid home (`~/.glimmervoid`, or `$GLIMMERVOID_HOME`). That id gets a PostHog person profile, which `app_started` and `app_active` fill with the first version, platform and install flavor seen. It never sends an account id, a hash of one or anything read from the login of another tool: GitHub is reported only as how it is reached. It never sends an email, a name, a token, a path on your machine, a repository, branch, session, prompt, notice text, error message from Glimmervoid or an agent, or terminal output, and stack frames are cut to the package or URL path. The data is used only to improve Glimmervoid: never sold, never used for marketing or sales. A crash is kept in `telemetry-pending-crash.json` beside it until the next start sends it, or deletes it unsent when telemetry is off. It prints a notice once on first start. Turn it off with `telemetry.enabled`, `GLIMMERVOID_TELEMETRY=0`, `DO_NOT_TRACK=1` or `CI=true`.

At start and once a day it also asks PostHog for the `telemetry-enabled` flag for its install id. It also checks when telemetry is turned back on. Once that flag comes back disabled it sends nothing, across restarts too, until a later check returns it enabled; a failed check or a missing flag changes nothing. The maintainers stop all sending by setting the flag's rollout to 0%; deactivating or deleting the flag does not stop installs, because PostHog then leaves it out of the answer. That request is skipped whenever telemetry is off.

Every event also carries `app_version`, `os_platform`, `node_major`, `install_flavor`, `is_bundled`, `is_dev_install`, where `is_dev_install` is true for a git clone, a source checkout or a Glimmervoid home other than `~/.glimmervoid`, plus `$release_id` on a published build linked to its PostHog release.

| Event | Properties | When |
|-------|------------|------|
| `app_started` | `is_first_start`, `$unset`, `$set_once`, `github_source`, `agent_account_count`, `agents_with_accounts`, `telegram_configured`, `pack_count`, `session_sandbox` | The server started listening, and whether this is the first start, with no Glimmervoid config file yet. Also sets the person properties: the first version, platform and install flavor seen. Also carries the setup: how GitHub is reached (gh, a connection made in Settings, or neither), how many agent accounts were added beyond the login each agent already has and for which kinds of agent, whether Telegram is set up, how many packs are listed and whether the session sandbox is on. Never a login, account name or path. |
| `app_active` | `active_session_count`, `watcher_probe_count`, `watcher_covered_probe_count`, `watcher_nudge_count`, `max_loop_lag_p99_ms`, `$unset`, `$set_once`, `github_source`, `agent_account_count`, `agents_with_accounts`, `telegram_configured`, `pack_count`, `session_sandbox` | Once a day while the server runs, with how many sessions are live, how many probes the watcher was handed and how many of them it covers, how many watcher nudges arrived since the last one, and the worst one-minute event loop delay (99th percentile, in milliseconds) the server saw since the last one, and the same person properties and setup as app_started. |
| `session_started` | `adapter` | A session spawned, with which kind of agent (any custom agent counts as `custom`). |
| `session_ended` | `adapter`, `exit_kind`, `duration_seconds` | A session ended: how it exited, or that it was removed, replaced by a settings change or stopped with the server, and how long it ran, in whole seconds. |
| `$exception` | `$exception_list`, `$exception_level` | An error in the server or the dashboard: its type, an error code when it has one, and stack frames with file paths cut to the package or URL path. Never the error message. Each distinct error is sent once per run, and a crash is sent on the next start. |
| `$ai_generation` | `$ai_trace_id`, `$ai_provider`, `$ai_model`, `$ai_input_tokens`, `$ai_output_tokens`, `$ai_cache_read_input_tokens`, `$ai_cache_creation_input_tokens`, `$ai_total_cost_usd`, `agent_adapter` | Per agent session and model, after each usage scan, for usage recorded in the last 24 hours: token counts, the model name and estimated cost, under a one-way hash of the session. A model name outside the shipped pricing table is sent as unknown. No prompts or output. |
| `command_hint_shown` | `command`, `adapter` | An agent was handed a one-time line naming a Glimmervoid command when its tool call made the command fit, with which command and which kind of agent. Never the tool call. |
| `command_hint_followed` | `command`, `adapter` | An agent ran a Glimmervoid command it had been handed a one-time line about earlier in the same conversation, with which command and which kind of agent. |
| `view_shown` | `view` | A dashboard tab opened, on desktop or phone, with which tab. Sent on every open. |
| `operator_action` | `surface`, `action` | An action taken in the Usage, Radar or Reviews tab, the first-run checklist or the GitHub star card: which surface and which action, from a fixed list. Never which repository, pull request, issue or session it was taken on. |
| `onboarding_step` | `step`, `state` | The first-run checklist moved a step to current or done, with which step. Sent once per change while the page is open. |
| `notice_shown` | `notice`, `tone`, `source`, `kind` | A notice the dashboard showed under its header: which notice (an error or warning, an available update, old reports left in a repository, or the telemetry notice), whether it was an error or a warning, which part of the dashboard raised it and, for a dependency install warning, the failure kind: tool-missing, failed or timed-out. Never the notice text. Each distinct notice is sent once per page load. |
| `dashboard_reconnected` | `trigger`, `ms_to_connected`, `handshake_ms`, `handshake_attempts`, `origin_kind`, `hidden_ms`, `was_tenant_waking` | The dashboard got its connection back after losing or replacing it: what started it (a long hide, a resume, a frozen page, a late or missed heartbeat, a slow handshake, a closed connection or a cloud machine waking), how long until connected, how long the handshake that won took and how many it took, whether the dashboard is on this machine, a tailnet or another host, how long the tab was hidden, and whether a cloud machine was waking. Never the host name or URL. |
| `board_opened` | `total_ms`, `tile_count`, `saved_layout_hit`, `slowest_step`, `slowest_step_ms`, `heap_mb` | The server opened a whiteboard for the dashboard: how long it took in all, how many tiles it sent, whether a saved layout let it skip laying the board out, which step was slowest and how long that took, and the server memory in use. Never the board, its id or its contents. |
| `team_review_drafted` | `inline_comment_count` | A team review draft became ready, with how many inline comments it drafted. |
| `team_review_settled` | `duration_ms`, `outcome`, `drafted_comment_count`, `posted_comment_count` | A team review draft was posted (approve, comment or approve-only), discarded, or restored from discarded (which undoes that discard), with how many inline comments were drafted and how many were posted, plus the total action duration in milliseconds. |
| `team_review_post_refused` | `duration_ms`, `reason` | Posting a team review was refused, with a reason from a fixed list and the total action duration in milliseconds. Never the error text. |
| `radar_investigation_finished` | `verdict`, `mode`, `error_reason` | A Radar investigation or fix run finished, with its verdict and mode, plus a reason from a fixed list when it ended in ERROR. Never the summary text. |
| `radar_fix_handoff_failed` | `step` | Committing or checking a Radar fix branch failed, with which step failed. Never the branch or the error text. |
| `data_deletion_requested` | none | Delete my data was confirmed in Settings > Privacy, with no properties. Sent under the old install id even when telemetry is off, unless the maintainers stopped all sending, and then the install id is replaced. PostHog deletes the person and every event under that id on receipt. |
| `watcher_probe_failing` | `lane`, `credential`, `failure_kind` | A watcher probe started failing: which lane and which kind of read credential it uses, and a failure kind from a fixed list. Never the URL, repository, token or error text. |
| `watcher_probe_recovered` | `lane`, `credential`, `failing_seconds` | A failing watcher probe answered again: which lane and kind of read credential, and how long it was failing, in whole seconds. |
| `watcher_nudge_received` | `lane`, `kind` | The watcher told a lane its answer changed or recovered: which lane and which of the two. Never the probe, URL or repository. |
| `vault_secret_answered` | `delivered_count`, `pending_count`, `denied_count`, `no_source_count`, `failed_count` | An agent asked for secrets by name and got its answer: how many names came back delivered, pending, denied, no source chosen or failed. Never the names, values or project. |
| `background_work_outlived_limit` | `adapter`, `kind`, `minutes_past_limit` | A subagent or background shell finished after the 30 or 60 minute limit past which Glimmervoid stops counting it as working, with which kind of agent, which kind of work and how many whole minutes past the limit. Never the task or its output. |
| `dependency_install_failed` | `tool`, `tool_major`, `cause` | Installing a new worktree's dependencies failed in one folder: which tool (npm or pnpm), its major version when Glimmervoid could read it, and the cause, one of tool-missing, timed-out, refused-argument, trust-downgrade, outdated-lockfile, unreadable-lockfile, registry-refused (the registry answered 4xx, such as a missing package or refused login), network or other. Never the folder, the repository, package names or the install output. |
| `idle_stop_requested` | `outcome`, `sessions_with_expired_work`, `expired_subagent_count`, `expired_shell_count` | The server asked to put its host to sleep after 20 awake minutes with no agent working, with the answer (stopping, no host to stop, or failed) and how many sessions, subagents and background shells were still unfinished past their limit at that moment. |

## Browser preferences

Stored in each browser, not in `config.json`, so every device keeps its own. Change them in Settings.

| Setting | Default | Notes |
|---------|---------|-------|
| Theme | `"glimmer"` | Color scheme for the dashboard. |
| Swipe arrow pad on phone | `false` | Swap the phone arrow keys for one pad you swipe on. |
| Flying animals | `false` | Show animated animals flying across the dashboard. |
| Alert sounds | `true` | Play a sound when a session needs you, like the note button in the header. |
| Alert sound | `"chime"` | Sound played when a session needs you, including files you add to ~/.glimmervoid/sounds/. |
| Desktop notifications | `true` | Notify you when a session needs you and the dashboard is in the background. |
| Reviewing now limit | `5` | How many pull requests the Reviews Reviewing now column holds at once. 0 means no cap. |
| Jump to the next session needing you | `"KeyJ"` | Key held with Cmd on a Mac, or Alt elsewhere, to jump to the next session that needs you. |
