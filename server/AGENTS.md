<!-- Generated: 2026-07-03 -->

# server

## Purpose
Backend runtime: the Express + WebSocket server factory and its control plane, plus shared server plumbing (config store, scheduler, spawn gate, WS sender, post-turn checks, safe child-process wrapper).

## Key Files

| File | Description |
|------|-------------|
| `backend/` | Express + WebSocket server factory and its wiring, one concern per file |
| `session/` | Session construction, config reconciliation, one-time event wiring, docs and trace |
| `control-handlers.ts` | Control-WebSocket message handlers (kill, restart, rename, settings) |
| `server-lifecycle.ts` | Boot/shutdown helpers; restart strategy in `core/restart-strategy.ts` |
| `ws-sender.ts` | Data-WebSocket sender: batching and backpressure |
| `data/claude-pricing.json` | Bundled LiteLLM pricing snapshot |
| `spawn-gate.ts` | Process-wide async serialization of `pty.spawn` initiation (ConPTY wedge avoidance) |
| `lanes/` | Ephemeral and interactive lane spawning, logging and status (`lanes/AGENTS.md`) |
| `usage/` | Usage lane: transcript scanner, pricing loader, lane ledger and wiring (`usage/AGENTS.md`) |
| `github/` | GitHub lanes: issues, my PRs, team PR review and its reaper and thread judge, `gh` queries, the shared clock and rate limit (`github/AGENTS.md`) |
| `radar/` | Radar lane: the PostHog API client, poller, wiring and report, with its cores (`radar/AGENTS.md`) |
| `git/git-workspace.ts` | THE ONLY module allowed to run `git worktree` |
| `coherence/` | Optional repository CLI boundary, pinned by the coherence-boundary gate |
| `config-store.ts` | Runtime config load/save/defaults |
| `child-process-safe.ts` | THE ONLY importer of `node:child_process` |
| `update-check.ts` | Startup release-tag check, advisory only |
| `benchmark-wiring.ts` | Benchmark lane: suites under `~/.glimmervoid/benchmarks`, mining, one serial run (pure rules in `core/benchmark-core.ts`, `core/benchmark-mining-core.ts`) |
| `claude-credentials.ts` | The operator's Claude Code access token for benchmark arms (decisions in `core/claude-credentials-core.ts`) |
| `claude-trust.ts` | Grants Claude Code folder trust plus external CLAUDE.md import approval (never over a recorded decline) for a session or lane folder under Claude Code's own config lock (decisions in `core/claude-trust-core.ts`) |
| `github/core/team-review-core.ts` | Pure team review decisions |
| `core/branch-sync-core.ts` | Pure ahead/behind decisions for the branch-sync indicator |
| `core/restart-strategy.ts` | Pure restart strategy, keyed on systemd's `INVOCATION_ID` |
| `core/upgrade-route.ts` | Pure WS-upgrade target classification by PATHNAME |

## For AI Agents
- Resolve a shipped asset only through `runtime-paths.ts`, never `import.meta.dirname` or a `..` offset: the same module runs from a source checkout and from `dist/`.
- See root `AGENTS.md` for architecture and conventions.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Worktree Auto-Rebase

- It rides the existing change funnel (no timer) and runs BEFORE the signature dedup, since a moved integration branch leaves the signature byte-identical. Every guard is pure in `session/core/rebase-gate.ts`, and the guard ORDER is the order of its checks.
- WAITING is the load-bearing exclusion: it is a permission prompt PAUSING a turn, and the agent resumes into the files an unattended rebase would have rewritten under it.
- `rebaseOnly` never stashes and merges nothing back: it runs unattended under a live agent, so a dirty tree is a hard refusal.
- A conflict is never escalated: the worktree is left byte-identical for the operator's own Merge. A cooldown key of both shas stops the retry loop; a sibling's resolution retriggers it.
- Which paths rerere replayed is deliberately unreported: git clears `MERGE_RR` as it resolves, so any list would be a guess, and a guess in a forensic trace is worse than a silence.
- rerere config is seeded only when UNSET, an operator who disabled it meaning it. A rebase suppresses the change funnel while it runs, or the review gate self-heals to none mid-rebase.

- Every worktree Glimmervoid adds inside its home is locked with its own reason, because guarded sessions are denied that folder yet can write the shared `.git`, so their `git worktree prune` would drop it; only Glimmervoid unlocks it, and branch GC treats that lock as unlocked.

### Worktree Base Branch

- A worktree's fork-base marker pins its base across restarts. With no configured branch, a marker whose branch the detected default already absorbed, or whose branch is gone, migrates to that default, so an abandoned staging branch stops showing landed commits as pending review; a marker holding commits the default lacks is kept.

### Remote Branch GC

- Deletion needs ancestry or tree-containment proof (`server/core/merge-proof-core.ts`) or staleness, any probe failure keeps it, and the push is a leased qualified refspec on that listed tip, so cleanup cannot lose a branch; `dryRun` traces would-delete.

