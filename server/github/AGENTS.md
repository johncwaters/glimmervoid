# server/github

Shared GitHub store and lanes: pull request polling, and the opt-in team PR review that acts under the operator's name.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Shared GitHub Store

- Only the store modules read GitHub on the host; host handlers hold the gh client for writes only, and a lane session reads through `laneAccess` with the operator's read token, because one reader keeps every view's PR status the same and one rate-limit budget.

### Team PR Review (opt-in)

- Only the operator's Approve, Comment or Request changes posts, and only when the clicked head equals both the reviewed and the live head, since a review lands under the operator's name.
- Glimmervoid owns the report contract, not the procedure: skills differ per machine, so the review runs `teamReview.skill`; its cwd is an empty work dir and the untrusted checkout is never an `--add-dir`.
- The review has no OS sandbox (operator decision 2026-10-29): it refuses to spawn without the Sane YOLO hook, which refuses credential and `.env` reads, and it starts with `laneAccess`, so it refuses to start without the read token and never gets the operator's gh login. Its shell is read-only `git -C <checkout>` plus gh, so it reads PR code, fork PRs included, and never runs it: tests, builds and lint are CI's job (operator decision 2026-11-02).
- PR text is untrusted data, fenced in the prompt.
- Thread resolution also acts under the operator's name: only answered nit threads resolve without a click and each at most once, a judge failure never resolves, and the judge reading untrusted replies gets only Read, Write and the `laneAccess` read posture on Claude Code; Codex and Kimi expose no tool limit, so on them Sane YOLO and Codex's read-only mode are the only boundary (operator choice, 2026-10-28).
- An agent's `glimmervoid review` only queues a draft, never posts, and a lane session cannot ask at all, since a lane runs on unvetted input that could steer reviews.
- Review dirs are deleted on every exit and swept at start, bar a shutdown's resume record.
