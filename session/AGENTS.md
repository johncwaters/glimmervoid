<!-- Generated: 2026-07-03 -->

# session

## Purpose
The session domain: the stateful Session class (lifecycle, timers, hook ingestion) over a session driver, its always-on recorder, and the pure cores it delegates to.

## Key Files

| File | Description |
|------|-------------|
| `sessions.js` | Session class over a driver chosen at construction (`driver` option, PTY by default); a PTY session consumes StatusSource, an ACP session its driver's events, and both drive the 7-state machine |
| `session-background-tracking.js` | Stateful background-work, readiness-gate, and scheduled-wakeup collaborator |
| `screen-keeper.ts` | One headless xterm per live session (serialize addon via `createRequire`), owned by `session-output.ts` so the keeper and the ring see the same bytes; pure resize ordering in `core/screen-keeper-core.ts` |
| `drivers/` | `driver.ts` is the seam a session runs an agent through; `pty-driver.ts` owns the PTY, its spawn, paste path, resize and screen keeper, and with `server/node-pty-preflight.ts` and `server/agent-login/agent-connect.ts` is the only node-pty importer; `acp-driver.ts` runs an ACP agent on stdio over the ACP SDK (decisions in `core/acp-driver-core.ts`); `acp-agents.ts` resolves built-in and `config.acpAgents` launch rows (pure table in `core/acp-agents-core.ts`) |
| `session-recorder.js` | Always-on JSONL recorder of PTY data + signals; feeds `detection/replay.ts` |
| `hook-relay.js` | Standalone command-hook relay for a non-Claude agent CLI: stdin envelope to the local hook ingress, always exit 0; never required by the server (decisions in `core/hook-relay-core.ts`) |
| `adapters/` | One adapter per supervised agent CLI (`claude-code.js`, `codex.js`) plus the registry and its lazy per-agent command cache; see root `AGENTS.md` ("Agent Adapters") |
| `core/` | Pure cores of a SEAM EXTRACTION from `sessions.js`: no IO, no Session import (see `core/AGENTS.md`) |

## For AI Agents
- New Session logic that can be pure goes in `core/`; the class keeps only state and side effects.
- Status detection is structural (hooks + OSC-0 title). Never reintroduce PTY body/content scraping.
- See root `AGENTS.md` ("Status Detection", "Session State Machine") before touching transitions or the completion gate.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Session Spawning

- A PTY session spawns only by `pty.spawn` in `session/drivers/pty-driver.ts`; an ACP session spawns its agent on stdio only in `session/drivers/acp-driver.ts` through `server/child-process-safe.ts`, scrubbing env via `session/core/spawn-env.ts` and never using `shell: true`, so spawn sites stay auditable, command-injection free, and isolated from parent Glimmervoid secrets.
- Driver selection for every session spawn, load, and rebuild goes through `decideSessionDriver` in `session/core/session-driver-core.ts` so no caller chooses a driver on its own: Studio sessions take ACP (or stay stopped if their agent has no ACP row), and Focus sessions stay on PTY (pinned by the Studio ACP driver test).
- Claude CLI produces zero output with piped stdio, so a real PTY is required.
- Resolve-then-branch: a PE image spawns directly, a shim falls back to `cmd.exe /c`, avoiding cmd's double command-line parse and console-title write (`session/core/spawn-command.ts`).
- The env scrub removes the Glimmervoid marker vars, or Claude believes it runs inside itself. `acp-driver.ts` scrubs `launch.env` through `withoutGlimmervoidSecrets` and `npm_config_*`, then restores only allowlisted session-scoped URLs (`GLIMMERVOID_AGENT_URL`, `GLIMMERVOID_SIGN_URL`, `GLIMMERVOID_GIT_CREDENTIAL_URL`) passed in `DriverLaunch.sessionEnv`, so commands an ACP agent runs can call `glimmervoid` and git helpers without leaking server or parent secrets (`session/core/acp-driver-core.ts`).
- ACP sessions assemble Glimmervoid and pack MCP servers at start from `mcp/core/agent-config.ts` (`acpMcpServersFor`) into `DriverLaunch.mcpServers` for `session/new` and `session/load`, carrying pack bearer tokens in `headers` instead of env vars, and run in the same Linux systemd user scope as PTY sessions with `SessionDriver.scopeUnit` feeding `reapTreeOnce`.
- Built-in ACP rows (`session/core/acp-agents-core.ts`) pin exact adapter package versions and refuse `config.acpAgents` collisions on built-in ids so bug reports and pinned launches stay unambiguous.
- ACP adapter processes spawn in `<glimmervoidHomeDir>/acp` with `npm_config_*` scrubbed from `launch.env`, while `session/new` and `session/load` carry the repository `cwd`: an untrusted repo `.npmrc`, `node_modules/.bin`, or inherited `npm_config_*` would otherwise hijack `npx` before `initialize` (`session/drivers/acp-driver.ts`).
- On Linux with `graphical-session.target` inactive and no `DISPLAY` or `WAYLAND_DISPLAY` in the server env, a spawn gets `DBUS_SESSION_BUS_ADDRESS=disabled:`: Codex reads the portal at startup, and a portal woken before login never loads the desktop backend, breaking screenshots for the whole session. Probed per spawn, since a pre-login server never sees the display vars (`session/systemd-user.ts`).
- On Linux each spawn runs under `systemd-run --user --scope` in `app-glimmervoid-sessions.slice` when the probe passes: node-pty has no pre-exec hook, and scope mode execs in place, so the PTY pid stays the agent's. The session bus moves to `-E` because systemd-run cannot connect through `disabled:`. A scope leaves the server's cgroup, so it binds to the server's user unit (or a crash orphans it), and scopes stay off while that unit caps memory on itself, which a scope would escape (`session/core/session-scope-core.ts`).

