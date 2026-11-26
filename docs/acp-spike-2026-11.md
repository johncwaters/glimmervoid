# ACP spike, 2026-11 (task P0.1)

Claude Code, Codex and Antigravity CLI were run over the Agent Client Protocol (ACP) with a throwaway client (`harness/acp-spike/`). Each agent ran in its own real git worktree of a scratch repository, logged in with its normal local login. All runs took place on 2026-11-25, on Linux, against commit f2af2dc.

## Verdict

**GO.** Rows 2, 4, 5, 7 and 9 pass for Claude Code and Codex. The `session spawn` check of row 2, which failed in the initial spawned-session run because a spawned session may not spawn, passed for all three agents when rerun from a top-level session (`mcp-toplevel.jsonl`). `operator-checks.sh` still covers the untested API-key logins, and its spawn step is no longer needed for the verdict.

Antigravity passes rows 4 through 8. Row 2 is partial for it, row 10 is blocked, and it stays first-class in Focus either way.

The Claude fallback driver is not needed: over ACP the Claude subscription login works (row 1 is partial only because the API-key login was not tested), and row 3 passes. The fallback would be one exception driver on `claude -p --input-format stream-json --output-format stream-json`, which `server/agent-models/agent-models.ts` already spawns. It was not built.

## What later tasks take from here

| Need | Value |
|---|---|
| SDK package (P2.2) | `@agentclientprotocol/sdk` 2.12.0 (npm `latest`); client entry `dist/v1/stable/acp.js`, API `client({ name }).onNotification(...).onRequest(...).connect(ndJsonStream(output, input))`, requests through `connection.agent.request` and `connection.agent.notify` |
| Claude Code launch (P2.8) | `npx -y @agentclientprotocol/claude-agent-acp@0.112.0` (ACP registry id `claude-acp`; also a binary `claude-agent-acp` per platform) |
| Codex launch (P2.8) | `npx -y @agentclientprotocol/codex-acp@2.12.0` (registry id `codex-acp`; the registry names this package, not `@zed-industries/codex-acp`, which is a separate package at 0.16.0) |
| Antigravity launch (P2.8) | `agy acp` (native subcommand of the Antigravity CLI, reports `Antigravity ACP Server` 1.5.17). The registry entry `antigravity-acp` 1.5.2 is a different download: the IDE extension's `agy_acp_server.par --uid=`. It was not tested here. |
| Protocol | `protocolVersion: 1`. All of these methods exist in the current schema at agentclientprotocol.com and were used: `initialize`, `session/new`, `session/prompt`, `session/update`, `session/request_permission`, `session/cancel`, `session/load`, `session/set_mode`, `session/set_config_option`, `elicitation/create` |
| Recorded exchanges (P2.2, P2.3, P2.4) | `harness/acp-spike/recordings/<agent>/<scenario>.jsonl`, one JSON line per wire message (`elapsedMs`, `direction`, `message`), with a matching `<scenario>.summary.json` |

The scenarios are `setup`, `mcp`, `resume`, `permissions`, `question`, `cancel`, `model`, `updates`, `subagents` and `hooks`. The extra Antigravity run `subagents-tmprepo` used a scratch repository under the temp folder. In the recordings, the MCP bearer token, API keys, JWTs, emails and account plan, label and organization are redacted; the home folder is written as `~` and the OS user name as `<user>`.

## Results

| Row | Claude Code | Codex | Antigravity |
|---|---|---|---|
| 1 Login | partial | partial | partial |
| 2 MCP | pass | pass | partial |
| 3 User setup | pass | pass | pass |
| 4 Resume | pass | pass | pass |
| 5 Permissions | pass | pass | pass |
| 6 Questions | pass | pass | pass |
| 7 Cancel | pass | pass | pass |
| 8 Model and effort | pass | pass | pass |
| 9 Updates | pass | pass | pass |
| 10 Subagents and background shells | pass | partial | blocked |

### 1. Login

Every agent ran on its existing local login with no `authenticate` call:

| Agent | Login used | Advertised `authMethods` | API key |
|---|---|---|---|
| Claude Code | Claude subscription (`claude auth status`: `authMethod: claude.ai`) | none (empty list) | blocked: no `ANTHROPIC_API_KEY` in this session |
| Codex | ChatGPT (`codex login status`) | `api-key`, `chat-gpt` | blocked: no `OPENAI_API_KEY` |
| Antigravity | Google account in the system keyring | `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform` | blocked: no `GEMINI_API_KEY` |

`harness/acp-spike/operator-checks.sh` prompts for each key without echoing it. It then runs `setup` once per agent: Claude with an empty `CLAUDE_CONFIG_DIR`, Codex with an empty `CODEX_HOME` plus `authenticate api-key`, and Antigravity with `authenticate gemini-api-key`. The Antigravity run cannot hide the keyring login, so its result does not show which login served the turn. The script writes `setup-apikey.*` recordings.

Claude's adapter also sends the notifications `_auth/status_update` and `auth/status_update`, which name the account's plan, email and organization; Codex's adapter sends the same pair with its plan and email. The recordings redact all of these.

