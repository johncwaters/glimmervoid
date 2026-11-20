# Contributing

Pull requests are welcome. This page says what a mergeable one needs, so you know before you write code.

## Before you start

One change per pull request. A refactor riding along with a fix hides what each one changed.

## Set up

You need Node.js 24 (the version in `.nvmrc`), git, and an agent CLI such as Claude Code, Codex or Kimi Code to try sessions end to end. On Linux, also `build-essential` and `python3` for node-pty. `npm ci` does not run on Windows, because the `@posthog/coherence` dev dependency supports only macOS and Linux: develop in WSL, macOS or Linux.

```bash
git clone https://github.com/johncwaters/glimmervoid.git
cd glimmervoid
npm ci
npm run dev
```

`npm run dev` serves the dashboard on http://localhost:5173 with hot reload and the backend in the same process. `npm run build && npm start` runs the production build.

## Checks

CI does not run on pull requests: the test workflow runs only before a release, because Actions minutes are limited. You run the checks yourself, and all three must pass before merging:

```bash
npm run lint
npm run typecheck
npm test
```

`npm ci` also installs a pre-push hook (`.githooks/pre-push`) that runs the fast gates and the end-to-end scenarios your diff touches. Do not skip it with `--no-verify`.

`npm test` isolates itself: it points `GLIMMERVOID_HOME` at a throwaway directory and drops `GLIMMERVOID_POSTHOG_API_KEY` and `GLIMMERVOID_TELEGRAM_BOT_TOKEN`. Running a single file with `node --test` skips that, so lanes can reach live services and hang. Use the same preload instead:

```bash
node --import ./tests/helpers/isolate-home.ts --test tests/some.test.ts
```

Changed a setting, config key or environment variable? Run `npm run docs:config` and commit the regenerated `docs/configuration.md`. `tests/gates/config-docs.test.ts` fails otherwise.

Tests pass but you have not used the change? Run it in the dashboard first; the pull request template asks how you exercised it and for a screenshot of any UI change.

## Conventions

Code conventions, invariants and the architecture map are in [AGENTS.md](AGENTS.md) and the `AGENTS.md` nearest the code you touch. Tests enforce most of them, so a failing test usually names the rule. The ones no test checks:

- **Agent parity.** A session feature works on every first-class agent (Claude Code, Codex, Kimi Code, OpenCode, pi, Antigravity CLI), or the pull request says why one cannot.
- **No new dependencies** unless the maintainer agrees in the pull request.
- **No code comments.** Name or restructure instead.
- **Screenshots.** Any UI change carries a screenshot in the pull request.
- **Changelog.** Anything a user would notice gets a line under `## [Unreleased]` in `CHANGELOG.md`, which becomes the release notes.
- **Characters.** No em dash, en dash, ellipsis character or emoji in source, docs or commits.

## AI-assisted contributions

Welcome: this repo is built with coding agents, and `AGENTS.md` is written for yours. You stay the author: run the checks above and exercise the change yourself before opening the pull request.

## Commits and pull requests

Commit messages use Conventional Commits with a scope, as in the history: `feat(review): let Queue review re-run a ready draft`, `fix(git): run status probes without optional locks`.

Fill in every section of the pull request template.

## Merging

One maintainer handles pull requests as time allows, with no promised turnaround. The maintainer reruns the checks before merging, and the full CI matrix, macOS and Windows included, runs before each release. Your commits may be squashed or rebased onto `main`; you stay credited as the author.

Report security issues privately as described in [SECURITY.md](SECURITY.md), never in a pull request.
