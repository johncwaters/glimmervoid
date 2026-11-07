type Teardown =
  | { kind: "none" }
  | { kind: "restart-pending"; fresh: boolean; resumePrompt: string | null }
  | { kind: "finish-pending"; awaitsExit: boolean }
  | { kind: "destroyed" };

type TeardownEvent =
  | { kind: "restart_requested"; fresh: boolean; resumePrompt: string | null }
  | { kind: "finish_requested"; isProcessLive: boolean }
  | { kind: "pty_exited" }
  | { kind: "merge_settled" }
  | { kind: "destroy_requested" };

type TeardownAction =
  | { kind: "start-restart"; fresh: boolean; resumePrompt: string | null }
  | { kind: "merge-and-reset" };

interface TeardownDecision {
  teardown: Teardown;
  actions: TeardownAction[];
}

const NO_TEARDOWN: Teardown = { kind: "none" };

function decideFromNone(event: TeardownEvent): TeardownDecision | null {
  switch (event.kind) {
    case "restart_requested":
      return { teardown: { kind: "restart-pending", fresh: event.fresh, resumePrompt: event.resumePrompt }, actions: [] };
    case "finish_requested":
      if (event.isProcessLive) return { teardown: { kind: "finish-pending", awaitsExit: true }, actions: [] };
      return { teardown: { kind: "finish-pending", awaitsExit: false }, actions: [{ kind: "merge-and-reset" }] };
    default:
      return null;
  }
}

function decideTeardown(current: Teardown, event: TeardownEvent): TeardownDecision | null {
  if (current.kind === "destroyed") return null;
  if (event.kind === "destroy_requested") return { teardown: { kind: "destroyed" }, actions: [] };
  if (current.kind === "none") return decideFromNone(event);
  if (current.kind === "restart-pending") {
    if (event.kind !== "pty_exited") return null;
    return { teardown: NO_TEARDOWN, actions: [{ kind: "start-restart", fresh: current.fresh, resumePrompt: current.resumePrompt }] };
  }
  if (event.kind === "merge_settled") return { teardown: NO_TEARDOWN, actions: [] };
  if (event.kind !== "pty_exited" || !current.awaitsExit) return null;
  return { teardown: { kind: "finish-pending", awaitsExit: false }, actions: [{ kind: "merge-and-reset" }] };
}

export { decideTeardown, NO_TEARDOWN };
export type { Teardown, TeardownAction };
