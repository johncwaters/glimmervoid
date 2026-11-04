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
