---
name: landing
description: Lands reviewed work through the ship commit workflow. Reads the review stamp, then runs land.ts, which stages exactly the tree a review gate stamped, commits, and pushes (or, with --no-push, commits locally only) with typed outcomes, then promotes the feature branch onto the resolved mainline or leaves it pushed for /opening-prs, by who owns the GitHub repo. Use for /landing, "commit this", "commit and push", "commit locally", or landing finished work.
---

# Commit

**Paths.** `<skill-dir>` is the directory you loaded this SKILL.md from. `<landing-dir>` is its sibling skill folder that holds `land.ts`.

Two deterministic steps own everything that touches git. A review gate
(`/gating-reviews` by default) stamps the tree first; you own the message and recovery. Stage, commit, push, or merge by hand only
within [recovery](subskills/recovery.md).

```
node "<landing-dir>/stamp.ts" verify
node "<landing-dir>/land.ts" [--promote] [--no-push] [--message-file <file>]
```

Both print one JSON object on stdout.

## Step 1: read the stamp

Run `stamp.ts verify`. The review gate already ran preflight, so it prints what landing needs:
the stamp, `policy` (with `afterCommit` and `resolved.mainline`), and `remoteVisibility`.
`matches: false` means no gate judged this tree: run the gate the stamp names, or
`/gating-reviews`. `land.ts` stages exactly the stamp's paths.

**Commits already made.** A clean tree with unpushed commits (a mainline sync's merge,
a withheld landing) needs no stamp or message: after the Step 3 disclosure check, run
`land.ts` with no message, and follow `PUSH_WITHHELD` like `PROMOTE_WITHHELD`.

## Step 2: write the message

Write a conventional-commit message; `node "<landing-dir>/preflight.ts" --check-message <file>`
names each format and trailer rule it breaks without committing, so send `land.ts` only the final
message. It does not check the Step 1 stamp mapping, so apply it yourself: `unverifiedFindings` go in `Not-tested`, which keeps `Confidence` below `high`;
`preexistingFailures` in `Constraint`; each live MEDIUM+ in the body. `Ticket: <spec-slug>/<ticket-id>`
goes only on the commit that lands one ticket of an intent, where a resumed build reads it to find the
tickets left.

## Step 3: disclosure check

Many work repos are public, and a push publishes the diff and message to everyone. Before
landing, decide whether everything the landing would publish should reach the remote at
all: the working changes plus every local commit not yet on the remote, read with
`git log -p @{upstream}..HEAD`, or `git log -p origin/<mainline>..HEAD` when the branch has
no upstream. An earlier held-back commit among them holds back this landing too. Treat
`remoteVisibility.visibility` of `public` or `unknown` as public; `private` and `internal`
are not.

Keep these off a public remote:

- A fix for an exploitable vulnerability that has not been disclosed, its regression test,
  or a message describing the attack. The diff alone shows attackers what was open.
- Credentials, customer names or data, PII, internal hostnames, or incident details.

Resolve each, then report what you did:

- A secret, credential, customer detail, PII, internal hostname, or incident detail: strip
  it from the tree and the message. When an unpushed commit carries it, first fold the
  unpushed range into the working tree with `git reset --soft <the base read above>`, so no
  pushed commit keeps it. Rerun the gate, then land. One that already reached a
  remote needs rotating, not just deleting; name it in the report.
- An undisclosed vulnerability fix: run `land.ts` with `--no-push` and without `--promote`.
  When the repo's `SECURITY.md` names a private channel, use it. When the remote is GitHub,
  open a draft advisory with `gh api repos/<owner>/<repo>/security-advisories`, create its
  private fork through the advisory's `forks` endpoint, push the commit there, and report the
  advisory URL. With neither available, report the local commit.

Everything else lands normally. On a public remote, still write the message as public
text: name the defect class; keep exploit steps and customer identities out.

## Step 4: land

Save the message with the Write tool in the session scratchpad and pass its path as
`--message-file`: message text in a shell command can trip a command-safety hook when it names a secret path.

Flags:

- No path flag: `land.ts` stages exactly the last stamp's `paths`, and refuses with
  `NOT_REVIEWED` when no stamp matches the tree over them. Report `excluded staged files`
  warnings; those files stay in the working tree. New `.coherence/**/*.jsonl` files ride along.
- `--promote`: pass it when `policy.afterCommit` is `promote`. It carries the commit
  by rebasing the feature branch onto `policy.resolved.mainline`, fast-forwarding
  mainline, and pushing mainline. Omit it when the
  disclosure check held the change back or the operator asked for commit-only
  (`commit only`, `don't merge`).
- `--no-push`: only when the operator asks for local-only work or the disclosure check held
  the change back.

## Scripts

- `preflight.ts`: review gates run it first to resolve policy, freshness, branch eligibility, and scoped paths.
- `land.ts`: run after the message and disclosure checks to stage, commit, push, and optionally promote.
- `stamp.ts`: review gates write the stamp; `verify` prints it with the policy and remote visibility.
- `resolve-changelog.ts`: run first when resolving a rebase or merge conflict to merge CHANGELOG.md Unreleased bullets from both sides.

## Outcomes

Exit code carries the outcome; the JSON carries the detail and a typed `next`. Act on it:
`proceed` continues to the next step; `done` reports; `runGate` runs `gate`, then lands again, except that with `commits` (oldest first) it passes them to the gate, which reruns `land.ts --promote` itself; `rerun` reruns `script` with the same flags once `after` is done;
`fixAndRerun` fixes each of `items`, then reruns; `resolveConflicts` follows
[Conflict resolution](subskills/recovery.md#conflict-resolution); `relay` passes `report` on verbatim, then continues the caller's flow; `stop` relays `report`. Report one line with the outcome, short hash, and
message subject, then one line per finding fixed.

Report safety-push failures from `warnings`; the outcome stays unchanged.

## After the commit

Read `policy.afterCommit`:

- `promote`: promotion already ran inside `land.ts`. Even when asked to "just merge it
  quickly", re-run `land.ts`.
- `pull-request`: keep the feature branch unmerged everywhere. When the disclosure check held
  the change back, stop after reporting; a public pull request discloses it too. Otherwise
  offer to open a pull request against the repository's mainline with `gh pr create`. If the
  operator declines, or the remote is not on GitHub, report the pushed branch and stop; leave merging to the PR host.
- `unresolved`: GitHub could not say who owns the repo and no earlier answer was saved. Report
  the warning and the pushed branch, then ask the operator whether to promote (rerun
  `land.ts --promote` with no message) or follow `pull-request` above.
