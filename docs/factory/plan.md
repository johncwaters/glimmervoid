# Factory plan and handoff

This file records the state of the Factory lane as of 2026-10-11, so that another agent can continue the work. Where it disagrees with the code or `AGENTS.md`, the code and `AGENTS.md` are right.

## Goal and operator decisions

- Glimmervoid runs a software factory over the `@danilocampos/coherence` ledger, pinned exactly at `0.37.1` and run out of process. The operator queues intents and is paged only on exceptions. The end goal is for glimmervoid to run the factory on itself.
- The factory has a master orchestrator Claude session for each repo. It decomposes an intent into coherence work orders and calls `glimmervoid dispatch <workId>`. Glimmervoid then takes these deterministic steps:
  - admission;
  - the fence check;
  - its own checks;
  - a reviewer that never wrote the code;
  - merge;
  - a watch window;
  - a separate verifier session that closes the intent.
- The aim is near-zero intervention. There are no approval clicks; risk is managed by tiered guardrails instead.
- Everything sits behind the Factory setting, which is off by default. The Focus tab is untouched.
- Every agent lane gets one shared lockdown, the lane posture module (`server/core/lane-posture-core.ts`, with `server/lane-posture.ts` as its IO shell). It provides dontAsk permissions, a filesystem and network sandbox, and a required Sane YOLO hook. Do not add per-lane sandbox patches; extend the module instead. It names no factory concepts, so that team review, benchmarks and issues can adopt it.
- Security hardening is a separate, later pass. Getting the factory working came first.

## State

- P1, the read-only floor and Factory tab, landed as `eb37b531`.
- P2 landed as `50b53c39` and `ac72f084`. It added:
  - session plumbing;
  - the intent queue;
  - the orchestrator;
  - dispatch;
  - close-out;
  - watchers;
  - the verifier;
  - the budget.
- The Gate 2 fixes landed as `45c94124`.
- Gate 2 passed on 2026-10-11, on a throwaway repo, with no operator input. One intent dispatched two workers, and each was reviewed, merged and watch-verified. The verifier then closed the intent.
- `npm run lint` is clean on main as of `c2ba6adb`. Factory close-out runs lint as a default check, so lint must stay clean for self-hosting to work.

## How to run a gate

Never use the live instance on port 3000; do not restart it without asking the operator. Use an isolated sandbox instance built from your worktree:

1. Seed a throwaway repo:
   - `git init -b main`, with `commit.gpgsign false` and a local user;
   - files: `package.json` with `"scripts": {"test": "node --test"}`, `coherence.config.json` holding `{}`, `src/math.js` exporting `add`, and `test/math.test.js`;
   - commit, then push to a local bare `origin.git`.
2. Write `<home>/config.json` with these values:
   - `factory`: `enabled: true`, `maxRisk: "low"`, `maxLiveWorkers: 1`, `checks: ["npm test"]`, `watchWindowMinutes: 1`;
   - `usage.enabled: true`;
   - `projects`: `[{ "id", "name", "path" }]`.

   Leave `dailyBudgetUsd` unset, because of the scanner stall listed below.
3. Run `npm run build`, then start the instance: `GLIMMERVOID_HOME=<home> GLIMMERVOID_PORT=3911 GLIMMERVOID_TELEMETRY=0 node dist/server/index.js`.
4. Queue an intent over the control WebSocket:
   - fetch the token from `GET http://127.0.0.1:3911/control-token`;
   - connect to `ws://127.0.0.1:3911/control?token=<t>` with header `origin: http://127.0.0.1:3911`;
   - send `{"type": "factory-queue-intent", "requestId", "projectId", "objective", "criteria": [...], "risk": "low", "boundary", "writeScopes": ["src", "test"]}`;
   - the reply is `factory-queue-intent-result`.
5. Watch the `factory-state` broadcasts. A gate passes when the intent is `completed`, the heading is `steady`, and `origin/main` holds the worker commits plus `factory: verify and close <intentId>`.
6. Read any session's screen through `ws://127.0.0.1:3911/terminals/<sessionId>?token=<t>`. Input goes in as `{"type": "input", "data": "..."}`.

Note that the orchestrator still stops on Claude's folder-trust dialog and the external-imports dialog when it starts. The gate harness got past them by sending keys over the terminal socket. Removing that dependency is the first open item below.

## Remaining work, in order

