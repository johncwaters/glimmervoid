# Recovery

Every result carries a typed `next`; do what it names. This file holds only the judgment `next` cannot carry. The ship commit gate refuses a raw `git commit` or `git push`; a step here that needs one prefixes it with `SHIP_LANDING_RECOVERY=1`.

## Contents

- [A flagged file that belongs](#a-flagged-file-that-belongs)
- [Conflict resolution](#conflict-resolution)
- [Push and promote recovery](#push-and-promote-recovery)
- [Syncing a pull request branch](#syncing-a-pull-request-branch)

## A flagged file that belongs

`DENYLISTED_FILE_STAGED`, `HOME_PATH_STAGED` and `SECRET_STAGED` name files or lines `next` says to unstage, replace, or strip; a `SECRET_STAGED` match prefixed with a commit hash sits in an unpushed commit, so fold that range into the tree with `git reset --soft` before stripping it; a secret that reached a remote earlier also needs rotating. When one genuinely belongs in the commit, unstage it anyway, land the rest, and report the file left out; there is no override.

## Conflict resolution

`PROMOTE_CONFLICT` with files in `conflicts` is yours to resolve; continue through recovery.

1. On the feature branch, fetch origin and rebase onto `policy.resolved.mainline`.
2. Run `node "<landing-dir>/resolve-changelog.ts"` first: it merges and stages
   each CHANGELOG.md whose only conflicts add Unreleased bullets on both sides, and prints
   `remainingConflicts`. Resolve each remaining file on its merits rather than blanket
   `--ours`/`--theirs`: read both sides, keep both intents where they are independent, pick the
   semantically correct result where they collide, and retain changes you cannot account for.
3. Stage the resolutions and continue the rebase.
4. Re-review the rewritten feature range before it reaches mainline.
5. Re-run `land.ts` with the same flags so it finishes the fast-forward and push.
   `NOTHING_TO_COMMIT` there is expected.

A local mainline ahead of or diverged from origin is not a conflict: `land.ts` keeps its
local-only commits on the `rescue/<mainline>-<UTC>` branch its warning names, resets
mainline to origin, and promotes. Report the rescue branch.

When the same hop conflicts again after two attempts, a conflict involves changes you
cannot attribute, or resolving would mean discarding one side wholesale, abort the rebase,
leave the feature branch pushed and unpromoted, and report the conflicting files.

## Push and promote recovery

A SessionStart `Parked branches:` entry is an unfinished landing from `~/.agents/commit-ledger.jsonl` (or the absolute `CLAUDE_COMMIT_LEDGER` override).
Return to the listed branch, rerun preflight, follow the outcome's recovery instructions, then rerun `land.ts` with the original flags, which retries a failed push.

`PUSH_FAILED` and `PROMOTE_FAILED` are yours to resolve the same way. `warnings` names the
root cause. Fix it, then re-run `land.ts` with the original flags, which retries the push; a
`NOTHING_TO_COMMIT` outcome on the re-run is expected. These git commands are sanctioned
only to unblock the run.

- Mainline push rejected (non-fast-forward, "stale info", "fetch first"): the remote moved
  after preflight. The feature branch safety push preserves the work. Resolve local
  mainline against origin by hand without force, then re-run from the feature branch.
- Feature push rejected: fetch and merge `origin/<branch>` into the same local feature
  branch, push it, then re-run. A conflict resolved by hand requires re-review first.
- A destination branch checked out in a dirty worktree: if the uncommitted changes are this
  session's, land them by running this whole workflow in that worktree, review
  included. Commit them only through this workflow to clear the way. Changes you cannot attribute are a
  stop case.
- Transient network or remote errors: re-run once before treating the failure as real.
- Feature push denied on permissions (403, "Permission denied"): the branch is pushing
  somewhere other than its PR head. Read the head with
  `gh pr view --json headRepository,headRefName`; when a configured remote points at that
  repository and `headRefName` is not main, master, develop, or the resolved mainline,
  run `SHIP_LANDING_RECOVERY=1 git push <remote> HEAD:<headRefName>`,
  `git branch --set-upstream-to=<remote>/<headRefName>`, and
  `git config branch.<branch>.pushRemote <remote>`, then re-run `land.ts`, which now
  pushes there.

Stop and report only when the failure is authentication or branch protection; when a
permissions failure persists because no configured remote holds the PR head, the PR head
is main, master, develop, or the resolved mainline, or the push there is denied too; when
the same failure survives two recovery passes; or when fixing would mean touching changes
you cannot attribute.

## Syncing a pull request branch

A repo skill for syncing or stacking (one running `gh stack sync`, say) that the operator
trusts owns the sync and its push. A rebase whose conflicts you resolved by
hand goes through the `/gating-reviews` `commits` path over that layer before the skill's tool pushes it. Otherwise a pushed pull request branch
takes mainline by merge, so it needs no force push.
`git merge origin/<base>`, where base is the mainline, or in a stack the branch below once it
pushed; sync a stack bottom-up, one landing per branch. On conflict, preflight's
`OPERATION_IN_PROGRESS` names the `unmerged` files: resolve each as
[Conflict resolution](#conflict-resolution) step 2 says, stage them, run
`git merge --continue`, rerun preflight, then run `land.ts` with no message and the
original flags. A merge git made cleanly pushes; a hand-resolved one comes back
`PUSH_WITHHELD` until its review records it. Push through `land.ts` or the repo skill's tool
yourself rather than handing the operator a push script.
