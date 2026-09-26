# Contributing

## Prerequisites

- Node.js 24 (the version in `.nvmrc`, which CI also uses; the runtime floor is 22.18.0)
- Git, and the Claude Code CLI to exercise sessions end to end
- Linux: `build-essential` and `python3` for node-pty. Windows: Visual Studio Build Tools only if the node-pty prebuild does not load.

## Set up

```bash
git clone https://github.com/johncwaters/glimmervoid.git
cd glimmervoid
npm ci
npm run dev
```

`npm run dev` serves the dashboard with hot reload on http://localhost:5173 with the backend attached in the same process. `npm run build` then `npm start` runs the production build.

## Checks

All three must pass before a pull request is reviewed, and CI runs them on every push:

```bash
npm run lint
npm run typecheck
npm test
```

Unset `GLIMMERVOID_POSTHOG_API_KEY` and `GLIMMERVOID_TELEGRAM_BOT_TOKEN` before `npm test`, or tests for those lanes reach the live services and hang:

```bash
env -u GLIMMERVOID_POSTHOG_API_KEY -u GLIMMERVOID_TELEGRAM_BOT_TOKEN npm test
```

In PowerShell, `Remove-Item Env:GLIMMERVOID_POSTHOG_API_KEY, Env:GLIMMERVOID_TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue` first.

If you change a setting, a config key or an environment variable, run `npm run docs:config` and commit the regenerated `docs/configuration.md`; `tests/config-docs.test.ts` fails otherwise.

## Conventions

Code conventions, invariants and the architecture map live in [AGENTS.md](AGENTS.md) and the `AGENTS.md` nearest the code you touch. Most of them are enforced by tests, so a failing test usually names the rule.

## Commits and pull requests

Commit messages follow Conventional Commits with a scope, as in the history: `feat(review): let Queue review re-run a ready draft`, `fix(git): run status probes without optional locks`. User-visible changes also get a line under `## [Unreleased]` in `CHANGELOG.md`.

A pull request says what changed and why, lists the checks you ran, and is merged only with CI green. Report security issues privately as described in [SECURITY.md](SECURITY.md), not in a pull request or issue.
