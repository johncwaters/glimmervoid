import type { PushRefResult, PushResult } from "./git.ts";

export type PendingPushRef = { branch: string; kind: "feature" | "promote"; sourceTip?: string; destination?: string };

export function sleep(milliseconds: number): void {
  if (milliseconds <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function branchRefspec(branch: string, sourceTip?: string, destination = `refs/heads/${branch}`): string {
  return `${sourceTip ?? `refs/heads/${branch}`}:${destination}`;
}

function pushRefResult(push: PushResult, destination: string): PushRefResult | undefined {
  return push.refs[destination] ?? push.refs[destination.replace(/^refs\/heads\//, "")];
}

export function statusByBranch(
  push: PushResult,
  pendingRefs: PendingPushRef[],
): Record<string, PushRefResult> {
  const statuses: Record<string, PushRefResult> = {};
  for (const pendingRef of pendingRefs) {
    const parsed = pushRefResult(push, pendingRef.destination ?? `refs/heads/${pendingRef.branch}`);
    if (parsed) {
      statuses[pendingRef.branch] = parsed;
      continue;
    }
    statuses[pendingRef.branch] = {
      status: push.code === 0 ? "ok" : "unknown",
      summary: "",
    };
  }
  return statuses;
}

function isCauseFailure(entry: PushRefResult | undefined): boolean {
  return entry?.status === "rejected" || entry?.status === "error";
}

export function allRefsPushed(statuses: Record<string, PushRefResult>): boolean {
  return Object.values(statuses).every(
    (entry) => entry.status === "ok" || entry.status === "up_to_date",
  );
}

export function hasCauseFailure(statuses: Record<string, PushRefResult>): boolean {
  return Object.values(statuses).some((entry) => isCauseFailure(entry));
}

export function pushFailureText(push: PushResult, branch: string, destination = `refs/heads/${branch}`): string {
  const parsed = pushRefResult(push, destination);
  const stderr = push.stderr.trim();
  if (parsed?.summary && stderr) {
    return `${parsed.summary}: ${stderr}`;
  }
  if (parsed?.summary) {
    return parsed.summary;
  }
  if (stderr) {
    return stderr;
  }
  return push.stdout.trim();
}

const REFUSAL_OUTPUT_TAIL_LINES = 40;

export function isRefusedBeforeTransfer(push: PushResult): boolean {
  const gitReportedTransfer = push.stdout.split("\n").some((line) => line.startsWith("To "));
  const lastStderrLine = push.stderr.trim().split("\n").pop() ?? "";
  return push.code === 1 && !gitReportedTransfer && lastStderrLine.startsWith("error: failed to push some refs");
}

export function refusalOutputText(push: PushResult): string {
  const combinedOutput = [push.stdout.trim(), push.stderr.trim()].filter(Boolean).join("\n");
  return combinedOutput.split("\n").slice(-REFUSAL_OUTPUT_TAIL_LINES).join("\n");
}
