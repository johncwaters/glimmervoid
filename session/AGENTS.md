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

- Claude CLI produces zero output with piped stdio, so a real PTY is required.
- Resolve-then-branch: a PE image spawns directly, a shim falls back to `cmd.exe /c`, avoiding cmd's double command-line parse and console-title write (`session/core/spawn-command.ts`).
- The env scrub removes the Glimmervoid marker vars, or Claude believes it runs inside itself. Note that `acp-driver.ts` scrubs `launch.env` through `withoutGlimmervoidSecrets`, which also strips `GLIMMERVOID_SANE_YOLO_PATH`; ACP agent rows therefore name only command and arguments, and any future ACP row or caller that needs env vars must account for that scrub.
- Built-in ACP rows (`session/core/acp-agents-core.ts`) pin exact adapter package versions and refuse `config.acpAgents` collisions on built-in ids so bug reports and pinned launches stay unambiguous.
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
