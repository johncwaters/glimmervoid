# Fix

Fix the `ACTIONABLE` findings the caller hands over yourself, in this session; `NIT` and `AMBIGUOUS` ones stay as the caller routes them. Nothing reviews these edits afterwards, so each finding's own proof is the check.

Each finding's `body` names the defect, the `Proof:` that shows it, and usually the fix. Take the fix as a strong suggestion: a better one is fine when its blast radius is equal or smaller and every edit stays inside the caller's write scope, by default the changed-file list; say so in the commit report.

1. Run the finding's `Proof:` before editing: the command, or a re-read of the quoted lines.
2. Make the smallest edit at the source that removes the defect, then search the write scope for the same defect elsewhere (a sibling call, key, branch, or the test that pins it) and remove every instance, since a proof citing one line passes while a sibling survives for a later review to find. Suppression comments, disabled rules, widened types, swallowed errors, and skipped tests leave it in place; a real upstream blocker gets a one-line comment naming the issue and the removal trigger.
3. Run the same proof again and give the finding one outcome:
   - `FIXED`: the proof no longer shows the defect, and no instance of it is left in the write scope.
   - `UNVERIFIED`: you edited but the proof cannot run here, or an instance of the defect is left in the write scope because its fix needs a design decision or failed; name that instance.
   - `DECLINED`: no edit, because the proof shows no defect, the fix needs a design decision neither the finding nor the design spec or intent settles (surface it as a design question that names the traced cause and offers the fix at it first), it needs a file outside the write scope, or two findings prescribe contradictory fixes to the same lines. A declined finding leaves no edit behind.
4. Name in the commit report, and leave alone, a different defect you notice on the way and any instance of the same defect outside the write scope.
