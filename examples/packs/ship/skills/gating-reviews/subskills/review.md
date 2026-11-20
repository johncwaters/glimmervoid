# Review

One review is the gate. What you fix after it is checked by re-running each
finding's proof and then the suite.

**Skip the review** for a pure rename or a reviewer's suggestion applied verbatim, with
passing tests, when the stamped paths change nothing else; code the operator dictates is a logic change and gets the review. Go straight to **Stamp the tree**.

**Step 0, once.** Run `cleaning-ai-slop` on preflight's `paths` as its file list. Edit existing files only, including tests; run existing tests only. Limit naming, error-handling cleanup, and low-value test removal to lines already changed.

**Then one review, the fixes, and the commit.** Each finding carries a `Proof:`; re-run
that proof in place of a confirming review.

1. Invoke `/reviewing-code` with target `working`, the repo path, preflight's `paths`
   as `--paths`, and one or two sentences of what changed and the goal
   it serves. Use only `working`: `land.ts` stages every tracked
   modification in scope plus the scoped untracked files, so a `staged` review would
   approve a subset of what gets committed.
2. Act on `VERDICT`, `TRUNCATED`, and the rows, not the HIGH+ `ACTIONABLE` count:
   - `VERDICT: FAILED`: the review did not complete. Re-run it once. Failing twice, stop
     and report; a failed review counts only as failed.
   - An `AMBIGUOUS` finding at MEDIUM or higher: when a decision in the design spec or
     intent settles it, apply that decision: fix it makes it `ACTIONABLE`, with the
     decision written into its body, and it joins the batch below; leave it makes it a
     `NIT`. When none settles it, surface it as a design question with both readings
     stated, as a spec surfaces an open decision, and act on the answer the same way. Report LOW
     `AMBIGUOUS` findings without interrupting.
   - `ACTIONABLE` at MEDIUM or higher: fix exactly those by [Fix](fix.md). LOW findings
     and `NIT`s are listed in the commit report and left alone.
   - No `ACTIONABLE` finding at MEDIUM or higher: go to **Stamp the tree**.
3. Report each fixed finding's outcome, then run the test suite that covers the changed
   files, since the fixes postdate the review:
   - `FIXED`: one line in the commit report.
   - `UNVERIFIED`: the finding goes in the stamp's `unverifiedFindings`.
   - `DECLINED`: a proof that shows no defect refutes the finding; one that still shows
     it leaves a live defect. Either goes in the commit report.
   - A failing suite is yours to fix at the root cause before the commit. Re-run every
     `FIXED` finding's proof after that edit, since it postdates them; the review is not
     run again for it.
   - A failing test is pre-existing only when an `origin/<mainline>` worktree on the
     checkout's dependencies fails it with the same error. Proceed without blocking or
     asking the operator: name it in the stamp's `preexistingFailures`.

**Stamp the tree** last, after every fix and the suite, skipped review included:
`node "<landing-dir>/stamp.ts" write --gate gating-reviews --paths <preflight paths> --findings <file>`
with `{liveFindings, unverifiedFindings, preexistingFailures, truncatedLanes, droppedUnproven}`
in a file saved with Write, each finding `{severity, file, summary}`. A live or `UNVERIFIED` MEDIUM+ on any branch
stamp makes `land.ts --promote` return `PROMOTE_WITHHELD`. Exit 31 prints its fix.

A `TRUNCATED` line naming a lane goes in the commit report, since nothing sweeps for the
overflow that lane dropped, and so does a nonzero `Dropped unproven` count from the review
summary, since those rows bypassed triage.

**A merge you resolve by hand invalidates the review of the branch it lands on.** A clean
merge is not a safe merge: integration can change a helper in one file while the reviewed
change adds its caller in another. Where [recovery](../../landing/subskills/recovery.md) says **re-review**, it means
steps 1 to 3 of this review, run fresh on the merged tree.

One carve-out, and only one: merging `origin/<branch>` into the same local branch needs no
re-review, because whatever is on the remote was reviewed by whoever landed it. Every other
merge, a feature branch into an integration branch included, is a combination nothing has
looked at.

