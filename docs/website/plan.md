# Website plan and handoff

State of the public website work as of 2026-10-01, written so another agent can pick it up. The code and `AGENTS.md` win over this file when they disagree.

## Decisions already made by the operator

- Positioning: Glimmervoid is an agent orchestrator ("mission control for your coding agents"), never a "harness". The README, `PRODUCT.md`, the root `AGENTS.md` purpose line and the `package.json` description already say this (commit 9f37b0e).
- Framework: Astro.
- Copy: short. The operator rejected the first draft as "very wordy". Prefer graphics and animation over prose.
- Visuals: HTML, CSS and SVG animation, no stock video. The 19 real flying animal sprites from the dashboard appear on the site.
- Realism: any dashboard UI shown on the site must be the real dashboard, never a hand-built mock ("otherwise its just fake"). The chosen approach is replaying real recorded sessions through an isolated Glimmervoid and recording it with Playwright (see Capture below).
- Install: one command, `npx glimmervoid` once the package is on npm. Until then every surface shows the release tarball command (below).

## Site

- Lives in `site/`, an Astro static site that is its own npm package (`npm --prefix site install` once).
- `npm run site:dev` serves it with reload; `npm run site:build` writes `site/dist/`. `.github/workflows/site.yml` deploys every main push touching `site/`, `public/` or `shared/` to GitHub Pages at https://johncwaters.github.io/glimmervoid/ (Astro `base: '/glimmervoid'`), and the `site` job in `test.yml` builds it on every PR.
- The flying animals come from the dashboard at build time: `site/src/lib/animal-styles.ts` rescopes the block in `public/style.css` to `.sky`, and the animal list is `public/nyan-animals.ts`, so the site cannot drift from the product.
- The hero plays `site/public/capture/dashboard.webm` (poster `hero.webp`) through `DashboardRecording.astro`: the real dashboard replaying recorded sessions. Everything else is a diagram, not a picture of the UI, so it may stay hand-built.

## Capture tool

Goal: a repeatable `npm run site:capture -- <manifest.json>` that boots an isolated Glimmervoid (temp `GLIMMERVOID_HOME`, temp config, free high port, as `test/browser/harness.ts` does), runs sessions whose `claude` binary is a replay shim, and records the real dashboard to `capture.webm` plus PNG stills in `test/site-capture/out/` (gitignored).

Files under `test/site-capture/`:

- `replay-agent.ts`: plays the `data` and `hook` records of a session recording (`session/session-recorder.ts` format) with idle gaps compressed, applies same-length redactions so terminal columns never shift, applies an optional `git format-patch` at a named hook event so the review sidebar shows a real commit, and warns when the live PTY size differs from the recording.
- `manifest-core.ts`: Zod manifest (viewport, speed, maxIdleGapMs, redactions, sessions, shots, videoMs) plus pure `compressTimeline` and `redactSameLength`, tested in `tests/site-capture-core.test.ts`.
- `capture.ts`: the runner. It never touches `~/.glimmervoid` or a running server.
- `fixtures/`: one synthetic recording and `sample-manifest.json`. Real recordings are never committed.

Status: built. `npm run site:capture -- test/site-capture/fixtures/sample-manifest.json` produces `capture.webm` and three PNGs of the real dashboard (states driven by replayed hooks, redaction applied, a real commit in the review sidebar). Known gaps: the synthetic fixture is 80x24 while a 1440x900 viewport gives the terminal 99x48, so real recordings must be made at the capture's terminal size; projects show as `project-0`/`project-1` rather than the manifest's names; Playwright video needs its ffmpeg once (`node node_modules/playwright-core/cli.js install ffmpeg`).

## Recording real sessions

`npm run site:record -- test/site-capture/fixtures/demo-record.json` seeds the demo repos in `fixtures/demo/`, boots its own isolated Glimmervoid (own home, config, port and TMPDIR), runs the real `claude` with the operator's login but no user settings, plugins or MCP servers, types each task, and writes recordings and patches to the gitignored `test/site-capture/recordings/`. Then `npm run site:capture -- test/site-capture/fixtures/demo-capture.json --out test/site-capture/out/demo` produces the stills and webm. The hero video is that webm with the first 5.25 seconds (loading and the folder-trust prompt) cut, re-encoded with Playwright's ffmpeg; the README GIF is frames 5.25s to 17s at 4 fps and 960 px.

## Open issues before launch

- The `glimmervoid` package is not on npm yet. Until the first manual publish (see `distribution.md`), `.github/workflows/release-tarball.yml` attaches `glimmervoid.tgz` to each release and the site, README and the update check for npx launches use `npx --allow-remote=root --allow-scripts=node-pty <release tarball url>`, verified on Linux with npm 10, 11 and 12 (npm 12 refuses remote tarballs without `--allow-remote`, and skips the node-pty build without `--allow-scripts`). After the publish, switch all three back to `npx glimmervoid`: the URL builders in `server/core/update-core.ts`, `INSTALL_COMMAND` in `site/src/lib/install-command.ts`, and the README quickstart.
- Windows and macOS have not run the tarball command yet.
