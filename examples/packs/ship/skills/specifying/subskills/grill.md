# Grill

Close every branch.

1. On a resume that brings the answer to an open question, first write status `sketch` with `challengeStamp` and `challengedUnitIds` removed. Then turn that node into a `decided` decision and remove its `deferredBy` edges.
2. Close each branch the repo answers as a `read` decision, and each branch the operator already answered in the conversation or on a whiteboard as a `decided` decision whose `why` names where. Settle the rest through `ask.md`.
3. Order by what deletes the most questions: the problem and the solution to it, then scope, then behavior, then failure and edge cases, then naming. Follow the `blocks` edges. A branch holding the solution the request named is asked beside the real alternatives, so the round weighs it against them.
4. Ask each round through `ask.md`. Once zero branches remain, rate the goal's `risk` yourself from the work at the highest level any signal reaches: `critical` touches secrets, auth, irreversible data or machine operations, or the review and landing gates; `high` changes hooks, installers, or shared libraries every session or machine runs; `medium` changes behavior across files, or adds a skill, agent, or config; any other change is `low`. Then write the goal's `criteria` yourself, 1 to 12 observable success criteria drawn from the goal and the decisions; the hand off lists them. Word each criterion from the seat of whoever observes it: when an agent gains a capability, the criterion says that agent exercises it from its own lane, not only that the mechanism works when called directly.
5. Add the branches each answer opened, plus every fork these probes reveal:
   - Problem: who hits it today, and what they do instead.
   - Behavior: the desired flow step by step; for a UI, the HTML board mockups of `design.md` step 1, drawn here at risk `low` too.
   - Scope: the nearest thing left out, and what the change makes dead, deleted in the same units.
   - Input: empty, huge, malformed, duplicate.
   - Numbers: each cap, page size, budget, or threshold closes as a tunable a bench unit measures, with no guessed value offered as an option; on an upgrade request, today's limits and code are inputs, not constraints.
   - Failure: a dependency failing, a halfway stop, a rerun.
   - Existing state: data, config, and machines that predate the feature converge to the new shape, with no compatibility path.
   - Reach: each other caller, profile, and platform, whether it still makes sense, and whether it can defeat the feature.
   - Removal: how the feature is retired.
   - Proof: a check from the user's seat (a fresh agent for a skill, the real app for a UI) that drives the real dependency and fails before the change; performance measured before and after; for a bug, a check stopping its class.
6. Repeat until zero branches remain. At risk `low`, set status `grilled` and continue to `slice.md`; above `low`, keep status `sketch` and continue to `design.md`. A branch whose options all lead to the same units closes on its recommendation as `assumed`.
