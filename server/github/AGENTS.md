# server/github

Shared GitHub store and lanes: issue and pull request polling, and the opt-in team PR review that acts under the operator's name.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Shared GitHub Store

- Only the store modules read GitHub; lanes and handlers hold the gh client for writes only, because one reader keeps every view's PR status the same and one rate-limit budget.

### Team PR Review (opt-in)

- Only the operator's Approve, Comment or Request changes posts, and only when the clicked head equals both the reviewed and the live head, since a review lands under the operator's name.
- Glimmervoid owns the report contract, not the procedure: skills differ per machine, so the review runs `teamReview.skill`; its cwd is an empty work dir and the untrusted checkout is never an `--add-dir`.
- The review starts inside the sandbox runtime (`teamReviewRole`: closed egress, credential folders unreadable, a Codex home of its own, no secret in env); a session that cannot apply it never spawns.
- The wrap still runs PR code (linked `node_modules`, tests, lint) as the operator, fork PRs from anyone included (operator-accepted 2026-10-26), and the linked clone's `.env` deny is root-level only. `api.github.com` stays reachable because Codex stalls at startup without it; no GitHub credential is readable inside.
- PR text is untrusted data, fenced in the prompt.
- Thread resolution also acts under the operator's name: only answered nit threads resolve without a click and each at most once, a judge failure never resolves, and the judge reading untrusted replies gets only Read and Write.
- An agent's `glimmervoid review` only queues a draft, never posts, and a lane session cannot ask at all, since a lane runs on unvetted input that could steer reviews.
- Review dirs are deleted on every exit and swept at start, bar a shutdown's resume record.
