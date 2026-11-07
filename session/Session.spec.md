# Session

The session domain: spawning, supervising, resuming and shutting down agent sessions in PTYs, and the per-agent adapters

## entrances
- pty output: an agent process writes to its terminal, and the bytes reach the screen keeper, the recorder and the dashboard
  handler: Session in sessions.ts
  trust: agent-session

## invariants
- checkouts survive restart: A checkout a session made is found again from the owned-paths ledger after a restart or a session rebuild, so closing the session still refuses on its unsaved work and removes it once discard is confirmed.
  over: every checkout an earlier run of the same session id recorded in the owned-paths ledger
  via: a session rebuilt after a restart finds the checkouts its earlier run made, refuses removal on their unsaved work and removes them once discard is confirmed
  because: the checkout set lives in memory, so without the ledger a restart orphaned the checkouts and dropped the unsaved-work warning
  kinds: none
- checkout release keeps untracked checkouts: Releasing a session's checkouts deletes their folder only when no child of it still holds a .git.
  over: every checkout folder a session releases
  via: a checkout a plain session asks for comes back after a release, is refused at removal while it holds work, and is removed once discard is confirmed without taking a checkout it never tracked
  because: a checkout the in-memory plan does not track would be deleted with its uncommitted work by the unguarded folder removal
  kinds: none
- restart respawns after the kill: A forced restart respawns the agent once its killed process exits, and never reports the session inactive in between.
  over: every forced restart of a live session
  via: forceRestart never persists wasActive:false during its transient kill-then-respawn window
  because: a restart that never respawns leaves a dead card the operator asked to bring back, with no error shown
  kinds: none
- finish completes after the exit: Finish-and-merge runs its merge-and-reset step and returns the session to dormant once its agent process exits, at once when the agent already exited, after which the session can finish again; what the merge itself lands is the worktree lifecycle's to prove.
  over: every finish-and-merge request, with the agent live or already exited
  via: finishing a live agent runs merge-and-reset once its process exits, and an agent that already exited finishes at once
  because: a finish whose merge-and-reset never runs strands the worktree's work on a session stuck refusing every later finish as in progress
  kinds: none
