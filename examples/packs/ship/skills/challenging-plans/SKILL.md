---
name: challenging-plans
description: Challenges a fresh plan with three read-only subagents to simplify every step. One argues for cutting it, one for shrinking it, and one for the lowest algorithmic bound the operation admits. The caller judges the verdicts, revises the plan, and stamps it with a CHALLENGE line. Use when the specifying skill reaches its challenge step or a drafted plan needs a direct challenge.
---

# Plan Challenge

**Paths.** `<skill-dir>` is the directory you loaded this SKILL.md from. `<landing-dir>` is its sibling skill folder that holds `land.ts`.

Every step is guilty until justified. Three challengers press necessity, leverage, and scale; the output is a plan at most the original size.

## Input

**Required input.** The draft plan with numbered steps, the goal it serves in one or two sentences, and the repo path. When the caller knows what the goal tolerates (stale reads, a lost write, one writer, tail latency), the goal names it: an unstated tolerance cannot cut the step that guards against it.

## Output

**Guaranteed output.** A revised plan whose final line is the stamp:

```
CHALLENGE: <kept> kept, <shrunk> shrunk, <cut> cut
```

The `specifying` skill stores that line as the design spec's `challengeStamp`, and its validator refuses a stamp that does not cover the units ready for work, which is what makes this skill part of the process rather than a suggestion. Writing the stamp without running the challengers defeats the gate and is a violation.

**Boundaries.** Challengers argue without editing files, rewriting the plan, or adding work. A challenge that proposes a new step is out of order and dropped: the only legal moves are cut, shrink, merge, keep.

## Step 1: Run the workflow

Call `Workflow({scriptPath: '<skill-dir>/workflows/plan-challenge.js', args: { goal, planText, repoPath, laneDir: '<skill-dir>/lanes' }})`. To re-run a dead lane retry under `resumeFromRunId` without replaying its cached output, add a new `retryAttemptId`. `lanes` holds each surviving lane's `text` to judge. Read `survivingLanes` for the `(lanes: <comma-separated names>)` stamp suffix whenever fewer than all three lanes survive. A plan written as prose or headings has no detectable step, so before calling, restate it as a numbered list (`1.`, `2.`, one line per step at column zero) and pass that text.

Workflow tool absent (every agent but Claude Code): read `<skill-dir>/workflows/plan-challenge.js`, run each lane it names with the brief in `<skill-dir>/lanes/plan-challenger.md`, and converge by the rules in that script.

## Step 2: Converge and judge

The caller judges; challengers only argue. Per step, start from the most aggressive verdict any lane returned (CUT beats SHRINK beats KEEP). A step survives a CUT or escapes a SHRINK only through a rebuttal naming the concrete failure that occurs without it; "might need it later", "best practice", and "small anyway" all lose. A scale SHRINK is escaped only by a rebuttal naming the fact that bounds the input (an enum, a config cap, a fixed list) and where it lives; "it will be small" loses. `unverified` evidence loses to verified evidence pointing the other way.

Overriding more than a third of the aggressive verdicts means the challengers misread the goal: fix the goal statement and respawn rather than bulk-rebutting.

No lane surviving is not a thinner challenge but no challenge at all: return the plan to its caller unstamped.

## Step 3: Revise and stamp

Apply the surviving verdicts, merge and renumber, and keep each step one short line naming its work; a merged step names the combined work in one line, not both texts. Under the steps, list a `Bounds:` block with one line per surviving step, keyed by its new number: a step a scale SHRINK rewrote carries only the lowered bound that SHRINK named, or for a cache SHRINK at the same bound, that bound marked `O(n) in rows; no cache`; a merged step carries the bounds of every step it absorbed; only a cut step drops its bound. Write a bound as `O(n) in rows` or, when a scale KEEP named the infrastructure a lowering would need, `O(n²) in rows; O(n log n) needs an index on created_at`, so the operator approving the plan sees the cost being approved and what would lower it, while step lines stay short enough to become titles. Append the `CHALLENGE:` stamp as the last line and hand the revised plan to whatever comes next — usually the `specifying` skill, which records the stamp. Counts in the stamp refer to the original steps: a step merged into another counts as shrunk.
