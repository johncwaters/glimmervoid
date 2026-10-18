# CLI release checks

Manual checks to run on the CLI before cutting a release. [distribution.md](distribution.md) covers how a release ships.

Run them from the root of a checkout after `npm ci`. Commands are bash, with PowerShell after them where it differs. `node bin/glimmervoid.ts` runs the CLI from source; after `npm run build`, `node dist/bin/glimmervoid.js` runs the built one that ships.

## Prerequisites

- Node.js >= 22.18.0 (`node --version`); npm 12 needs 22.22.2 or newer for the global install checks
- Windows 11, Linux or macOS

## Config resolution order

1. `--config <path>`, which sets `GLIMMERVOID_CONFIG`. The file must exist.
2. `config.json` under `GLIMMERVOID_HOME`, when that is set.
3. `~/.glimmervoid/config.json`.
4. If the file from step 2 or 3 does not exist, it is created with defaults.

The tests below point `GLIMMERVOID_HOME` at a scratch directory so they never touch your real config.

```bash
export GLIMMERVOID_HOME="$(mktemp -d)"
```

```powershell
$env:GLIMMERVOID_HOME = Join-Path $env:TEMP "glimmervoid-cli-test"
New-Item -ItemType Directory -Force $env:GLIMMERVOID_HOME | Out-Null
```

---

## Test 1: `--help` and `-h`

```bash
node bin/glimmervoid.ts --help
node bin/glimmervoid.ts -h
```

**Expected:** both print the same usage text and exit 0. `tests/cli-docs.test.ts` pins this block to the real output:

```
Usage: glimmervoid [command] [options]

With no command, starts the server.

Commands:
  doctor              Check the install, PATH, agent CLIs and native module, then exit
  settings <cmd>      Read and change config.json: list, get, set, unset, search, schema (each takes --json)
  pair                Mint a single-use pairing link for a remote device
  pair --list         List paired devices
  pair --revoke <id>  Revoke a paired device
  agent setup grok    Install the Grok hook relay, which does nothing outside Glimmervoid
  coherence check     Walk every Coherence stage for a project and print PASS, FAIL or SKIP per stage
                      (--project <id or path>, default the current repo; --json)

Editor integration (Visions):
  visions install     Install the Visions extension into every VS Code family editor on PATH
  visions uninstall   Remove the Visions extension and the editor config it wrote
  visions setup       Print LSP client config for Neovim, Helix, Emacs, Kate, Sublime, JetBrains
  visions status      Show the relay path and which editors have the extension
  visions relay       Run the Visions LSP relay on stdio (an editor's LSP client starts this)

Inside a Glimmervoid session:
  spawn <prompt>      Start a sibling session on that prompt
  attention <note>    Flag this session as needing the operator
  board               List the live sessions
  push                Land this session's commits on the integration branch and push it
  edit <path>         Open a text file for the operator to edit in the dashboard
  limits              List which of these commands answer here and what the guardrails block
  factory status      Print each factory intent's tickets, state, last reason and next action
  factory retry <id>  Reopen the parked tickets of a factory intent
  factory setup       Prove and save the factory checks of this session's repository
  factory queue <file> Queue a factory intent (a spec cut.ts file or Factory tab request) on this session's repository
  ssh-sign            Sign a commit with the operator's forwarded ssh agent (git runs this)

Experimental:
  kg [command]        Typed knowledge and task graph (Settings > Lanes > Knowledge graph)

Options:
  --port <number>     Server port (default: 3000)
  --config <path>     Config file (default: ~/.glimmervoid/config.json)
  --name <label>      Name for the device being paired (with pair)
  --no-open           Do not open the dashboard in a browser on first start
  --version           Print the version
  --help, -h          Print this help
```

---

## Test 2: `--version`

```bash
node bin/glimmervoid.ts --version
```

**Expected:** the `version` field of `package.json`, exit 0.

---

## Test 3: default config seeding and `--port`

```bash
node bin/glimmervoid.ts --port 4567
```

**Expected output includes:**

```
Created default config at <GLIMMERVOID_HOME>/config.json

  GLIMMERVOID <version>

  Open http://localhost:4567  opened in your browser

  Anonymous usage data is on. Never paths, prompts or output. Details: https://github.com/johncwaters/glimmervoid/blob/main/docs/configuration.md#telemetry
  Turn it off in Settings > Privacy, or GLIMMERVOID_TELEMETRY=0.

  Ctrl+C stops the server.
```

The two telemetry lines print only on the first start. On a first start from a terminal the dashboard opens in a browser and the Open line says so; `--no-open`, piped output and later starts print the same lines without opening anything. Check the dashboard loads, then stop the server with `Ctrl+C`. The seeded `config.json` is valid JSON with `port`, `projects`, `repoRoots` and the timing fields.

---

## Test 4: `--config` with an explicit path

```bash
node bin/glimmervoid.ts --config "$GLIMMERVOID_HOME/config.json" --port 4568
```

```powershell
node bin/glimmervoid.ts --config "$env:GLIMMERVOID_HOME\config.json" --port 4568
```

**Expected:** the server starts on port 4568 with no "Created default config" line. `Ctrl+C` to stop.

---

## Test 5: `--config` with a missing file

```bash
node bin/glimmervoid.ts --config ./does-not-exist.json
```

**Expected:** `Config file not found: <absolute path>/does-not-exist.json`, exit 1.

---

## Test 6: `glimmervoid doctor`

```bash
node bin/glimmervoid.ts doctor
```

