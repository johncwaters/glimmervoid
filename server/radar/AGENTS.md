# server/radar

Radar: the opt-in lane that investigates PostHog issues and, when asked, fixes one and opens a pull request.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Radar / PostHog Auto-Fix (opt-in)

- The agent COMMITS; the server pushes and opens the PR. `FIX_DENY` denies `git push` and `gh` outright, since a prefix deny-list cannot constrain a push TARGET or a merge API call.
- The server REFUSES the handoff when the diff touches `.github/workflows/`, making "never touches CI" structural; the PR url comes from `gh` stdout, never the agent.
- The branch name carries a random discriminator: a deterministic one collides with a previous fix's pushed branch, burning the timeout on a regression after a fix.
- Both sessions start inside the sandbox runtime with open network, because they fetch untrusted issue data (`radarLaneRole`): an investigation writes only its report and result folders, a fix also commits in its own worktree, and the repository's hooks and git config stay locked (`node scripts/probe-guardrails-roles.ts --role posthog`).
- The live investigation view is the hook-derived tool trail, never the PTY: `claude -p` writes nothing to its terminal until the final answer, so a terminal viewer would show a blank screen for the whole run.
