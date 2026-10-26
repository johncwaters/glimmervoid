type ExitClose = "remove" | "confirm" | "keep";

interface ExitCloseFacts {
  exitedOnItsOwn: boolean;
  isConfiguredSession: boolean;
  mergeStatus: string;
  isWorkspace: boolean;
  hasRemoteEnvironment: boolean;
}

const UNMERGED_MERGE_STATUSES: ReadonlySet<string> = new Set(["pending-review", "parked"]);

function decideExitClose(facts: ExitCloseFacts): ExitClose {
  if (!facts.exitedOnItsOwn || !facts.isConfiguredSession) return "keep";
  if (facts.isWorkspace || facts.hasRemoteEnvironment) return "confirm";
  if (UNMERGED_MERGE_STATUSES.has(facts.mergeStatus)) return "confirm";
  return "remove";
}

export { decideExitClose };
