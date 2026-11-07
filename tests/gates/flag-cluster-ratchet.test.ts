import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

const SCANNED_SOURCE = /^(?:server|session|detection|notifications|mcp|cloud|public|shared)\/(?!.*\.test\.ts$).*\.ts$/;
const NEW_FILE_FLAG_LIMIT = 3;
const BOOLEAN_FLAG_DECLARATION = /(?:\blet\s+|,\s*)[A-Za-z_$][\w$]*\s*(?::\s*boolean\s*)?=\s*(?:true|false)\b/g;
const BOOLEAN_FIELD_WRITE = /\.(?!(?:hidden|disabled|checked|spellcheck|draggable|open|readOnly|indeterminate|inert|multiple|required|selected|autofocus|defaultChecked)\b)\w+\s*=\s*(?:true|false)\b(?!\s*[=!&|?.])/g;

const RECORDED_FLAG_COUNTS = new Map<string, number>([
  ['detection/osc-title-source.ts', 7],
  ['detection/settings-injector.ts', 6],
  ['notifications/telegram-outbox.ts', 3],
  ['public/boot/connection-screen.ts', 3],
  ['public/control-ws.ts', 3],
  ['public/dialogs.ts', 8],
  ['public/doc-editor/doc-editor-ui.ts', 4],
  ['public/flying-animals.ts', 3],
  ['public/github/team-review-detail-views.ts', 3],
  ['public/plan/plan-face.ts', 9],
  ['public/render-scheduler.ts', 8],
  ['public/session-card/card-debug.ts', 3],
  ['public/session-card/terminal-data-socket.ts', 5],
  ['public/session-card/terminal-secret-mask.ts', 4],
  ['public/session-card/terminal-setup.ts', 3],
  ['public/session-card/webgl-pool.ts', 9],
  ['public/settings/settings-panel.ts', 4],
  ['public/settings/settings-view-core.ts', 3],
  ['public/trace-panel.ts', 3],
  ['public/trace-store.ts', 3],
  ['public/usage/usage-store.ts', 3],
  ['public/whiteboard/board-edit.ts', 4],
  ['public/whiteboard/boards-view.ts', 5],
  ['server/agent-api/child-channels.ts', 3],
  ['server/backend/backend-health.ts', 3],
  ['server/branch-gc-poller.ts', 3],
  ['server/coder/coder-env-wiring.ts', 4],
  ['server/coherence/coherence-session-feed.ts', 4],
  ['server/core/transcript-tail-core.ts', 3],
  ['server/git/core/git-invocation-core.ts', 8],
  ['server/git/git-exec.ts', 3],
  ['server/git/git-workspace.ts', 3],
  ['server/git/workspace/rebase-ops.ts', 3],
  ['server/github/github-store-poller.ts', 4],
  ['server/github/issues-wiring.ts', 3],
  ['server/github/my-prs-poller.ts', 4],
  ['server/github/pr-gh.ts', 4],
  ['server/github/team-review-poller.ts', 3],
  ['server/github/team-review-poller/team-review-runs.ts', 5],
  ['server/json-file.ts', 12],
  ['server/lanes/lane-runner.ts', 4],
  ['server/plan-review-wiring.ts', 5],
  ['server/radar/radar-poller.ts', 3],
  ['server/server-lifecycle.ts', 5],
  ['server/spawn-gate.ts', 4],
  ['server/trace-wiring.ts', 3],
  ['server/trace/trace-transcript-drain.ts', 6],
  ['server/update-apply.ts', 7],
  ['server/usage/usage-scanner.ts', 6],
  ['server/usage/usage-wiring.ts', 5],
  ['server/ws-sender.ts', 4],
  ['session/adapters/codex.ts', 5],
  ['session/codex-app-server-bridge.ts', 3],
  ['session/core/agent-home-core.ts', 4],
  ['session/screen-keeper.ts', 4],
  ['session/session-output.ts', 3],
  ['session/session-recorder.ts', 12],
  ['session/session-worktree-lifecycle.ts', 11],
  ['session/sessions.ts', 41],
  ['session/worktree/worktree-provisioning.ts', 4],
]);


function booleanFlagCountOf(repoPath: string): number {
  const sourceText = readTracked(repoPath);
  return (sourceText.match(BOOLEAN_FLAG_DECLARATION) ?? []).length + (sourceText.match(BOOLEAN_FIELD_WRITE) ?? []).length;
}

test('no file grows a boolean flag cluster past its recorded count', () => {
  const sourceFiles = trackedFiles(SCANNED_SOURCE);
  assert.ok(sourceFiles.length > 500, `expected to scan the source tree, only found ${sourceFiles.length} files`);
  const failures: string[] = [];
  for (const repoPath of sourceFiles) {
    const flagCount = booleanFlagCountOf(repoPath);
    const recordedCount = RECORDED_FLAG_COUNTS.get(repoPath);
    if (recordedCount === undefined && flagCount >= NEW_FILE_FLAG_LIMIT) failures.push(`${repoPath} has ${flagCount} boolean flags: fold the lifecycle they track into one state field driven by a table or reducer`);
    if (recordedCount !== undefined && flagCount > recordedCount) failures.push(`${repoPath} has ${flagCount} boolean flags, ${recordedCount} recorded: fold the new ones into an existing state field`);
    if (recordedCount !== undefined && flagCount < recordedCount) failures.push(`${repoPath} now has ${flagCount} boolean flags: lower its recorded count from ${recordedCount}`);
  }
  for (const recordedPath of RECORDED_FLAG_COUNTS.keys()) {
    if (!sourceFiles.includes(recordedPath)) failures.push(`${recordedPath} is gone: delete its recorded count`);
  }
  assert.deepEqual(failures, []);
});