1. **Orchestrator startup dialogs.** The orchestrator's cwd, the ledger checkout under `<home>/factory/<project>/`, is a new folder. Claude Code therefore shows the trust dialog and then the external CLAUDE.md imports dialog. Stall detection (`decideFactoryStalls`) raises an exception, but nothing clears the dialogs. A hands-off factory must start without them, for example by pre-trusting the ledger checkout. Find out which mechanism Claude Code actually honors before choosing one. Workers and reviewers did not hit these dialogs.
2. **Gate 2b.** Run the same gate on a throwaway clone of glimmervoid itself, with the default checks (`npm run typecheck`, `npm run lint`, `npm test`) and one low-risk intent. Worker worktrees get `node_modules` through `worktreeShare`.
3. **Self-host opt-in.** After Gate 2b passes, commit `coherence.config.json` (`{}`) to glimmervoid main. On the instance that runs the factory, set `factory.protectedPaths` to cover the factory's own guardrails: `server/factory-*`, `server/core/factory-core.ts`, `server/core/lane-posture-core.ts`, `server/lane-posture.ts`, `shared/contracts/factory.ts`, `shared/contracts/coherence.ts`, and the defaults. That way workers cannot loosen their own gates. Factory merges fast-forward source only. The live instance picks them up only when the operator rebuilds and restarts it.
4. **Team review onto the lane posture module**, in its own commit. Benchmarks and issues follow later.
5. **Security pass** (all deferred by the operator):
   - The hook port also serves the control plane, so code a worker runs can reach glimmervoid. The fix is a separate hook listener.
   - Workers can write branch refs other than their own.
   - `mergeBack` pushes without the integration check.
   - A repo-level `.claude/settings.json` can widen the sandbox.
   - A repo-local `core.askPass` can run when `GIT_ASKPASS` is unset.
   - A byte-limited usage pass after catch-up reports spend as `known`, so the budget fails open (`server/core/usage-scan-core.ts`).
   - The Windows isolation paths are untested.
6. **Bugs:**
   - The usage scanner stalls on a fresh home: `scheduleContinuation` drops the continuation chain while a pass is in flight.
   - Watch verification writes and breach notifications repeat every tick until a landing succeeds.
   - `discardWorkerLedgerChanges` diffs committed paths with a case-sensitive `.coherence` pathspec, which only matters on case-sensitive filesystems.
   - The failed-push recovery has no test for a trusted landing whose push fails.
7. **P3:**
   - auto-revert on a watch breach, serialized through `git-workspace.ts`;
   - a staged rollout behind a PostHog flag for critical risk;
   - permission prompts answered by policy;
   - a Codex second reviewer;
   - orchestrator rotation between intents;
   - `factory.intentSources`.

## Facts that cost time to learn

These were checked against Claude Code 2.1.296.

- **Permissions and sandbox:**
  - `dontAsk` denies anything that is not pre-approved and never prompts.
  - Under `bypassPermissions`, Write and Edit escape the sandbox, which governs Bash only.
  - `Edit(//<abs>/**)` bounds edits, and the same rule covers Write, MultiEdit and NotebookEdit.
  - Run `scripts/probe-lane-posture.ts` to re-check these assumptions live.
- **Linked worktrees:** these sessions are granted the whole shared git dir except `hooks` and `config`, so only `denyWrite` entries narrow it. Glob `denyWrite` entries are dropped on Linux, so use literal paths.
- **Network and hooks:**
  - HTTP hooks are blocked by the strict network allowlist unless `allowedDomains` includes `127.0.0.1:<port>`.
  - SessionStart HTTP hooks are skipped regardless.
  - Hook event names arrive in lowercase (`stop`, `sessionstart`).
- **CLI arguments:**
  - `--json-schema` must be draft-07. The CLI rejects the 2020-12 `$schema` that zod emits by default.
  - Variadic flags (`--add-dir`, `--tools`, `--allowedTools`) swallow a following positional prompt. Always end a lane's argv with a non-variadic option before the prompt (`tests/lane-permissions-core.test.ts`).
- **Coherence:**
  - The orchestrator's ledger landings move the integration tip every few seconds, so a staleness check must ignore `.coherence/` (`hasCodeChangedBetween` in `server/factory-ledger.ts`).
  - The `coherence` CLI resolves its project from the cwd only. `coherence-hook` honors `COHERENCE_PROJECT_ROOT`.