### Auto-Resume and Shutdown

- The Claude session id is captured from WHICHEVER main-agent hook arrives: SessionStart does not reliably fire, and keying it there left boot auto-resume dead in production.
- It persists at HOOK time, not shutdown, which makes a hard kill lossless. Shutdown never writes config, since `wasActive` surviving IS the resume signal.
- Boot skips a session idle past `AUTO_RESUME_IDLE_CUTOFF_MS`. Its `lastWorkedAt` moves only when a turn starts or ends (or is first seeded), never on a boot resume that has one, or an idle tab never ages out.
- No captured id means dormant; never guess with `--continue`. A stale id fails the session, flipping `wasActive` false, so there is no retry loop.
- Every lane's `stop()` is awaited under a bound, or a restart runs a fresh backend while the old one still writes the same state file; an overrunning lane is named and left behind. Cleanup waits for the killed PTY tree's reap, a surviving handle inside a worktree having failed the discard and leaked the checkout.

### ACP Status

- An ACP session's state moves only on driver events, through the table in `session/core/acp-status-core.ts`: no hooks and no OSC title, since the driver's events are the structure (pinned against the hook fixtures by the ACP driver tests).
- An update outside a prompt turn never moves state: Claude sends chunks when a background shell ends after `end_turn`, and with no prompt open no turn-end would ever close the RUNNING it started (spike row 10).
- A turn-end closes every ask raised in that turn, and a later answer to one moves no state: after `session/cancel` an unanswered ask kept the session WAITING through every later turn (review of P2.4).
- PTY-only members are reached through `_pty` or `_terminal()`, which is null or throws on an ACP session, never by casting `_driver`.
- An ACP permission request or question is always held in the conversation approval path whatever the chat approvals mode: an ACP session has no terminal to fall back to. Option ids map per agent from the spike recordings, never by `kind` alone (the spec calls `kind` a UI hint); an unmapped option set is answered deny, or cancelled with no deny (`session/core/acp-ask-core.ts`).
- Interrupt, stop, turn-end, exit and a new run answer every open ask cancelled, as the spec requires after `session/cancel`, after closing the turn's asks in the status core so those answers move no state; an ask the agent withdraws is answered like any other. Codex async questions (`elicitation/create` with no `toolCallId`, `_meta.codex.delivery: "async"`) survive `turn-end` because Codex finishes the turn while waiting for the operator's answer, and are cancelled only on interrupt, stop, exit or a new run.
- Sane YOLO on ACP: Claude Code receives the Sane YOLO `PreToolUse` hook and env in `session/new` / `session/load` `_meta.claudeCode.options` and opens in `default` mode; Codex receives only the Sane YOLO `Bash` `PreToolUse` hook via `CODEX_CONFIG` plus `CC_SAFETY_NET_*` env and confirms trust before `session/new` / `session/load` via `_codex/hooks/list` and `_codex/hooks/trust` (no status hooks injected). `session-driver-asks.ts` also checks `session/request_permission` and auto-allows safe asks when `dangerouslySkipPermissions` is on. `Session.saneYolo` is `true` only when that coverage is confirmed (`false` if hook listing or trust fails).
- ACP session options and Codex ACP home: after `session/new` and `session/load`, `acp-driver.ts` applies configured model then effort via `session/set_config_option` by matching `configOptions` categories (`model`, `thought_level`) dynamically and failing soft on unoffered options/values. Codex ACP runs in its own generated or sandboxed `CODEX_HOME` (`agent-homes/codex/acp`, zero PTY status hooks) so `_codex/hooks/trust` never writes the operator's `~/.codex/config.toml` and `sessionSandbox` gets placeholder `auth.json`. ACP `turn-end` schedules `worktreeLifecycle.scheduleCheck()`.
- ACP questions route through `Session._questionManager` in `session-approval-holds.ts` before holding for the operator, matching PTY sessions.
- ACP message delivery queues in `session/chat-outbox.ts`, never in `acp-driver.ts`: the driver accepts one `session/prompt` when ready and refuses while opening or mid-turn, `isDeliveryInFlight` reads the ACP turn state, and `stopFromChat` cancels via `Session.interrupt()` (`session/cancel`) so Send next waits for `stopReason: "cancelled"` before draining.
- An ACP outbox port settles only `submitted` or `dropped` with no 15-second unrecorded timer and `shouldOpenTerminal` always `false`; `enterCheckTerminal()` is a no-op and `SessionSnapshot.hasTerminal` is `false` so Chat never offers Open Terminal on an ACP session.
- A prompt-stage JSON-RPC `RequestError` while the ACP connection is alive ends the turn, settles the unconfirmed prompt as `dropped` with the agent's error message, and leaves the session usable; only a closed connection or failed open kills the session (`session/core/acp-driver-core.ts`).
- Live ACP prompts are emitted on the first confirming turn-progress update, ask, or clean turn-end (ignoring pre-work metadata updates) so rejected prompts leave no phantom trace entry, and `trace-session-binding.ts` skips pre-open `session/load` replay updates when the session's trace file already has records.