Every Antigravity ACP log also contains `Not reloading plugin MCP servers: ... You are not logged into Antigravity.`, even though its turns ran normally. This report makes no recommendation on login policy.

### 2. MCP

The Glimmervoid HTTP MCP server was passed in `session/new` `mcpServers` as `{type: "http", name, url, headers}`.

- **Claude Code and Codex:** both called `whiteboard put` to add a box to a board and then remove it, `session limits`, and `session spawn`. All four completed (`mcp-toplevel.jsonl`; the initial `mcp.jsonl` completed the first three).
- **`session spawn`:** in the initial run (`mcp.jsonl`), Glimmervoid's schema rejected `spawn` (`action: Invalid option: expected one of "send"|"read"|...`) because the token belonged to the spike session, which was itself a spawned session, and `session limits` answers `spawn: a spawned session may not spawn another`. Rerunning from a top-level session on 2026-11-25 (`mcp-toplevel.jsonl`) succeeded for all three agents: Claude Code, Codex and Antigravity each called `session spawn` over ACP and Glimmervoid started a real session (`ok: true` with a `sessionId`; the three probe sessions were then closed). A first top-level attempt was refused with `at most 3 spawned sessions may be live at once` because the parent already had three children. The spawn step in `operator-checks.sh` is no longer needed for the verdict; the script remains for the untested API-key logins.
- **Antigravity:** its `initialize` reply advertises no `mcpCapabilities`, yet it attached the HTTP server and called `session` (`limits` and `spawn` both succeeded in `mcp-toplevel.jsonl`; in the initial `mcp.jsonl`, `spawn` hit the spawned-session refusal). It never exposed `whiteboard` or `show` to the model, though the server registers them for every client, so its row 2 stays partial. Both schemas use `$defs` and `$ref`, which is the likely cause. Sibling Antigravity sessions in Focus reach boards through the `glimmervoid whiteboard` CLI instead, so this is not specific to ACP.

### 3. User setup

The `setup` prompt asked each agent, without tools, for four things: the project canary from the scratch `AGENTS.md`, the operator's user-level instruction to say "carbon unit", whether the `gating-reviews` skill is listed, and whether `CAVEMAN MODE ACTIVE` (from a SessionStart hook) is in context. A `hooks` run then asked each agent to write a file containing `else`, which the operator's no-else PreToolUse hook blocks.

- **Claude Code:** all four checks passed, and 353 commands arrived in `available_commands_update`. The no-else hook denied the write with its verbatim message. The operator's Agent-tool hook also fired in `subagents`. The adapter read the operator's settings (its initial mode was `auto`).
- **Codex:** all four checks passed, and the `$skill` commands were listed. The no-else hook did not block `apply_patch`. A control run of plain `codex exec -s workspace-write` with the same prompt also wrote the file unblocked, so the gap is not caused by ACP.
- **Antigravity:** the canary, the user instruction and the skills all passed. It reported no SessionStart text, which is correct because the operator has no SessionStart hook configured for Antigravity. Its PreToolUse hooks fire over ACP: the no-else guard blocked the write, and the `spec-gate` hook blocked commands (see row 10).

### 4. Resume

In each run the client said a codeword, killed the agent process with SIGKILL, started a new process, and called `session/load` with the old `sessionId`. All three agents replayed the conversation through `user_message_chunk` and `agent_message_chunk`, then answered `ZEBRA-4127` (`resume.jsonl`). All three advertise `sessionCapabilities.resume`, `list` and `close`; Claude Code and Codex also advertise `fork`.

### 5. Permissions

The run first allowed an edit and a shell command, then rejected a second shell command. Claude ran in mode `default`, Codex in `read-only` and Antigravity in `default`, each set with `session/set_mode` (`permissions.jsonl`).

- **Claude Code:** the edit used options `allow-once`, `allow-with-updates` and `reject`. The shell command `touch` was allowed and the file was written. The shell command `rm` was rejected and the file stayed.
- **Codex:** the edit offered `allow_once`, `allow_for_session` and `cancel`. Shell commands offered `allow_once`, `accept_execpolicy_amendment` and `cancel`, where `cancel` has kind `reject_once`. Codex asks only when its sandbox blocks a command: a read-only `ls` and an unexplained `rm` ran or failed without asking. The `rm` reached `session/request_permission` only once the prompt invited Codex to ask for escalation.
- **Antigravity:** offered `allow` and `deny` for each of the edit, `touch` and `rm`, and every round trip worked.

### 6. Questions

The client answered the second choice each time. Every agent asked through `elicitation/create` in mode `form`, with a `requestedSchema` holding one `oneOf` property for the choices and one free-text "Other" property. All three replied `CHOSEN=Blue` (`question.jsonl`).

- **Claude Code:** the call is tied to the `AskUserQuestion` tool call by `toolCallId`.
- **Codex:** adds a "None of the above" option and sets `_meta.codex.delivery: "async"` ("Codex keeps working while you answer"). It does not send a `toolCallId`.
- **Antigravity:** uses option values such as `"1"` and `"2"`, with the text in `title`. It does not set `message` to the question.

