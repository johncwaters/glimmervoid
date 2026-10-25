# Contributing

## Set up

You need Node.js 24 (the version in `.nvmrc`, which CI uses), git, and an agent CLI such as Claude Code to try sessions end to end. On Linux, also `build-essential` and `python3` for node-pty.

```bash
git clone https://github.com/johncwaters/glimmervoid.git
cd glimmervoid
npm ci
npm run dev
```

`npm run dev` serves the dashboard on http://localhost:5173 with hot reload and the backend in the same process. `npm run build && npm start` runs the production build.

## Checks

CI runs these on every push, and all three must pass before review:

```bash
npm run lint
npm run typecheck
npm test
```

`npm test` isolates itself: it points `GLIMMERVOID_HOME` at a throwaway directory and drops `GLIMMERVOID_POSTHOG_API_KEY` and `GLIMMERVOID_TELEGRAM_BOT_TOKEN`. Running a single file with `node --test` skips that, so lanes can reach live services and hang. Use the same preload instead:

```bash
node --import ./tests/helpers/isolate-home.ts --test tests/some.test.ts
```

Changed a setting, config key or environment variable? Run `npm run docs:config` and commit the regenerated `docs/configuration.md`. `tests/gates/config-docs.test.ts` fails otherwise.

## Conventions

Code conventions, invariants and the architecture map are in [AGENTS.md](AGENTS.md) and the `AGENTS.md` nearest the code you touch. Tests enforce most of them, so a failing test usually names the rule.

## Commits and pull requests

Commit messages use Conventional Commits with a scope, as in the history: `feat(review): let Queue review re-run a ready draft`, `fix(git): run status probes without optional locks`. Anything a user would notice also gets a line under `## [Unreleased]` in `CHANGELOG.md`, which becomes the release notes.

A pull request says what changed and why and lists the checks you ran. It merges only with CI green. Report security issues privately as described in [SECURITY.md](SECURITY.md).
