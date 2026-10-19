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

Keep, because other lanes use them: guardrails roles and the policy builder, `server/lanes/`, the work lane, usage tracking. Anything whose only caller was the factory goes too, found by a zero-hit grep before deleting.

Full deletion, no compatibility layer: no config migration, no shims, no deprecated aliases, no tombstone docs. `docs/factory/` goes too; git history holds it for the redo.

The saved config schema is passthrough, so stale `factory`, `knowledgeGraph` and `factoryProfile` keys in an existing config file load and are inert; no code strips them.

## Phase 2: the Coherence layer

### Resolution, no package dependency

Glimmervoid drops `@danilocampos/coherence` from `package.json` and adds no replacement. It runs the CLI the repository installed, `<worktree>/node_modules/.bin/coherence`, so the repository pins its own version and a Coherence upgrade never needs a glimmervoid release.

On first use per worktree glimmervoid runs `coherence version` and checks it against one supported range in `server/coherence/core/coherence-support-core.ts` (initially `>=1.8.0 <2`). Outside the range Coherence is unsupported for that repository and treated as off, with the reason shown. A session never fails to start because of Coherence.

### What glimmervoid uses

| Feature | Source in `@posthog/coherence` | Glimmervoid use |
|---|---|---|
| Hook status | `coherence hooks status`, `hooks --check --host claude\|codex` | Session setup and project view show installed, drifted, or missing |
| Decision journal | `coherence journal --json` | Session feed, team review context, knowledge graph source |
| Mass | `coherence mass --json` | Trend panel keeps mass only |

Each call is parsed by a Zod schema in `shared/contracts/coherence.ts`, rewritten for the 1.8 shapes. An unknown journal kind parses as an opaque entry (kind plus id), so a new upstream kind degrades one row, not the feed.

### Every agent, one path

Today Coherence reaches sessions and lanes through different code (`session/` for operator sessions, `buildCoherenceJournalLaneOverrides` and shims in `server/lanes/lane-spawn.ts` for lanes). Phase 2 collapses that into one decision applied at the one spawn path every agent goes through: given the worktree, the agent kind and `coherence.enabled`, it returns either nothing or the read-only facts the UI needs (version, hook status). The repository's own inline hook commands do the rest; glimmervoid injects no env, shims or hook paths.

A lane that cannot use Coherence runs without it. No lane requires it.

### Removed

These have no upstream equivalent; the operator approved deleting them on 2026-10-18:

- the `regulate` next-action chip in the session feed, and `coherence-sandboxed-run.ts`;
- the signal, drift, decompose and redundancy readings in the trend panel and team review;
- PATH shims, `hookCliPath`, `COHERENCE_HOOK_HOST` and `COHERENCE_PROJECT_ROOT` injection, launcher control-file checks;
- direct reads of `.coherence/decisions` and `.coherence/defects`;
- the 0.37.1 fixtures.

## Phase 3: tidy

Regenerate `docs/configuration.md` and rewrite the `coherence.enabled` description; update `docs/AGENTS.md`, the root and `server/AGENTS.md` maps; CHANGELOG entries for the factory removal and the Coherence change.

Each phase lands on its own with `npm test` green.

## Acceptance, each pinned by a test

- **Boundary guard** (new `tests/coherence-boundary.test.ts`): nothing outside `server/coherence/` spawns a coherence CLI or reads `.coherence/`, and `package.json` names no coherence package.
- **Every agent**: one spawn test per agent kind (operator Claude, operator Codex, a lane) gets Coherence status with a fake supported install and none without it, through the same path.
- **Absent or unsupported**: a session spawns with no install, and with a fake `coherence version` printing `0.37.1`; both report the reason and neither blocks the spawn.
- **Upstream shape**: `journal --json` and `mass --json` output recorded from `@posthog/coherence` 1.8.0 parse through the contracts (`tests/contracts-coherence.test.ts`, fixtures under `tests/fixtures/coherence/1.8.0/`).
