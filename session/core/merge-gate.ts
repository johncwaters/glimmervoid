import type { MergeStatus } from "./worktree-state.ts";

const REVIEWABLE: MergeStatus[] = ["pending-review", "parked"];

interface WorktreeSignature {
  dirty: boolean;
  ahead: string;
  behind: string;
  rebaseInProgress: boolean;
}

function isZero(count: string): boolean {
  return count === "" || count === "0";
}

function decideSignatureDemotion(mergeStatus: MergeStatus, sig: WorktreeSignature): MergeStatus | null {
  if (REVIEWABLE.includes(mergeStatus) && !sig.dirty && isZero(sig.ahead)) return "none";
  if (mergeStatus === "parked" && !sig.dirty && !isZero(sig.ahead)
      && isZero(sig.behind) && !sig.rebaseInProgress) return "pending-review";
  return null;
}

function decideBaseSyncDemotion(
  mergeStatus: MergeStatus,
  mergeReason: string | null,
  baseSyncState: string,
): MergeStatus | null {
  if (mergeStatus !== "parked" || mergeReason !== "base-diverged") return null;
  if (!["in-sync", "ahead", "behind"].includes(baseSyncState)) return null;
  return "pending-review";
}

function decideDiffSelfHeal(
  mergeStatus: MergeStatus,
  patch: string,
  hasCommits: boolean,
): MergeStatus | null {
  if (!REVIEWABLE.includes(mergeStatus)) return null;
  if (hasCommits || patch.trim() !== "") return null;
  return "none";
}

interface StandardsGateFacts {
  enabled: boolean;
  requiredCheckIds: readonly string[];
  run: { sig: string; checks: readonly { id: string; status: string }[] } | null;
  currentSig: string | null;
  isTreeDirty: boolean;
}

type StandardsGateVerdict = { allowed: true } | { allowed: false; reason: string };

function decideStandardsGate(facts: StandardsGateFacts): StandardsGateVerdict {
  if (!facts.enabled) return { allowed: true };
  if (facts.isTreeDirty) return { allowed: false, reason: "uncommitted changes: only commits land, so commit them and the checks run on what lands" };
  if (!facts.run || facts.currentSig === null || facts.run.sig !== facts.currentSig) {
    return { allowed: false, reason: "checks pending: the required checks have not run on this tree yet" };
  }
  const statusById = new Map(facts.run.checks.map((check) => [check.id, check.status]));
  const failingIds = facts.requiredCheckIds.filter((checkId) => statusById.get(checkId) !== "pass");
  if (failingIds.length === 0) return { allowed: true };
  return { allowed: false, reason: `checks failed: ${failingIds.join(", ")}` };
}

export { decideSignatureDemotion, decideBaseSyncDemotion, decideDiffSelfHeal, decideStandardsGate };
export type { StandardsGateVerdict };
