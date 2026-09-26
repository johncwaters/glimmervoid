# Glimmervoid

[![CI](https://github.com/johncwaters/glimmervoid/actions/workflows/test.yml/badge.svg)](https://github.com/johncwaters/glimmervoid/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg)](https://nodejs.org)
[![Platform: Windows | Linux](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-0078d4)](https://github.com/johncwaters/glimmervoid)

**Run dozens of Claude Code agents at once. See every session. Miss nothing.**

Running more than a couple of Claude Code agents at once turns into alt-tabbing between terminal windows, missing the exact moment one finishes or silently blocks on a prompt, and merging work you never watched happen. Glimmervoid is one browser dashboard with live terminal output for every session, exact status instead of a guess, and per-agent git worktrees you can review and merge without leaving the page.

Glimmervoid is developed inside Glimmervoid.

![Glimmervoid dashboard mid-run: two Claude Code sessions streaming live terminal output, one working, one flipping to Complete with its real output and worktree diff visible in the review sidebar](assets/pictures/glimmervoid-demo.gif)

## Quickstart

Windows:

```bash
npm install -g glimmervoid
glimmervoid
```

Linux (node-pty ships no Linux prebuilds, so it compiles at install time):

```bash
sudo apt install build-essential python3 git
npm install -g glimmervoid --allow-scripts=node-pty
glimmervoid
```

If `npm install -g` fails with `EACCES`, see [docs/troubleshooting.md](docs/troubleshooting.md#eacces-on-a-global-install); never use `sudo npm`.

Open http://localhost:3000. A fresh install knows no projects, so **+ Session** shows "No projects found" until you say where your repositories live: open **Settings**, then **Repositories**, and add the folder that holds your git checkouts under **Repository roots** (each subfolder becomes a project). For a one-off, **+ Session** then **Advanced options** takes a name and a path directly. That is the whole setup; everything else is optional.

To check notifications, allow them when the dashboard asks (or turn on **Desktop notifications** under **Settings**, **Appearance and alerts**) and keep a dashboard tab open. A notification only appears while that tab is not focused, since a focused tab already shows the change. With no dashboard tab open anywhere, only Telegram reaches you (the `telegram` keys in [docs/configuration.md](docs/configuration.md)).

The `--allow-scripts=node-pty` flag matters on npm 12, which blocks dependency install scripts by default. npm 10 and 11 run them by default (npm 11 prints a notice), so there the flag is unnecessary but harmless. If the native module still fails to load, the server refuses to start and prints the repair command; `glimmervoid doctor` runs the same check. See [docs/troubleshooting.md](docs/troubleshooting.md).

### From source

```bash
git clone https://github.com/johncwaters/glimmervoid.git
cd glimmervoid
npm ci
npm run build
npm start
```

Update a clone with `git pull --ff-only && npm ci && npm run build`, then restart the server. The dashboard's update check prints the right command for whichever way you installed.

## Requirements

- **Node.js >= 22.18.0** (the `engines` floor). npm 12 itself needs Node 22.22.2 or newer; distro-packaged Node is usually older than either, so use nodesource, nvm or the official installer.
- **Windows 11 or Linux.** macOS is untested.
- **Claude Code CLI** on PATH, or another supported agent below.
- **git** on PATH, for per-session worktrees.
- **Linux only:** `build-essential` and `python3` for node-pty.

## Supported agents

- **Claude Code** (`claude`), the default and the most complete: hooks, background agent gating, auto-resume, context packs.
- **Codex CLI** (`codex`), with hook-based status. Codex has no notification event, so a question it asks in prose looks like a finished turn.
- **Grok Build** (`grok`). Run `glimmervoid agent setup grok` once to install its hook relay.
- **Any other terminal agent**, declared under `customAgents` in `config.json` with an `id`, `label`, `command` and optional `args`, `idleTitle` and `busyTitle`. Custom agents get status from the terminal title only.

The Add Session dialog only offers agents whose command resolves on PATH, and `glimmervoid doctor` lists what it found. A project can default to an agent with `projects[].agent`.

## Usage

```
glimmervoid                   # start the server on port 3000
glimmervoid --port 3001       # start on another port
glimmervoid doctor            # diagnose the install, PATH, agents and native module
glimmervoid pair --name phone # mint a single-use pairing link for a remote device
glimmervoid --version
```

`glimmervoid --help` lists every command.

## Features

- Focus view: a roster rail of every session, the selected session's live terminal in the center, and a worktree review sidebar
- Per-session git worktree isolation: review and merge each agent's committed work from the dashboard while it keeps running
- Real-time terminal output via xterm.js with WebGL rendering
- Structural status detection: hooks as the authoritative signal, an OSC-0 title fallback, never screen scraping (see below)
- Background sub-agent completion gate: a session with live background agents or tasks stays out of Complete until they finish
- Browser notifications when a session needs input, finishes or fails
- Custom alert sounds: drop your own `.ogg`, `.mp3`, `.wav`, `.m4a` or `.webm` files into `~/.glimmervoid/sounds/` (or `$GLIMMERVOID_HOME/sounds/`) and pick one in Settings
- Phone layout as a first-class second layout: board, terminal and review screens, attention-first ordering, and a terminal that resizes around the soft keyboard instead of hiding behind it
- Remote access (opt-in): a separate listener with single-use device pairing and cookie auth
- Telegram notifications (opt-in), sent only when no dashboard tab is open anywhere
- Plan review: read, edit and approve a Claude Code plan from the dashboard or phone
- Usage tracking: token use and estimated cost from local Claude Code, Codex and Grok transcripts, with optional budgets
- Radar (opt-in): polls PostHog error tracking, pings Telegram when an issue spikes, regresses or first appears, and sends an agent to investigate; optional auto-fix opens a pull request the agent itself can never push or merge
- Team PR review (opt-in): drafts a review of each open pull request from a GitHub team in a sandboxed agent, optionally with your own Claude Code review skill (`teamReview.skill`); nothing posts until you choose Approve or Comment
- Auto-resume: sessions that were live when Glimmervoid stopped come back with their conversation resumed
- Hot-reloaded configuration and a Settings view for most of it

## Why the status detection is hard (and how Glimmervoid does it)

The obvious way to know if a Claude Code session finished, is waiting on you, or is still working is to scrape the terminal: watch for a prompt string, a spinner glyph, some text pattern. It breaks constantly. Every TUI redraw, every theme change, every Claude Code release that adjusts spacing invalidates the scrape. Glimmervoid never does this.

Instead, at spawn Glimmervoid injects Claude Code hooks scoped to that one session, no changes to the target repo, that POST to a local HTTP endpoint on every lifecycle event: prompt submitted, turn stopped, notification raised, sub-agent started or finished. These hooks are the authoritative signal. An OSC-0 terminal title fallback (spinner glyph = working, idle glyph = ready) covers the gap for anything that predates or bypasses the hooks. The two are merged with explicit precedence (hook beats title) and a short conflict window so a racing signal can still win before the UI settles.

That design didn't arrive whole. Three incidents shaped it:

`/clear` and `/compact` fire no `UserPromptSubmit` and no `Stop`, but the terminal redraw briefly flashes a spinner then an idle glyph in the title. Early on, that flash looked exactly like a finished work cycle, so Glimmervoid fired a "session complete" notification on every `/clear`. (The bug report was, more or less, "why did my terminal congratulate me for clearing the screen.") The fix: on a detected clear/compact, reset both signal sources and mute title-only signals until the next real prompt.

A background sub-agent (launched via `Task` with `run_in_background`, or Ctrl+B) can still be running when the main agent's own turn ends and its `Stop` hook fires. Treating that `Stop` as completion closed the card while real work was still happening in the background. The fix is a completion gate: Glimmervoid counts live sub-agents from `SubagentStart`/`SubagentStop` and reconciles that count against `background_tasks`, a field Claude Code's own hook payloads declare independently. Staleness between the two is resolved by a sequence number, not a timestamp, because concurrent signals routinely land in the same millisecond.

Boot auto-resume (reattaching a session's Claude conversation after Glimmervoid restarts) depends on capturing Claude's session id from a hook. It was wired to capture that id from `SessionStart`, which seemed reasonable until testing showed Claude Code doesn't reliably fire `SessionStart` on interactive startup at all, silently dead in production, no error, resume just never happened. The fix: capture the session id from whichever main-agent hook arrives first, since they all carry it.

Every session also writes a JSONL forensic recording by default (hook payloads and state transitions, not raw terminal bytes), and a version-aware replay harness drives recorded traffic back through the detection code as regression fixtures. That's how bugs like the ones above get diagnosed from real session data instead of guesswork, and how they stay caught if the logic regresses.

## Focus

Glimmervoid centers on one session at a time. A left **roster rail** lists one pill per session (grouped by project, with a live working heartbeat and a "needs you" queue); the **center** borrows that session's live terminal as the work surface; a right **review sidebar** shows its changes.

Every git-repo session runs in its own git worktree forked from the integration branch, so an agent's edits stay out of your main checkout until you review them. `integrationBranch` is unset by default, which means each repo's own default branch: `origin/HEAD`, then `main`, then `master`. The sidebar splits **Committed** (the mergeable unit) from **Uncommitted** work, keeps the diff live, and merges into the integration branch with one click while the session keeps running. If a merge hits conflicts it parks, and **Resolve in session** hands the conflict back to the agent that owns the worktree with a ready-to-run prompt.

Navigate it from the keyboard: `Alt+1`..`Alt+9` jump to a session, `Alt+Up`/`Alt+Down` move through the rail, `Alt+W` steps through the sessions needing attention, `Alt+M` / `Alt+R` merge or resolve the selected one, and `Alt+0` opens Add Session.

## Configuration

On first run Glimmervoid creates `~/.glimmervoid/config.json`. Most settings are edited from the dashboard's Settings view, and the server reloads the file when you edit it by hand. Every key, its default and every environment variable are in [docs/configuration.md](docs/configuration.md), which is generated from the code.

## Remote access

Remote access is off by default. It is a second loopback listener meant to sit behind an HTTPS reverse proxy, never a wider bind, and it is created only at startup:

1. Add a `remote` block to `~/.glimmervoid/config.json`. `enabled` defaults to `false`; `port` has no default and is required once enabled (it must differ from the local port); `publicHost` defaults to empty and is the hostname your proxy serves, used for shareable pairing links and the allowed origin.

   ```json
   {
     "remote": { "enabled": true, "port": 3456, "publicHost": "my-machine.example.ts.net" }
   }
   ```

2. Restart Glimmervoid (stop and start it, or `systemctl --user restart glimmervoid` when it runs as a service). The log line `Glimmervoid remote listener on http://127.0.0.1:3456 (paired devices only)` confirms the listener is up.
3. Point an HTTPS reverse proxy at that port. With Tailscale, `tailscale serve --bg 3456` serves `https://<machine>.<tailnet>.ts.net`, which is the name `publicHost` should hold.
4. Verify from the device: `https://<publicHost>/` should answer with Glimmervoid's "Pairing required" page.
5. On the host, run `glimmervoid pair --name phone`. It prints a single-use URL valid for 10 minutes that sets an auth cookie when opened on the device.

`glimmervoid pair --list` and `glimmervoid pair --revoke <id>` manage devices, and a revoke applies without a restart. A pairing grants full control of the machine as the server account, so treat pairing URLs as passwords.

## Security

Glimmervoid runs agents with your account's privileges and trusts every local process. Read [SECURITY.md](SECURITY.md) for the trust model and how to report a vulnerability, and [Limitations](#limitations) for the short version.

## Running as a service (Linux)

A systemd user unit keeps Glimmervoid running after you log out:

```ini
# ~/.config/systemd/user/glimmervoid.service
[Unit]
Description=Glimmervoid

[Service]
ExecStart=/usr/bin/env glimmervoid
EnvironmentFile=-%h/.glimmervoid/secrets.env
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now glimmervoid
loginctl enable-linger "$USER"
```

`secrets.env` is optional and can hold `GLIMMERVOID_POSTHOG_API_KEY` and `GLIMMERVOID_TELEGRAM_BOT_TOKEN`, which keeps both out of `config.json`. The unit's `PATH` must reach `node`, `glimmervoid` and your agent CLIs; with nvm, set `Environment=PATH=...` or point `ExecStart` at absolute paths. For a source checkout, use `ExecStart=/usr/bin/env node dist/server/index.js` with `WorkingDirectory=` set to the checkout.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Limitations

- **Windows 11 and Linux only.** macOS is untested.
- **Local-first, with an opt-in remote door.** By default Glimmervoid binds `127.0.0.1` and has no login on the local listener, so any local process can drive it. That is a deliberate single-user choice, and it means the local port must never be exposed to the network. Remote access is a separate listener gated by single-use pairing tokens and cookies, meant to sit behind a reverse proxy; a pairing cookie grants full code execution as the server account.
- **Requires an agent CLI.** Glimmervoid spawns and manages Claude Code (or another supported agent); it doesn't replace it.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

[MIT](LICENSE)
