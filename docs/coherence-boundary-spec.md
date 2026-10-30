# Coherence layer spec

Status: draft for operator approval, 2026-10-18. Where it disagrees with the code or `AGENTS.md` after it lands, the code and `AGENTS.md` win.

## Why

`@danilocampos/coherence` 0.37.1 moved to `@posthog/coherence` (1.8.0, a separate project, not a fork). The new package retires `orient`, `regulate`, `signal`, `drift`, `decompose`, `redundancy`, consequences, the `coherence-hook` bin, and the work authority model. The factory was built on exactly those parts, so it cannot follow.

The factory's goal (run intents to merged, verified work) is separate from Coherence's goal (a decision journal and structure for any agent session). The operator decided on 2026-10-18 to remove the factory now, make Coherence an optional layer for every agent glimmervoid runs, and redo the factory later on its own ledger.

## Goals

1. Coherence is an optional layer for every Claude Code and Codex session glimmervoid starts: operator sessions, PR and team review lanes, Radar, benchmarks, issues, and any future lane. It applies when `coherence.enabled` is on and the repository installed Coherence itself. Off, absent, or unsupported means the session runs exactly as without it.
2. All Coherence knowledge lives behind one boundary, `server/coherence/`, so the next upstream change touches one directory.
3. The factory is gone, with nothing left that a redo would have to work around.

## Non-goals

- Migrating 0.37 records or old config. Existing `.coherence/` folders stay in each repository untouched, and glimmervoid never reads them again.
- Rebuilding retired Coherence features inside glimmervoid.
- Glimmervoid installing hooks. Native install stays the repository's job (`npx coherence hooks install`).
- Designing the new factory. That is a later spec; its one fixed constraint is that it owns its own work ledger and never calls Coherence.

## Phase 1: remove the factory

Delete:

- `server/factory/**`, `public/factory/**`, the Factory tab and its routes and control messages;
- factory contracts in `shared/contracts/`, the `factory.*` config keys and `checkMemoryReserveMB`, and `projects[].factoryProfile`;
- the factory agent API verbs (`glimmervoid dispatch`, intent queueing, FACTORY_ADOPTION_STEP) and their CLI help;
- the factory harness, the harness mirror, the self-host clone tooling, and factory telemetry outcome events;
- factory tests and fixtures;
- the experimental knowledge graph (`knowledge-graph/`, `server/knowledge-graph-cli.ts`, `glimmervoid kg`, `knowledgeGraph.*` config, `docs/knowledge-graph.md`), since its ticket side was Coherence work orders. It returns with the factory redo, built on the new ledger.

Keep, because other lanes use them: `server/lanes/`, the work lane, usage tracking. Anything whose only caller was the factory goes too, found by a zero-hit grep before deleting.

Full deletion, no compatibility layer: no config migration, no shims, no deprecated aliases, no tombstone docs. `docs/factory/` goes too; git history holds it for the redo.

The saved config schema is passthrough, so stale `factory`, `knowledgeGraph` and `factoryProfile` keys in an existing config file load and are inert; no code strips them.

## Phase 2: the Coherence layer

### Resolution, no package dependency

Glimmervoid drops `@danilocampos/coherence` from `package.json` and takes no runtime dependency on Coherence. Its own repository installs `@posthog/coherence` as a devDependency, the same way any repository would. It runs the CLI the repository installed, `<worktree>/node_modules/.bin/coherence` (a shared `node_modules` symlink is followed; no fallback to another checkout), so the repository pins its own version and a Coherence upgrade never needs a glimmervoid release.

At session start glimmervoid runs `coherence version` once and checks it against one supported range in `server/coherence/core/coherence-support-core.ts` (initially `>=1.8.0 <2`). No CLI means not installed; outside the range means unsupported. Both are treated as off, with the reason shown. A session never fails to start because of Coherence. Every call runs with the allowlisted child env and a timeout.

### What glimmervoid uses

| Feature | Source in `@posthog/coherence` | Glimmervoid use |
|---|---|---|
| Hook status | `coherence hooks --check --host claude\|codex`, plus the Codex trust check on `.codex/hooks.json` | The session row's Hooks off signal and its reason |
| Decision journal | `coherence journal --json --session <id>` | Session feed and the journal drawer |

Each call is parsed by a Zod schema in `shared/contracts/coherence.ts`, rewritten for the 1.8 shapes. An unknown journal kind parses as an opaque entry (kind plus id), so a new upstream kind degrades one row, not the feed.

### One decision, one place

`resolveCoherence({ worktree, host, isSettingOn })` in `server/coherence/` returns either nothing or the facts the UI needs (version, hook status, a journal reader). Operator sessions get it through the session factory. Lanes run without Coherence: team review runs in a throwaway work directory where the repository's hooks never fire, and Radar, benchmarks and issues never had it. The repository's own inline hook commands do the rest; glimmervoid injects no env, shims or hook paths.

`.coherence/` path knowledge used by the worktree merge-back (journal records land with the work and never count as work) moves behind `server/coherence/`.

### Removed

Operator approved on 2026-10-18:

- the `regulate` next-action chip, `coherence-sandboxed-run.ts`;
- the repository readings (drift, decompose, redundancy and mass), their poller, series and trend messages, since nothing shows them after the Factory screen went;
- `glimmervoid coherence check`, the `coherence-check` agent verb and its control message, since nothing calls them;
- adopt and project status (`project-coherence-adopt`, `project-coherence-status`): installing hooks is the repository's job;
- Coherence in team review: the injected hooks, shims, journal landing and the advisory signal/redundancy section;
- PATH shims, `hookCliPath`, `COHERENCE_HOOK_HOST` and `COHERENCE_PROJECT_ROOT` injection, launcher control-file and `coherence.config.json` checks;
- direct reads of `.coherence/decisions` and `.coherence/defects`, the lane journal store;
- the 0.37.1 fixtures.

## Phase 3: tidy

Regenerate `docs/configuration.md` and rewrite the `coherence.enabled` description; update `docs/AGENTS.md`, the root and `server/AGENTS.md` maps; CHANGELOG entries for the factory removal and the Coherence change.

Each phase lands on its own with `npm test` green.

## Acceptance, each pinned by a test

- **Boundary guard** (new `tests/gates/coherence-boundary.test.ts`): nothing outside `server/coherence/` spawns a coherence CLI or names `.coherence`, and `package.json` names no coherence package as a runtime dependency (the repository's own `@posthog/coherence` devDependency is its own install, not a glimmervoid dependency).
- **Operator sessions**: a Claude and a Codex session spawned through the session factory get Coherence status from a fake supported install in the worktree, and none without it.
- **Absent or unsupported**: a session spawns with no install, and with a fake `coherence version` printing `0.37.1`; both report the reason and neither blocks the spawn.
- **Upstream shape**: `journal --json` and `hooks` output recorded from `@posthog/coherence` 1.8.0 parse through the contracts and the Codex trust check (`tests/contracts-coherence.test.ts`, fixtures under `tests/fixtures/coherence/1.8.0/`).
