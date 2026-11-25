<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# harness

## Purpose
Manual smoke tests and harnesses run directly with `node`, separate from the automated `tests/` suite (which `npm test` runs).

## Key Files

| File | Description |
|------|-------------|
| `smoke-dormant-boot.ts` | Boots the backend in-process, verifies dormant-by-default boot and the start-session control flow |
| `probe-codex-session.ts` | Live verification of the Codex adapter against a real `codex` binary: boots the backend on a throwaway config and drives one supervised session through spawn, working, awaiting-input, approval, complete and resume. Costs one real codex turn; leaves a recording the replay fixtures are cut from |
| `probe-agent-session.ts` | Live capture for the hooked agents without a login: runs the real CLI (`gemini`) against a stub model on loopback, through approval, completion and resume; `--write-fixtures` writes `tests/fixtures/v2-<agent>-*.jsonl` |
| `probe-claude-session.ts` | Live capture of the Claude Code parity scenarios against a real `claude` binary, launched with `--setting-sources project,local --permission-mode default` so the operator's own settings (auto mode, denied tools, hooks) cannot change what is recorded. Costs real claude turns; `--write-fixtures` writes `tests/fixtures/v2-claude-code-*.jsonl`. |
| `browser/harness.ts` | Headless dashboard matrix in one engine per run (`--browser` chromium, webkit or firefox): boots Vite plus the backend on a throwaway config, substitutes a fake agent via a PATH shim, drives every viewport through scripted steps, and writes screenshots, diffs and a report an agent can read. Linux and macOS only, since the shim is a POSIX `sh` script: it exits 2 on Windows |
| `browser/fake-agent.ts` | Deterministic TUI stand-in for `claude`: paints a ruler frame that is a pure function of `(cols, rows, tick)`, so a browser assertion is a two-way fixpoint against the negotiated grid rather than a screenshot diff |
| `load-cost/harness.ts` | Dashboard load cost on 3G, inspired by t3code: its scenarios mirror the rows of t3code's published 3G load graphic so the numbers compare. Boots the backend over the built `dist/client`, routes Chromium through a SOCKS5 shaping proxy (`shaping-core.ts`), and reports time, wire, gzip and parsed bytes per channel. Uses its own `scrollback-agent.ts`, because the fake agent's repaint clears scrollback. `--compare <old.json>` diffs two runs; `--profile t3-22776` instead reruns t3code PR #22776's own method (CDP throttle, desktop, app ready at loading-screen fade) for its cold and warm rows; `npm run build` first |
| `load-cost/whiteboard-bench.ts` | `--whiteboard` mode of the load-cost harness: seeds synthetic boards (`whiteboard-board-generator.ts`) into a throwaway backend and measures layout, put latency, get size, MCP reply size, and in Chromium open time plus frame times for pan, zoom and drag. `--sizes`, `--out`, `--compare`; `--server-only`, `--browser`, `--mcp` pick sections; `--media` puts pictures and pages on every tenth box. Every whiteboard tunable is set from its numbers |
| `hint-latency.ts` | Times Claude and Codex PostToolUse hook round trips with and without the command hint lookup; exits 1 when the lookup adds more than 5 ms p50 on any path |
| `board-layout-cost.ts` | Times `layoutBoard` on seeded boards of the given `--sizes` (70% boxes, 30% wires, some spanning the board), best of 3; `--compare-ref <ref>` lays out the same boards with that commit's `shared/`, `--codemap <repo>` lays out that checkout's code map board in place of the seeded ones, `--same-layout` exits 1 when the placed layout differs from the `--compare-ref` one, `--same-warnings` exits 1 when the warning list `layoutBoard` returns differs, which is capped to the first 19 and a total, so a change past the 19th shows only as a count, `--budget-ms` exits 1 over budget, `--expect-routed` exits 1 when a wire runs through a box that is not one of its ends or finds no clear route |
| `board-habits/run.ts` | Billed A/B of agent board habits: runs real `claude -p` turns per task and trial in a temp project outside any repo against each `--arm name=path` checkout (default this repo), applies an operator edit between turns on `operator-edit`, and writes each trial's tool calls, boards and pictures to `--out` (gitignored `board-habits/out/`); `--report <dir>` prints the habit table from `board-habits/habits-core.ts` |
| `browser/chat-view.ts` | Renders a slice of a session trace file (`--from`, `--count`) through the Chat view components in a bare Vite page; `--screenshot <png>` captures it headless, `--fingerprint` / `--fingerprint-compare` checks structural DOM identity, and `--perf <runs>` times at-rest upsert and log rebuild medians |
| `wargames-balance-sim.ts` | Plays the real Wargames engine with rusher, builder, turtle, mixed and village-only bots over 24 seeds, 4 and 6 seats and every map size, and prints the balance table for the current rules; `--targets` sweeps the 4-seat VP target, `--grid` sweeps land VP, improvement yield and target, `--all-village` seats only village-only bots, `--only=`, `--seats=`, `--seeds=`, `--size=` narrow a run; `--coalition [--assert]` prints capture rates against a village its owner spent B on, for one seat spending B, one seat spending 2B, and two seats spending B each on consecutive turns, and `--assert` fails unless B alone stays under 20%, 2B over 50% and the two-turn pair over 60% |
| `wargames-diplomacy.ts` | Plays one live LLM Wargames match with the seats in `--seats` (default `~/.glimmervoid/wargames-lab/seats.json`, label, agent, model and modelDisplay each) on a throwaway backend from this checkout, keeps its log in `~/.glimmervoid/wargames-lab/`, and prints the diplomacy table from `diplomacyMetrics`; `--report-only [logs...]` prints it for stored logs. Billed and slow (hours); one match at a time |
| `code-shape.ts` | Parses TypeScript files in a directory with the shipped tree-sitter grammar and reports line counts, function counts, longest functions (including nested closures) and module-level mutables, with `--json` and `--compare` |
| `support/backend-harness.ts` | Shared isolated config, free high port, control socket and bounded server helpers for manual probes |
| `container/Dockerfile` | node:24-bookworm image for the Linux-only remote-mode suite (`npm run test:container`) |
| `container/remote-mode.sh` | Remote-mode integration assertions: two listeners, pairing lifecycle, revocation, Origin policy |
| `container/ws-check.js` | WebSocket probe used by that script (cookie/Origin headers, waits for a control snapshot) |