### 7. Cancel

`session/cancel` was sent 3 s after the `tool_call` for `sleep 90`. Each `session/prompt` then returned `stopReason: "cancelled"` within 6 to 11 s, and the next prompt answered `AFTER-CANCEL-OK` (`cancel.jsonl`).

### 8. Model and effort

`session/new` returns `configOptions`. The model option has category `model` and the effort option has category `thought_level`. Each `session/set_config_option` returned the updated options and was followed by `config_option_update`.

| Agent | Model change | Effort change | Reported model after the change |
|---|---|---|---|
| Claude Code | `fable` to `default` | `effort` `high` to `default` | "Opus 5.5" |
| Codex | `gpt-6.1-sol` to `gpt-6.2-sol` | `reasoning_effort` `medium` to `low` | |
| Antigravity | `gemini-4-neon` to `gemini-4-carbon` | `thought_level` `high` to `low` | "Gemini 4 Carbon" |

### 9. Updates

`harness/acp-spike/trace-map.ts` builds a TraceRecord candidate from every recorded `session/update` and parses it with `shared/contracts/trace.ts`. Every candidate parsed (`trace-map.md`).

| `session/update` kind | TraceRecord kind | Seen from |
|---|---|---|
| `agent_message_chunk` | `assistant` (one per chunk; chunks need joining by `messageId`) | all |
| `agent_thought_chunk` | `thinking` | Codex, Antigravity |
| `user_message_chunk` | `prompt` (only during a `session/load` replay) | all |
| `tool_call` | `tool_call` (`toolCallId`, title, `rawInput`; Claude puts its tool name in `_meta.claudeCode.toolName`) | all |
| `tool_call_update` with status `completed` or `failed` | `tool_result` | all |
| `config_option_update` | `model-change` | all |
| `subagent_update` with state `running` or `idle` | `subagent` start and stop | Claude, Codex |
| `usage_update` (`used`, `size` context meter) | none; the per-turn token usage arrives in the `session/prompt` result | all |
| `session_info_update` (title, Codex thread status) | none | all |
| `available_commands_update` | none (command list) | all |
| `session_message` (text between parent and subagent) | none | Claude |
| `plan` | none observed, and TraceRecord has no plan kind | none |

Two gaps:

- **Plans:** no `plan` update arrived. Under the operator's setup, Claude has no TodoWrite tool, Codex did not call `update_plan`, and Antigravity's `update_steps` came through only as a `tool_call`.
- **Claude thinking:** no `agent_thought_chunk` arrived from Claude in any run.

### 10. Subagents and background shells

- **Claude Code:** the subagent runs inside the turn. `subagent_update` reports it with its child `sessionId` and state `running` then `idle`, and `session_message` carries text both ways. The background shell came back as an `execute` tool call with a shell id. The turn ended (`end_turn`, 11 s) while the shell was still running. When the shell finished about 35 s later, Claude sent `agent_message_chunk` updates outside any prompt turn. A client must accept updates while no prompt is open.
- **Codex:** reports its subagent through `subagent_update`, keyed by a child session id of the form `<thread>:subagent:<id>`. The `nohup ... &` background command did not survive the exec, so `bg.txt` was never written, and Codex sent no background-task signal.
- **Antigravity:** the operator's `spec-gate` PreToolUse hook denied both `run_command` and `invoke_subagent`, every time, including in a scratch repository under the temp folder. The attempts came through as `tool_call` updates. Nothing showed whether a subagent or a background shell would be reported.

## Recordings

| Recording | Used for |
|---|---|
| `recordings/<agent>/setup.jsonl` | initialize, session/new (modes, configOptions), the first prompt turn |
| `recordings/<agent>/resume.jsonl` | two processes in one file, with the kill note between them, then `session/load` and its replay |
| `recordings/<agent>/permissions.jsonl` | `session/set_mode`, then allow and reject `session/request_permission` round trips |
| `recordings/<agent>/question.jsonl` | `elicitation/create` and its answer |
| `recordings/<agent>/cancel.jsonl` | `session/cancel` during a tool call, and the next turn |
| `recordings/<agent>/model.jsonl` | `session/set_config_option` and `config_option_update` |
| `recordings/<agent>/mcp.jsonl`, `mcp-toplevel.jsonl` | MCP server attached in session/new, Glimmervoid tool calls, and the top-level `session spawn` rerun |
| `recordings/<agent>/subagents.jsonl` | `subagent_update`, `session_message`, and updates after a turn ends |
| `recordings/<agent>/updates.jsonl`, `hooks.jsonl` | thinking, plan tools, hook denials |

## Running it

Install the client dependencies outside the repository:

`npm install --no-save --no-package-lock --prefix ~/.cache/glimmervoid-acp-spike @agentclientprotocol/sdk@2.12.0`

Then, from inside a Glimmervoid session, run one scenario at a time. `--board` applies only to `mcp`:

`node harness/acp-spike/run.ts --agent claude|codex|antigravity --scenario <name> [--mode <mode id>] [--board <id>]`

Each run is billed. It overwrites that scenario's recording.
