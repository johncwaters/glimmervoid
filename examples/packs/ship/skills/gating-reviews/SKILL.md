---
name: gating-reviews
description: Reviews local work once before it lands. Runs landing preflight, one /reviewing-code pass over the working tree, fixes only what that review proved broken, then stamps the reviewed tree so /landing commits exactly what was judged. Use for /gating-reviews, "review this before committing", or the review step before /landing.
---

# Gating Reviews

**Paths.** `<skill-dir>` is the directory you loaded this SKILL.md from. `<landing-dir>` is its sibling skill folder that holds `land.ts`.

One review pass over local work, ending in a stamp that `land.ts` checks before it commits.

## Input

Uncommitted local work, and one or two sentences of what changed and the goal it serves.

Or the `commits` a `PROMOTE_WITHHELD` result names, oldest first: commits on the branch that bypassed `land.ts`.

## Output

A stamp row over preflight's `paths`, carrying the findings left live or unverified, the pre-existing failures, and the truncated lanes. `/landing` writes its trailers from it.

## Steps

1. Run [Preflight](#preflight), so the stamp covers the integrated tree.
2. Follow [Review](subskills/review.md), which routes findings to [Fix](subskills/fix.md) and ends by writing the stamp.
3. Run `/landing`, carrying over any commit-only or local-only instruction.

## Commits

For `commits`, skip Preflight and the working-tree review. Invoke `/reviewing-code` with the base and head target `<oldest commit>^` and `HEAD`; a merge commit among them is reviewed as `<merge>^1..<merge>` over the files `git show --remerge-diff --name-only <merge>` lists, with that diff as context. Act on its findings as [Review](subskills/review.md) step 2 says: a fix lands through the [Steps](#steps) above as new work. Once step 2 leaves nothing to fix, run `node "<landing-dir>/stamp.ts" clear`, which records the branch's commits and merges as landed, then rerun `land.ts` with no message and the withheld landing's flags.

## Preflight

Run `node "<landing-dir>/preflight.ts" [--paths <file-or-dir> ...] [--no-fetch]`, with `--paths` when you know exactly which files this session
changed. Its `paths` is the scope of every step here.

**Branch guard.** `branchAllowed: false` means `main`, `master`, or the resolved mainline forbids
committing on this branch. `policy.commitBranches.onForbidden` permits only
`create-feature-branch`: create
a branch named for the work item, switch to it, and proceed.

**Mainline freshness.** A behind-mainline warning names the integration verb and when to
use it; follow it, then re-run preflight. On a conflict, resolve by step 2 of
[Conflict resolution](../landing/subskills/recovery.md#conflict-resolution) and continue;
no re-review, since nothing has been reviewed yet. `checked: false`: proceed.

An unresolved mainline warns; landing pushes the feature branch without promotion, unless the warning names a mainline `--promote` founds, which happens only while the current branch is the repo's only branch locally and on origin.
