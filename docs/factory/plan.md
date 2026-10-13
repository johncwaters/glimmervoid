# Factory plan and handoff

This file records the state of the Factory lane as of 2026-10-12, so that another agent can continue the work. Where it disagrees with the code or `AGENTS.md`, the code and `AGENTS.md` are right.

## Goal and operator decisions

- Glimmervoid runs a software factory over the `@danilocampos/coherence` ledger, pinned exactly at `0.37.1` and run out of process. The operator queues intents and is paged only on exceptions. The end goal is for glimmervoid to run the factory on itself.
- The factory has a master orchestrator Claude session for each repo. It decomposes an intent into coherence tickets and calls `glimmervoid dispatch <workId>`. Glimmervoid then takes these deterministic steps:
  - admission;
  - the fence check;
  - its own checks;
  - a reviewer that never wrote the code;
  - merge, which files the ticket's verification;
  - a separate verifier session that closes the intent.
- The aim is near-zero intervention. There are no approval clicks; risk is managed by tiered guardrails instead.
- Everything sits behind the Factory setting, which is off by default. The Focus tab is untouched.
- Every agent lane gets one shared lockdown: a sandbox role (`server/core/sandbox-roles-core.ts`) launched through the one policy builder (`server/core/sandbox-policy-core.ts`, with `server/sandbox-launch.ts` as its IO shell), which wraps the whole agent process in the sandbox runtime. `server/work-lane.ts` pairs the work role with dontAsk permissions and a required Sane YOLO hook. Do not add per-lane sandbox patches; extend a role instead. The roles name no factory concepts, so that team review, benchmarks and issues can adopt them.
- Security hardening is a separate, later pass. Getting the factory working came first.
- Self-hosting is gated while the factory is being proven. The factory runs on a clone of glimmervoid whose only `origin` is a local bare staging remote, so every factory merge and ledger landing stops there. The operator promotes accepted work to the real `main` by hand, and the real `main` holds no `coherence.config.json` until the operator lifts the gate.
- An intent is the factory's guiding star, and it is settled before the factory starts. The operator sharpens a feature into a design spec outside glimmervoid, and the finalized spec is queued as one intent: objective, criteria, risk, boundary and write scopes. A spec goes wholly to the factory or wholly to one dedicated agent session, never split between them.

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
- Gate 2b passed on 2026-10-11: one low-risk intent ran on a gated clone of glimmervoid with the default checks (`npm run typecheck`, `npm run lint`, `npm test`), the staging remote received the worker commit, and the real `main` did not move. Three more gated runs passed on 2026-10-12, each taking about 15 minutes, six sessions and about $1.40 of Claude usage.
- No run needs a key sent to a session. Glimmervoid marks the project folder as trusted for Claude Code before the orchestrator starts.
- The run harness in `test/factory/` replaced the gate steps that used to be done by hand.
- The operator's own gated clone exists as of 2026-10-11, with `coherence.config.json` on its staging remote only. No intent has run against it yet: harness runs build a gated clone of their own.

## How to run a gate

Never use the live instance on port 3000; do not restart it without asking the operator. The harness runs an isolated instance built from your worktree, with its own home and port:

- `npm run factory:run -- --help` lists the options, and `--list-intents` prints the intent catalog.
- `node test/factory/run.ts --runs 1 --intent one-file-change` runs one intent on a throwaway repo, in about two minutes.
- `node test/factory/run.ts --runs 1 --target gated-clone --intent gated-one-file-change` runs one intent on a fresh gated clone of glimmervoid with the default checks.
- `--intent-file <path>` queues any `factory-queue-intent` request written as JSON, which is how a rendered design spec reaches a run.

Every run bills Claude usage. A run builds `dist/` from the worktree when it starts, so leave the worktree alone until it ends.

A run passes when the intent is `completed`, the heading is `steady`, `origin/main` of the run's own remote holds the worker commits plus `factory: verify and close <intentId>`, and, for a gated clone, the real `main` did not move. The run prints its record folder, which holds the verdict, every `factory-state` broadcast, the server log, the decision log and the git logs.

## The gated self-host clone

The gate is setup, not code. Build it once:

1. Make the staging remote: `git clone --no-hardlinks --bare --single-branch --branch main <glimmervoid checkout> <staging>.git`, then `git -C <staging>.git remote remove origin`, so that it has no path to GitHub.
2. Make the clone: `git clone --no-hardlinks <staging>.git <clone>`, then run `npm ci` in the clone so that it has its own install. Nothing in the clone may link into the real checkout, and that goes for every `worktreeShare` entry, not only `node_modules`. The `--no-hardlinks` flag is there because a local clone otherwise shares object files by hard link.
3. Commit `coherence.config.json` holding `{}` in the clone and push it to the staging remote.
4. Register the clone as the factory project: in a sandbox instance's `projects` for a gate, or in the operator's own instance. The second is the operator's choice alone, made knowing what the gate does not hold.

What the gate holds:

