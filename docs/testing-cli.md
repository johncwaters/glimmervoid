# Glimmervoid CLI Testing Guide

Manual checks for the CLI to run before cutting a release. See `distribution.md` for how a release ships.

Commands are given for bash; where PowerShell differs, it follows. Run them from the repo root of a checkout with dependencies installed (`npm ci`). `node bin/glimmervoid.ts` runs the CLI from source; after `npm run build`, `node dist/bin/glimmervoid.js` runs the built one that ships.

## Prerequisites

- Node.js >= 22.18.0 (`node --version`); npm 12 needs 22.22.2 or newer for the global install checks
- Windows 11 or Linux

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

Commands:
  doctor            Diagnose install / PATH issues and exit
  agent setup grok  Install Glimmervoid's env-inert Grok hook relay
  pair              Mint a single-use pairing link for a remote device
  pair --list       List paired devices
  pair --revoke <id>  Revoke a paired device
  visions relay     Run the Visions LSP relay on stdio (what an editor's LSP client spawns)
  visions install   Install the Visions extension into every VS Code family editor on PATH
  visions setup     Print LSP client config for Neovim, Helix, Emacs, Kate, Sublime, JetBrains
  visions status    Report the relay path and which editors carry the extension
  pack build [name] Build one context pack, or every spec
  pack list         List context pack specs and their built versions
  memory forget <id|pattern>  Expunge a remembered record
  memory backfill   Re-run the cold-start transcript backfill
  memory distill [--dry-run]  Rebuild the published projection from the canon
  spawn <prompt>    From inside a Glimmervoid session, start a sibling session on that prompt
  attention <note>  From inside a Glimmervoid session, flag it as needing the operator
  board             From inside a Glimmervoid session, list the live sessions

Options:
  --name <label>    Label for the device being paired (with: pair)
  --port <number>   Override the server port (default: 3000)
  --config <path>   Path to config file (default: ~/.glimmervoid/config.json)
  --version         Show version number
  --help, -h        Show this help message
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
Glimmervoid server listening on http://127.0.0.1:4567
```

Open http://localhost:4567 and check the dashboard loads, then stop the server with `Ctrl+C`. The seeded `config.json` is valid JSON with `port`, `projects`, `repoRoots` and the timing fields.

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

## Test 8: tarball contents

```bash
npm pack --dry-run
```

**Expected:** the built `dist/` tree plus `scripts/postinstall.mjs`, `scripts/recover-handoff.mjs`, `scripts/prepare-build.js`, `package.json`, `README.md` and `LICENSE`. No raw `.ts` source, no `docs/`, no `.claude/`, no `config.json`. `npm run release` refuses a tarball with raw `.ts` or without `dist/bin/glimmervoid.js`.

---

## Test 9: global install from the tarball

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
| 8 | `npm pack --dry-run` ships only built files | |
| 9 | Global install from the tarball runs and loads node-pty | |
