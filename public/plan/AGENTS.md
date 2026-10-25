<!-- Parent: ../AGENTS.md -->

# Plan Review

- Never parse plan HTML, because plan text crosses an untrusted boundary.
- Keep only `http:` and `https:` link targets, because other schemes can execute or escape the dashboard trust boundary.
- Mount the plan as the session card's second face, because Focus and phone must share one live session surface.
- Action labels stay constant, with progress beside them; Approve and Send feedback are mutually exclusive by pending comment count so approval never drops feedback.
- A decision is offered only on the OPEN revision with its body on screen, or the bar approves bytes nobody read and the server refuses every click; a reopen moves the face onto the new revision, which `public/plan/plan-face.ts` owns.
- `session-plan-changed` is REFRESHABLE, so backpressure can drop it: a VISIBLE face re-pulls when it is shown or the socket reconnects, carrying its live selection, since a hidden face re-pulls on show anyway and one reconnect must not fan a plan body out to every card.
- A DRAFT is never decidable: `revision: 0` marks bytes the agent has not submitted, so the whole bar is disabled while one is on screen and the status text says Draft.
- Pulling the diff base never moves the selection, or a click decides the revision the operator was only comparing against.
- The diff trims the shared prefix and suffix before comparing and refuses a changed middle over `PLAN_DIFF_MAX_LINES`, showing the newer body whole instead, since two 512 KB bodies would otherwise lock the tab; an unchanged run longer than the context window collapses to one skipped row, since a near-identical pair renders a DOM row per line and locks it just the same.
- Section comments are the only feedback channel, retained until the server confirms `revise`, and filed against the session, agent and revision captured when the inline composer opened. Selection or mode changes close it; drafts offer none, since unsubmitted bytes cannot own feedback.
- A plan response moves the selection only when it answers what the selection asked for, since a draft or a diff base landing after a tab switch would otherwise show one agent's bytes under another.