- Everything the factory pushes from the clone, merges and ledger landings alike, reaches the staging remote only.
- That holds only while the clone shares no files with the real checkout. A link from the clone into the real checkout gives worker-written code a way to write there.

What the gate does not hold. It guards the factory's normal flow, its merges and pushes, and it is not containment of a misbehaving worker. Two holes that used to sit here are closed: sessions now reach a hook listener of their own instead of the dashboard port, and close-out checks run inside a sandbox. What remains is the security pass below, so agents still run gated intents in a sandbox instance, which keeps gated runs away from the operator's live sessions and state.

Sandboxed checks need `bwrap`, `socat` and `rg` on PATH on Linux, and a close-out fails when the sandbox cannot start. A check cannot open a unix socket, write outside its checkout and temp folder, or write into the shared `node_modules`, so a suite must pass under those limits before its project can merge through the factory.

Promotion is the operator's step. In the real checkout, fetch `main` from the staging remote, read the worker commits, and land the accepted ones through the normal commit path. Leave `.coherence/` and `coherence.config.json` behind until the gate is lifted.

Refreshing the clone from the real `main` is unproven. The expected route is to pause the project, merge the real `main` in the clone, push to the staging remote and resume, because a ledger landing refuses while the local integration branch holds commits that its origin lacks.

## Remaining work, in order

1. **Gated self-host.** The operator runs real intents against the gated clone and promotes what they accept. On the instance that runs the factory, set `factory.protectedPaths` to cover the factory's own guardrails: `server/factory-closeout.ts`, `server/factory-dispatch.ts`, `server/factory-ledger.ts`, `server/factory-orchestrator.ts`, `server/factory-poller.ts`, `server/factory-verifier.ts`, `server/factory-wiring.ts`, `server/git-workspace.ts`, `server/core/factory-core.ts`, `server/core/git-invocation-core.ts`, `server/core/lane-permissions-core.ts`, `server/core/sandbox-roles-core.ts`, `server/core/sandbox-policy-core.ts`, `server/sandbox-launch.ts`, `server/work-lane.ts`, `shared/contracts/browser-config.ts`, `shared/contracts/factory.ts`, `shared/contracts/coherence.ts`, and the defaults. Each entry is an exact path, a directory ending in `/`, or `**/` plus a file name, and `*` in any of those stands for any run of characters inside one path segment; these are the only shapes that `checkFence` in `server/core/factory-core.ts` matches, and any other glob syntax blocks every change. That way workers cannot loosen their own gates. Factory merges fast-forward source only. The live instance picks them up only when the operator rebuilds and restarts it.
2. **Spec-fed intents.** The operator's spec tool renders a finalized design spec as one `factory-queue-intent` request, so nothing in glimmervoid has to change for the first run, and the harness queues that request with `--intent-file`. The request carries the spec's units of work as `tickets`, which the factory writes to the ledger when the intent becomes active so no model re-cuts them; a spec-fed run of two dependent tickets passed on the gated clone on 2026-10-12.
3. **Lifting the gate.** This is the operator's call, made after gated intents have been promoted cleanly. Only then commit `coherence.config.json` (`{}`) to glimmervoid main and point the factory at the real checkout.
4. **Team review onto a sandbox role**, in its own commit. Benchmarks and issues follow later.
5. **Security pass** (all deferred by the operator):
   - `mergeBack` pushes without the integration check.
   - A repo-level `.claude/settings.json` can widen the sandbox.
   - A repo-local `core.askPass` can run when `GIT_ASKPASS` is unset.
   - A byte-limited usage pass after catch-up reports spend as `known`, so the budget fails open (`server/core/usage-scan-core.ts`).
   - A config file kept outside the Glimmervoid folder, and the files beside it, stay readable from a lane shell.
   - The sandbox changes were checked on Linux only; macOS is unverified.
   - The Windows isolation paths are untested.
6. **Bugs:**
   - Watch verification writes and breach notifications repeat every tick until a landing succeeds.
   - The failed-push recovery has no test for a trusted landing whose push fails.
   - A throwaway harness run records no spend: the first usage scan on a fresh home reads every Claude transcript on the machine (about 13 minutes here), so a short run ends first. A daily budget refuses dispatch for the same stretch.
   - Each harness run leaves one trusted project entry in the real Claude Code config, and nothing removes it.
   - A check folder left under `scratch` in the Glimmervoid folder by a crash is never pruned.
7. **P3:**
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
  - Run `scripts/probe-sandbox-roles.ts` to re-check the sandbox roles live.
- **Linked worktrees:** a lane cannot write the shared git dir at all and Glimmervoid commits for workers, because on Linux write denies naming single files inside that folder, or paths in it that do not exist yet, were not a reliable fence and could break git for every other process, while a folder entry holds. Two per-checkout entries remain, the checkout's `.git` pointer file and its `.claude` folder, and both hold even when `.claude` is missing: `scripts/probe-sandbox-roles.ts` attempts a write to each in the worker role, alongside its writes into the shared git dir. Glob `denyWrite` entries are dropped on Linux, so use literal paths.
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
