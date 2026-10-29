# server/radar

Radar: the opt-in lane that investigates PostHog issues and, when asked, fixes one onto a local branch the operator approves or dismisses.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Radar / PostHog Auto-Fix (opt-in)

- Issue data is untrusted: Glimmervoid fetches the issue and its recent exception events into `untrusted.json`, and neither session gets a shell, a network tool or the PostHog key; an investigation reads the repo read-only and may use the gated read-only PostHog MCP.
- The fix lane only edits files; GLIMMERVOID commits with the repository's hooks and fsmonitor off and refuses a fix that rewrote the worktree `.git` entry or its admin `commondir`/`gitdir`, since an agent-planted hook or git pointer would run outside the lane (`commitFixWork`, `readWorktreeGitPointer`).
- The server REFUSES the handoff when the diff touches `.github/workflows/`, making "never touches CI" structural.
- The lane never pushes: a fix stays a local branch until the operator approves it, which opens an ordinary session that reviews, tests, pushes and opens the PR with Glimmervoid-written text; the agent's PR title and body never reach GitHub, since they came from a model that read untrusted data.
- An unapproved fix branch is deleted on dismiss, archive, log eviction or after `PENDING_FIX_TTL_MS`, so no branch outlives its record.
- The branch name carries a random discriminator: a deterministic one collides with a previous fix's branch, burning the timeout on a regression after a fix.
- The live investigation view is the hook-derived trail plus the agent's narration read from its contained transcript at each tool call, never the PTY: `claude -p` writes nothing to its terminal until the final answer, so a terminal viewer would show a blank screen for the whole run.
