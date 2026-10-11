<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# test

## Purpose
Manual smoke tests and harnesses run directly with `node`, separate from the automated `tests/` suite (which `npm test` runs).

## Key Files

| File | Description |
|------|-------------|
| `factory/run.ts` | Hand-run CLI; keeps billed work outside npm test |
| `factory/arguments.ts` | Pure CLI validation and usage |
| `factory/intents.ts` | Fixed queue catalog and expected ends |
| `factory/verdict.ts` | Pure classification; pinned by tests/factory-run-verdict.test.ts |
| `factory/summary.ts` | Comparable batch rows |
| `factory/telemetry-core.ts` | Strict anonymous event allowlist, identity parsing and the one telemetry decision; pinned by tests/factory-run-verdict.test.ts |
| `factory/telemetry.ts` | Stable harness identity, operator opt-out read, remote switch carry-over, product-schema seeding and bounded summary send |
| `factory/batch.ts` | Sequential runs and interruption ownership |
| `factory/seed.ts` | Single seed-target seam and batch snapshot ownership |
| `factory/targets.ts` | Target work limits and default intents |
| `factory/gate.ts`, `factory/cleanup.ts` | Clone gate evidence and bounded removal |
| `factory/instance.ts` | Built child isolation and bounded process-group shutdown |
| `factory/supervisor.ts` | Watches the harness pid and ends the server process group once the harness is gone |
| `factory/control.ts` | Control records and read-only terminal capture |
| `factory/records.ts` | Durable decision, recording and git evidence |
| `factory/preflight.ts` | Sandbox prerequisites, the per-checkout batch lock and one build per batch |
| `factory/check-sandbox.ts` | Runs a command in the factory close-out sandbox against HEAD or a working-tree overlay |
| `smoke-dormant-boot.ts` | Boots the backend in-process, verifies dormant-by-default boot and the start-session control flow |
| `probe-codex-session.ts` | Live verification of the Codex adapter against a real `codex` binary: boots the backend on a throwaway config and drives one supervised session through spawn, working, awaiting-input, approval, complete and resume. Costs one real codex turn; leaves a recording the replay fixtures are cut from |
| `browser/harness.ts` | Headless-Chromium dashboard matrix: boots Vite plus the backend on a throwaway config, substitutes a fake agent via a PATH shim, drives every viewport through scripted steps, and writes screenshots, diffs and a report an agent can read. Linux and macOS only, since the shim is a POSIX `sh` script: it exits 2 on Windows |
| `browser/fake-agent.ts` | Deterministic TUI stand-in for `claude`: paints a ruler frame that is a pure function of `(cols, rows, tick)`, so a browser assertion is a two-way fixpoint against the negotiated grid rather than a screenshot diff |
| `support/backend-harness.ts` | Shared isolated config, free high port, control socket and bounded server helpers for manual probes |
| `container/Dockerfile` | node:24-bookworm image for the Linux-only remote-mode suite (`npm run test:container`) |
| `container/remote-mode.sh` | Remote-mode integration assertions: two listeners, pairing lifecycle, revocation, Origin policy |
| `container/ws-check.js` | WebSocket probe used by that script (cookie/Origin headers, waits for a control snapshot) |

## For AI Agents

### Working In This Directory
- New AUTOMATED tests go in `../tests/` (node:test). This directory is for run-by-hand smoke scripts only.
- A hand-run harness may keep its pure decision logic in a sibling module; that module's unit test still belongs in `../tests/` and requires across, so the logic is pinned by `npm test` while the billed harness around it stays hand-run.
- Smoke scripts must shut down cleanly (in-process server, no orphan listeners).
- A harness that imports a backend imports `support/disable-telemetry.ts` first to avoid counting throwaway homes as new installs (`tests/hand-run-harness-telemetry.test.ts`). Factory children send product events and one anonymous run summary under the persistent harness install id. `decideHarnessTelemetry` is the only place that turns them off: `--no-telemetry`, `DO_NOT_TRACK=1`, `GLIMMERVOID_TELEMETRY=0`, `CI=true`, the Settings > Privacy opt-out in the operator's real config or an unloadable install identity turn off both, and the product's remote switch skips only the summary (`skipped-remote-disabled`). `tests/factory-run-verdict.test.ts` pins that decision's summary result and the child environment it returns, not a spawned child. `$ai_generation` totals under the harness install id include unrelated sessions on the machine, so per-run cost is read from the summary event's `spend_usd`.

### Testing Requirements
- Run factory gates with `npm run factory:run -- --intent one-file-change --watch-window 1`; this bills real Claude usage and never runs in `npm test`.
- Run directly: `node test/smoke-dormant-boot.ts`.
- Run the browser matrix: `npm run test:browser` (`--only <scenario>`, `--viewport <name>`, `--artifacts <dir>`, `--prove-failure`, `--headed`, `--executable <path>`).
- `--prove-failure` adds the self-check case whose failure IS the proof, so it never sets the exit code: 0 when every other case passed and the proof bit, 1 when another case failed, 2 when the proof did not bite.

## Dependencies

### Internal
- `server/backend.ts`, `session/sessions.ts`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
