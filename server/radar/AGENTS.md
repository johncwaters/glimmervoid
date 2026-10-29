# server/radar

Radar: the opt-in lane that investigates PostHog issues and, when asked, fixes one and opens a pull request.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Radar / PostHog Auto-Fix (opt-in)

- Issue data is untrusted: Glimmervoid fetches the issue and its recent exception events into `untrusted.json`, and neither session gets a shell, a network tool or the PostHog key; an investigation reads the repo read-only and may use the gated read-only PostHog MCP.
- The fix lane only edits files; GLIMMERVOID commits with the repository's hooks and fsmonitor off and refuses a fix that rewrote the worktree `.git` entry or its admin `commondir`/`gitdir`, since an agent-planted hook or git pointer would run outside the lane (`commitFixWork`, `readWorktreeGitPointer`).
- The server REFUSES the handoff when the diff touches `.github/workflows/`, making "never touches CI" structural; the PR url comes from `gh` stdout, never the agent.
- The branch name carries a random discriminator: a deterministic one collides with a previous fix's pushed branch, burning the timeout on a regression after a fix.
- The live investigation view is the hook-derived trail plus the agent's narration read from its contained transcript at each tool call, never the PTY: `claude -p` writes nothing to its terminal until the final answer, so a terminal viewer would show a blank screen for the whole run.