**Expected:** a read-only report with no server started and nothing written: versions, where the CLI runs from, the npm (and pnpm, if present) global bin directory and whether each is on PATH, the agent CLIs that resolve, the rtk binary, a `node-pty` load probe, and the resolved config path. Exit 0 even when node-pty fails to load, so read the NATIVE MODULE section.

---

## Test 7: `glimmervoid pair`

Enable the remote listener in the scratch config and start the server in one terminal:

```bash
cat > "$GLIMMERVOID_HOME/config.json" <<'JSON'
{ "port": 3455, "remote": { "enabled": true, "port": 3456 }, "projects": [] }
JSON
node bin/glimmervoid.ts
```

```powershell
'{ "port": 3455, "remote": { "enabled": true, "port": 3456 }, "projects": [] }' | Set-Content -Encoding UTF8 "$env:GLIMMERVOID_HOME\config.json"
node bin/glimmervoid.ts
```

In a second terminal with the same `GLIMMERVOID_HOME`:

```bash
node bin/glimmervoid.ts pair --name Phone
```

**Expected output includes:** `http://127.0.0.1:3456/pair/<token>` and `Treat this link like a password.` Opening the link in a browser pairs it.

```bash
node bin/glimmervoid.ts pair --list
```

**Expected:** a table with `ID`, `NAME`, `PAIRED`, `LAST SEEN` and `STATUS`, with a row named `Phone` once the link was opened (a minted but unopened link does not list).

```bash
node bin/glimmervoid.ts pair --revoke <id>
node bin/glimmervoid.ts pair --list
```

**Expected:** `Revoked <id>. A running Glimmervoid applies this within 30 seconds, no restart needed.`, then the row shows `revoked`. All three commands exit 0. Stop the server with `Ctrl+C`.

---

## Test 8: `glimmervoid settings`

With the scratch config from Test 7 still in place and no server running:

```bash
node bin/glimmervoid.ts settings schema --json
node bin/glimmervoid.ts settings search spike --json
node bin/glimmervoid.ts settings get posthog.trafficSpikeEnabled
node bin/glimmervoid.ts settings set posthog.trafficSpikeEnabled false
node bin/glimmervoid.ts settings set posthog.trafficSpikeEnabled maybe
node bin/glimmervoid.ts settings set remote.enabled false
node bin/glimmervoid.ts settings set telegram.botToken 123456:EXAMPLE
node bin/glimmervoid.ts settings unset posthog.trafficSpikeEnabled
node bin/glimmervoid.ts settings list
```

**Expected:** `schema` prints a JSON array with one entry per setting carrying `id`, `path`, `type`, `default`, `unit`, `effect` and `section`, and creates nothing under `GLIMMERVOID_HOME` when run without a `config.json`. `search spike` lists the settings with spike in their title first, `posthog-traffic-enabled` among them. `get` prints `posthog.trafficSpikeEnabled = true (default)`. The first `set` prints the new value and `A running Glimmervoid applies it without a restart.`, and `config.json` now carries `"trafficSpikeEnabled": false` next to a `config.json.bak` of the previous content. `set ... maybe` exits 1 with `posthog.trafficSpikeEnabled must be a boolean` and leaves the file untouched. `set remote.enabled` exits 1 with a message that names `config.json`, because the remote listener is not a registry setting. `set telegram.botToken` exits 1 with a message naming Settings > Telegram and `GLIMMERVOID_TELEGRAM_BOT_TOKEN`, and `config.json` stays without the token, because the command never takes or removes a secret. `unset` removes the key and names the default. `list` prints one table per settings section; a Telegram bot token or PostHog API key shows as `configured` or `not configured`, never as its value. Start the server, run the first `set` again, and the server log prints `[config] Reloaded config.json` without a restart.

---

## Test 9: tarball contents

```bash
npm pack --dry-run
```

**Expected:** the built `dist/` tree plus `scripts/postinstall.mjs`, `scripts/recover-handoff.mjs`, `scripts/prepare-build.js`, `package.json`, `README.md` and `LICENSE`. No raw `.ts` source, no `docs/`, no `.claude/`, no `config.json`. `npm run release` refuses a tarball with raw `.ts` or without `dist/bin/glimmervoid.js`.

---

## Test 10: global install from the tarball

```bash
npm pack
npm install -g ./glimmervoid-<version>.tgz --allow-scripts=node-pty
glimmervoid --version
glimmervoid doctor
npm uninstall -g glimmervoid
```

**Expected:** the version matches, and doctor reports `node-pty  loads OK`. This is the same check the packaged install step in `.github/workflows/test.yml` runs.

---

## Environment isolation

`GLIMMERVOID_PORT`, `GLIMMERVOID_CONFIG`, `GLIMMERVOID_HOOK_URL` and `GLIMMERVOID_AGENT_URL` must never leak into an agent the session did not intend to receive them. The scrub is `buildAgentEnv` in `session/core/spawn-env.ts`, pinned by `npm test`; nothing to run by hand.

---

## Checklist

| # | Test | Pass? |
|---|------|-------|
| 1 | `--help` and `-h` print usage, exit 0 | |
| 2 | `--version` prints the package.json version | |
| 3 | Seeds a default config and starts on `--port` | |
| 4 | `--config <path>` uses that file | |
| 5 | `--config <missing>` errors with exit 1 | |
| 6 | `doctor` prints a read-only report, exits 0 | |
| 7 | `pair` mints, lists and revokes a device | |
| 8 | `settings` reads, validates and writes `config.json`, masks secrets and refuses to write them, refuses non-registry keys | |
| 9 | `npm pack --dry-run` ships only built files | |
| 10 | Global install from the tarball runs and loads node-pty | |