## For AI Agents

### Working In This Directory
- New AUTOMATED tests go in `../tests/` (node:test). This directory is for run-by-hand smoke scripts only.
- A hand-run harness may keep its pure decision logic in a sibling module; that module's unit test still belongs in `../tests/` and requires across, so the logic is pinned by `npm test` while the billed harness around it stays hand-run.
- Smoke scripts must shut down cleanly (in-process server, no orphan listeners).
- A harness that imports a backend imports `support/disable-telemetry.ts` first to avoid counting throwaway homes as new installs.

### Testing Requirements
- Run directly: `node harness/smoke-dormant-boot.ts`.
- Run the browser matrix: `npm run test:browser` (`--only <scenario>`, `--viewport <name>`, `--artifacts <dir>`, `--prove-failure`, `--headed`, `--executable <path>`, `--browser <engine>`). `npm run test:browser:engines` runs it once per engine with the same arguments, refusing `--browser` and `--executable`; `scripts/install-browsers.sh` installs the three engines.
- `--lan <this machine's IPv4> --lan-allow <device IP>` serves the same throwaway backend and fake agent to real phones instead of running the matrix, and prints the device step list (`LAN_DEVICE_STEPS`). The dashboard port has no authentication, so it refuses without `GLIMMERVOID_INSECURE_BIND=1` and destroys every connection from a peer not listed.
- `--only touch-typing-search [--seed <n>] [--budget-seconds <n>]` runs only when named: seeded random phone keyboard actions checked after every step by the oracles in `browser/typing-search-core.ts`; a failure prints its seed and a shrunk action list. `--replay-device-log <path>` replays a `--lan` pass's `device-log.jsonl` keyboard events through the same oracles; logs stay in the gitignored `browser/artifacts/`.
- `--prove-failure` adds the self-check case whose failure IS the proof, so it never sets the exit code: 0 when every other case passed and the proof bit, 1 when another case failed, 2 when the proof did not bite.

## Dependencies

### Internal
- `server/backend/backend.ts`, `session/sessions.ts`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
