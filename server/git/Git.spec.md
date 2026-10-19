# Git

Git access: async git execution, version checks and git-workspace.ts, the only module that runs git worktree

## invariants
- git worktree owner: Only server/git/git-workspace.ts runs git worktree, outside the one documented read-only exception.
  over: every source file in the project that names a git worktree command
  via: only git-workspace.ts (plus the documented read-only exception) issues `git worktree` directly
  because: a second caller could add or remove worktrees without the serialized git queue and ancestry checks, wiping another session's working tree
  kinds: storage
  checklist: scoped-reads dismissed: worktree listing is not a scoped read of records
  checklist: encrypted-storage dismissed: worktrees hold the operator's own source in the clear by design
  checklist: key-rotation-compatibility dismissed: no key is involved
  checklist: input-validation dismissed: the branch and path inputs come from glimmervoid itself, not outside callers
  checklist: revision-preservation dismissed: git keeps revisions; a worktree is a checkout, not a revision store
  checklist: commit-ordered-effects dismissed: worktree changes are local git operations with no external effect
  checklist: durable-dispatch-intent dismissed: nothing is dispatched; each worktree operation completes in its own call
  checklist: declared-target-coverage dismissed: each operation targets one named worktree, there is no fan-out
  checklist: completion-evidence dismissed: completion is the git exit code of the one operation
