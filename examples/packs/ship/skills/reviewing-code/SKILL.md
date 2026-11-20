---
name: reviewing-code
description: Reviews diffs as the internal engine. Pins an immutable object, runs the qa-swarm lanes, gives every finding one disposition, and returns a verdict plus dispositioned findings. Stays read-only except its REVIEW_FILE, with no git history changes, posts, or repeat passes. Use when /gating-reviews invokes the engine; direct requests route through those entry points.
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/route-lanes.mjs *)
---

# Code Review

**Paths.** `<skill-dir>` is the directory you loaded this SKILL.md from. `<landing-dir>` is its sibling skill folder that holds `land.ts`.

One pass. Pin, find, triage, judge, return. A change gets this pass once, so it reports what a lane proved broken and nothing a lane only suspected.

## Input

**Required input.** A target, in one of three forms: `staged`, `working` (a local tree), or a base and head ref (a branch or a pull request); the changed-file set as `-- <paths>`; 2 to 4 sentences of context that the diff does not carry, and optionally `uncapped` and `allLanes`. If the caller omits paths, derive the set with `git diff --name-only` from the target diff and state the derived set in the output.

## Output

**Guaranteed output.** The [Step 5](#step-5-return) return, with a `disposition` field per finding. Nothing after it.

**Boundaries.** No file edits beyond the `REVIEW_FILE`. No `git add`, `commit`, `push`, or branch operations. No PR comments. No second round: no caller carries findings from one pass into another, because a second sweep of the same diff turns up fresh MEDIUM findings every time.

**Not a direct entry point.** Asked to review something conversationally, route it: local work goes through `/gating-reviews`, which calls this skill with a proper target.

## Step 1: Pin the target

Pin only to an immutable object. Lanes run concurrently for minutes, and `git diff --cached` re-reads the index on every call, so an edit or a `git add` mid-review silently hands later lanes a different diff.

- **staged**: `TREE=$(git write-tree)`, then `REVIEW_CMD="git diff HEAD $TREE"`. `write-tree` freezes the current index as a tree object without touching the index, the refs, or the stash stack

- **working**: `TREE=$(node "<landing-dir>/stamp.ts" pin)`, then `REVIEW_CMD="git diff HEAD $TREE"`. It snapshots through a throwaway index, so the live index stays intact. A non-zero exit or empty `TREE` means the target could not be pinned: return `FAILED`, since `git diff HEAD ` reads the live tree

- **branch or pull request**: resolve `BASE_SHA` and `HEAD_SHA`, then `REVIEW_CMD="git diff <BASE_SHA>..<HEAD_SHA>"`. Both are already immutable

## Step 2: Find

Run `node ${CLAUDE_SKILL_DIR}/scripts/route-lanes.mjs --review-cmd "$REVIEW_CMD" --repo <repo path> -- <changed files>` (`--all-lanes` when `allLanes`), with the path unquoted so it matches this skill's `allowed-tools` grant in a locked-down review; `${CLAUDE_SKILL_DIR}` is this skill's directory, `<skill-dir>`, for an agent that does not substitute it. Exit 2 means an unreadable diff: return `FAILED`. Refused: use `{lanes: ['code'], filesByLane: {code: <changed files>}}`; the workflow router widens it.

Call `Workflow({scriptPath: '<skill-dir>/workflows/qa-swarm.js', args: {reviewCmd, repoPath, context, changedFiles, ruleLanes, laneDir: '<skill-dir>/lanes'}})` with its JSON as `ruleLanes`, the caller's context verbatim, and `findingCap: null` when `uncapped`. To re-run a dead retry under `resumeFromRunId`, pass a new `retryAttemptId`.

Parity gap: the Workflow tool exists only in Claude Code. Every other agent reads `<skill-dir>/workflows/qa-swarm.js` and runs its rule lanes itself, one after another (or as subagents where the agent has them), each lane following its brief in `<skill-dir>/lanes/`, then converges by the script's rules.

A result whose first line is `LANE_DEATH:` is a failed review. Return `VERDICT: FAILED` with whatever findings did arrive and a summary naming the dead lane, and always include the `VERDICT` line: a caller parsing for it would hang or guess.

## Step 3: Triage

Every finding leaves this step with exactly one disposition. A finding with none is a bug in the run, not an acceptable outcome.

Remove a finding whose line the diff did not change and whose body describes a pre-existing defect rather than one a changed line causes, and count removals in one `OVERALL_SUMMARY` sentence; severity does not rescue it. The scope hook's note on a lane result names such lines for a `working` target only; ignore it for other targets, where it diffs the wrong tree. Set `TRUNCATED` to the lanes the swarm's `truncated lanes:` phrase names.

| Disposition | Assign when | What the caller does with it |
|---|---|---|
| `ACTIONABLE` | The body's `Proof:` is one the writer can run again (a command with the output it produced, or quoted lines with file:line), it shows the defect on a path the change's own callers, tests, or documented commands reach, or, for `boundary/` or `architecture/`, on an input or change its lane file's proof bar admits, and the fix is bounded | Hands it to a writer, who re-runs that proof before and after the edit. The only disposition a writer ever sees |
| `NIT` | Style, preference, a duplicate of another finding, plainly out of the change's scope, or a `Proof:` that is a scenario rather than a run or a quote | Records it; leaves it unfixed and nonblocking |
| `AMBIGUOUS` | Contested between lanes, cross-cutting enough that the fix is a design decision, or the intent behind the code is unclear | Stops and asks the operator, with both readings stated |

Rules that decide the hard cases:

- qa-swarm drops every row without a `Proof:` label, so the label's presence is settled before triage and its content is what triage reads. A proof that narrates what a caller could do, with no command output and no quoted lines, is a `NIT` below HIGH and `AMBIGUOUS` at HIGH or CRITICAL: the writer needs a run or quote to recheck the defect.
- A finding whose `body` carries `Confidence: low` is ineligible for `ACTIONABLE`. It is `AMBIGUOUS` if it would block, `NIT` if it would not.
- A `convergent:` finding is `ACTIONABLE` if its fix is bounded and one of its parts carries a re-runnable proof. Agreement between lanes confirms a proof; it requires one.
- A CRITICAL or HIGH finding is ineligible for `NIT`. If it cannot be `ACTIONABLE`, it is `AMBIGUOUS`.
- A CRITICAL finding needing an architecture call is `AMBIGUOUS`.

## Step 4: Verdict

The tier is the highest severity still standing after triage and dedup:

| Highest severity | Verdict |
|---|---|
| CRITICAL | `BLOCKED` |
| HIGH | `REQUEST CHANGES` |
| MEDIUM | `APPROVE WITH NITS` |
| LOW or nothing | `APPROVE` |

Highest-severity-wins rather than a count-weighted score, because CRITICAL and HIGH block outright. Counts go in the summary, where they inform without moving the gate.

A fifth value, `FAILED`, means the review could not be completed: qa-swarm returned `LANE_DEATH:`, or the target could not be pinned. It is not a judgement about the code. A caller treats it exactly as it treats `BLOCKED`, except that re-running is worth trying once because the cause is usually a dead process rather than a defect.

State the verdict and the count of surviving `ACTIONABLE` findings at HIGH or higher on separate lines in the summary.

## Step 5: Return

```
VERDICT: <APPROVE|APPROVE WITH NITS|REQUEST CHANGES|BLOCKED|FAILED>
ACTIONABLE: <count>
TRUNCATED: <lane list or "none">
REVIEW_FILE: <path>

STRUCTURED_FINDINGS:
- file: <path> | line: <number or "general"> | side: <RIGHT|LEFT> | severity: <CRITICAL|HIGH|MEDIUM|LOW> | reviewer: <tag> | disposition: <ACTIONABLE|NIT|AMBIGUOUS> | body: <the review comment text>

OVERALL_SUMMARY:
<one paragraph>
```

Nothing found: `VERDICT: APPROVE`, `ACTIONABLE: 0`, and `(none)` as the `STRUCTURED_FINDINGS` block.

Write the return to `review-<pinned id>.txt` in the scratchpad and name it in `REVIEW_FILE`: callers pass the path, since a command-safety hook can block review text in a shell command.

`VERDICT` comes first so a caller can gate on one line without parsing the block. `TRUNCATED` names every lane whose findings a cap dropped, or `none`, and it is machine-readable because the caller reports it: nothing afterwards sweeps for the overflow a cap dropped.

The summary states: the pinned tree or SHA range, changed-file set, file and line counts, which lanes ran and which degraded, the count per severity, the count per disposition, and qa-swarm's `Dropped unproven` count. Then stop. No recommendation about what to do next, and no offer to fix anything.

## Token discipline

Expense should land on lanes, not on this skill's own reasoning. Everything here is bookkeeping over a block qa-swarm already produced: pinning, one classification per finding, one table lookup. Re-reading the diff to second-guess a lane means the lane prompt was wrong.

## Scripts

- `scripts/route-lanes.mjs`: picks rule lanes from changed paths and lines; run in Step 2.