### Benchmarks (opt-in)

- An arm's token rides only that cell's spawn env and never reaches a run record, status push or log; an arm that fails preflight fails the run, never scores zero recall.
- Arms never get the operator's refresh token: an arm's refresh could rotate it and log the operator out.
- The reviewed commit is the mode of the inline comments' commits and the base is the base tip at review time, so a stacked or force-pushed PR replays what reviewers saw.

### Plan Review

- The plan endpoint is a SECOND URL, never a second entry on the shared one: hooks run in parallel and a `PermissionRequest` payload carries no tool-use id, so two entries on one URL arrive as indistinguishable posts. The unmatched entry stays byte-identical.
- Every path fails OPEN and the held reply is written AT MOST ONCE, never after the socket closed: a fired hook timeout destroys the socket in silence, so a late write is a no-op.
- EVERY way a review can end writes that one reply and leaves `open` behind, since a hold nobody answers is an agent hung forever; `PostToolUse` counts, because the terminal can answer without cancelling the hook.
- An allow echoes the plan bytes AS RECEIVED, never a re-read of `planFilePath`, or whatever the file holds then becomes the approved plan; only an operator EDIT on the open revision replaces them.
- The in-memory index holds offsets, chars and titles and never a body, so a summary push carries no plan and a body crosses an authenticated socket only on request; a DRAFT body comes from the hook's own path, never a client's.
- Only a plan segment raises the body cap, the RESULT one twice, as it repeats the plan it approves.
- A child's AskUserQuestion, held for its parent, follows the same hold rules on its own URLs (`permissionrequest-conversation`, released by a matching `posttooluse-conversation`); no other tool is held, so ExitPlanMode stays with plan review (`session/core/claude-approval-core.ts`).

### Security: Trust Boundary

- Glimmervoid binds localhost only. Any local PROCESS is trusted; it is deliberately NOT "any local web page", and three layers keep a page on another local port out of the control WS.
- Host allow-list first (`server/core/host-policy.ts`). An ABSENT Host passes, since rebinding always carries a name and refusing it would only break HTTP/1.0 clients.
- Port-exact Origin, the port read from the socket so nothing a client sends decides it; a mismatch falls THROUGH to the allow-list. Browser channels demand an Origin, non-browser ingresses do not.
- A per-process page token guards local control and data upgrades, riding the query string since a browser cannot set a WS handshake header. `GET /control-token` refuses a disallowed Origin outright.
- Trust is the LISTENER PORT, never a header or IP: a reverse proxy makes remote traffic look loopback, so an IP or `X-Forwarded-For` rule would hand every visitor local trust.
- Sessions reach `/hook` and `/agent` on their OWN loopback listener, never the dashboard port: a lane guardrails allowlists one exact host and port (enforced on Linux, macOS unverified), and that port must not also serve `GET /control-token` or the control WS.
- A pairing cookie is RCE as the server account, the control WS accepting any project path plus `dangerouslySkipPermissions`. Pairing URLs are single-use, short-TTL, never logged or stored in plaintext; the store fails CLOSED on corruption.
- The `/pair/*` exemption is judged on the DECODED pathname: `express.static` resolves dot segments, so an un-normalized check served the dashboard bundle under `/pair/%2e%2e/`.
- Remote config is unreachable from the control WS, and remote-off is fully inert: no route, no middleware, no file. Binding wider needs `GLIMMERVOID_INSECURE_BIND=1`.
- A dashboard socket reads or saves only a path its session surfaced through `glimmervoid edit`, and every read and save re-runs containment against the checkout, so the browser never widens file access past what the agent token surfaced.
- Two HTTP write ingresses. `POST /hook/:glimmervoidId/:event` keeps its per-session bearer token, and its RESPONSE is also an ingress, so only Glimmervoid-authored text may be injected. Each untrusted corpus in a lane prompt gets its OWN `contentMarker` fence, so one cannot close another, and it is a sha256 digest rather than a cheap hash an attacker's text could fix-point. `POST /upload/:sessionId` sits behind remote-auth with a size cap; a non-image upload keeps only a sanitized extension from the client name, never the name itself.

### Transport and Session Identity

- The dual WebSocket split is deliberate: do NOT merge the channels. They want opposite loss policies (data drops and backfills by offset, control JSON must not drop), `bufferedAmount` is per-socket so one buffer cannot tell which stalled, and one stream would let a PTY flood block a kill frame.
- Control backpressure drops only what the next push repairs, and a type not listed as refreshable is never droppable, so a new frame cannot silently go stale under load.
- Both servers are heartbeat-reaped: focus suppression and the Telegram zero-connections gate COUNT open connections, so a half-open socket silently blocks the channel of last resort.
- Resize is arbitrated by ACTIVE VIEWER: a claim wins and a departure hands the PTY to the most recent survivor, since last-write-wins left a desktop stuck at a phone's column count forever.
- ANSI is parsed in the browser for display and in the server keeper for attach, because raw bytes are only correct at the width that produced them.
