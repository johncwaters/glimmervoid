import test from "node:test";
import assert from "node:assert/strict";
import { projectSessionCard, projectSessionSnapshots } from "../session/core/snapshot-projection.ts";

function snapshotSource() {
  return {
    id: "s1",
    name: "Session One",
    path: "/repo",
    agent: "claude-code",
    state: "COMPLETE",
    stateSince: 42,
    sleeping: false,
    dangerouslySkipPermissions: false,
    ephemeral: false,
    isWorktree: true,
    isWorkspace: false,
    resumeSessionId: "resume-1",
    activeAgents: 0,
    awaitingBackgroundTasks: false,
    pendingWakeup: null,
    pendingPromptKind: null,
    hasPlan: false,
    mergeStatus: "pending-review",
    mergeReason: null,
    worktreeNotice: null,
    effectiveBase: "main",
    auditLog: [{ from: "RUNNING", to: "COMPLETE", event: "task_complete", timestamp: 41, detail: { source: "hook" } }],
    detection: { hookSeen: true },
    decisions: [{ kind: "signal", decision: "transition" }],
  };
}

test("wire and debug snapshots share state and the recent transitions", () => {
  const { wire, debug } = projectSessionSnapshots(snapshotSource());
  assert.equal(debug.state, wire.state);
  assert.equal(wire.effectiveBase, "main");
  assert.equal(wire.awaitingBackgroundTasks, false);
  assert.deepEqual(debug.transitions, [{
    from: "RUNNING",
    to: "COMPLETE",
    event: "task_complete",
    timestamp: 41,
    detail: { source: "hook" },
  }]);
});

test("debug projection retains only its historical public shape", () => {
  const { debug } = projectSessionSnapshots(snapshotSource());
  assert.deepEqual(Object.keys(debug), ["state", "transitions", "detection", "decisions"]);
});

test("L7 effective base projection preserves producer-normalized branch names", () => {
  const releaseSnapshot = snapshotSource();
  releaseSnapshot.effectiveBase = "release/1.x";
  assert.equal(projectSessionSnapshots(releaseSnapshot).wire.effectiveBase, "release/1.x");
  assert.equal(projectSessionSnapshots(snapshotSource()).wire.effectiveBase, "main");
  const remoteQualifiedSnapshot = snapshotSource();
  remoteQualifiedSnapshot.effectiveBase = "origin/main";
  assert.equal(projectSessionSnapshots(remoteQualifiedSnapshot).wire.effectiveBase, "origin/main");
});

test("workspace sessions are marked on the wire snapshot and the session card", () => {
  const workspaceSnapshot = snapshotSource();
  workspaceSnapshot.isWorkspace = true;
  assert.equal(projectSessionSnapshots(workspaceSnapshot).wire.isWorkspace, true);
  assert.equal(projectSessionSnapshots(snapshotSource()).wire.isWorkspace, false);
  const identity = { id: "s1", name: "Session One" };
  const cardSource = { path: "/ws", state: "COMPLETE" as const, stateSince: 1 };
  assert.equal(projectSessionCard({ ...cardSource, isWorkspace: true }, identity).workspace, true);
  assert.equal("workspace" in projectSessionCard(cardSource, identity), false);
});

test('card and reconnect snapshots carry the effective title and its custom marker', () => {
  const titledSource = { ...snapshotSource(), taskTitle: 'Fix dashboard', taskTitleIsCustom: true };
  const wire = projectSessionSnapshots(titledSource).wire;
  assert.equal(wire.taskTitle, 'Fix dashboard');
  assert.equal(wire.taskTitleIsCustom, true);
  const card = projectSessionCard({ ...titledSource, state: 'COMPLETE' }, { id: 's1', name: 'Session One' });
  assert.equal(card.taskTitle, wire.taskTitle);
  assert.equal(card.taskTitleIsCustom, wire.taskTitleIsCustom);
});
