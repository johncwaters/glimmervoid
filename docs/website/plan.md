# Website plan and handoff

State of the public website work as of 2026-10-01, written so another agent can pick it up. The code and `AGENTS.md` win over this file when they disagree.

## Decisions already made by the operator

- Positioning: Glimmervoid is an agent orchestrator ("mission control for your coding agents"), never a "harness". The README, `PRODUCT.md`, the root `AGENTS.md` purpose line and the `package.json` description already say this (commit 9f37b0e).
- Framework: Astro.
- Copy: short. The operator rejected the first draft as "very wordy". Prefer graphics and animation over prose.
- Visuals: HTML, CSS and SVG animation, no stock video. The 19 real flying animal sprites from the dashboard appear on the site.
- Realism: any dashboard UI shown on the site must be the real dashboard, never a hand-built mock ("otherwise its just fake"). The chosen approach is replaying real recorded sessions through an isolated Glimmervoid and recording it with Playwright (see Capture below).
- Install: one command, `npx glimmervoid`.

## Draft page

- Source: `docs/website/draft.template.html`. Build with `node scripts/build-site-draft.ts`, which inlines the flying animal CSS from `public/style.css` (rescoped from `:root[data-flying-animals="true"]` to `.sky`) and writes `dist/site-draft.html`.
- Every section carries a purple tag naming the Astro component it becomes: `Hero.astro + LiveConsole.astro`, `SignalFlow.astro`, `WorktreeFlow.astro`, `Features.astro`, `Agents.astro`, `Animals.astro`, `Install.astro`. Delete the tags and the top draft bar when porting.
- `LiveConsole` in the hero is a hand-built mock and must be replaced by captured video and stills before launch. Everything else is a diagram, not a picture of the UI, so it may stay hand-built.

## Capture tool (in progress)

Goal: a repeatable `npm run site:capture -- <manifest.json>` that boots an isolated Glimmervoid (temp `GLIMMERVOID_HOME`, temp config, free high port, as `test/browser/harness.ts` does), runs sessions whose `claude` binary is a replay shim, and records the real dashboard to `capture.webm` plus PNG stills in `test/site-capture/out/` (gitignored).

Planned files under `test/site-capture/`:

- `replay-agent.ts`: plays the `data` and `hook` records of a session recording (`session/session-recorder.ts` format) with idle gaps compressed, applies same-length redactions so terminal columns never shift, applies an optional `git format-patch` at a named hook event so the review sidebar shows a real commit, and warns when the live PTY size differs from the recording.
- `manifest-core.ts`: Zod manifest (viewport, speed, maxIdleGapMs, redactions, sessions, shots, videoMs) plus pure `compressTimeline` and `redactSameLength`, tested in `tests/site-capture-core.test.ts`.
- `capture.ts`: the runner. It never touches `~/.glimmervoid` or a running server.
- `fixtures/`: one synthetic recording and `sample-manifest.json`. Real recordings are never committed.

Status: being written by a Codex run in the worktree of the agent that wrote this file. If `test/site-capture/` is missing or incomplete on `main`, rebuild it from the bullets above. Done means `npm run typecheck`, `npm run lint` and `npm test` pass, and the sample manifest produces a non-empty webm and PNGs with no stray processes left.

## Recording real sessions (operator step)

1. Make 3 or 4 throwaway demo repos with no private code or names in them.
2. Turn on `capture: { enabled: true }` in the Glimmervoid config, restart when convenient, and run real Claude Code sessions on those repos with the terminal pane at the size the manifest viewport will use.
3. Copy the JSONL files from `~/.glimmervoid/recordings` into an ignored folder, list them in a manifest, and add redactions for the operator's name, home path and anything else personal.
4. Run the capture, pick the stills, and swap them into `Hero.astro` in place of `LiveConsole`.

The current README demo GIF shows the old "GLISSA" wordmark and personal details; replace it from the same capture.

## Open issues before launch

- The `glimmervoid` package is not on npm yet (`npm view glimmervoid` returns 404), so `npx glimmervoid` and the README's `npm install -g` both fail. The first publish is manual; see `distribution.md`.
- Linux: npm 12 blocks install scripts, and the update flow adds `--allow-scripts=node-pty` for that reason. Check whether `npx glimmervoid` on Linux needs the same flag (`npx --allow-scripts=node-pty glimmervoid` or similar) and fix the draft's Linux block to match what actually works.
- The update check knows global installs and clones only. Decide what it should offer to someone who launched with `npx`.
- Offered to the operator, not yet accepted: setting the GitHub repo description and topics to match the new positioning, and scaffolding the Astro project.
