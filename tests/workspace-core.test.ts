import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planWorkspace, renderWorkspaceAgentsMd, WORKSPACE_CLAUDE_MD } from '../session/core/workspace-core.ts';

const input = {
  worktreeRoot: path.resolve('/worktrees'),
  sessionName: 'Wizard Workbench',
  sessionId: '12345678-aaaa-bbbb-cccc-dddddddddddd',
  repoPaths: [path.resolve('/repos/wizard'), path.resolve('/repos/context-mill')],
};

test('workspace planning rejects too few repositories and duplicate paths or names', () => {
  assert.equal(planWorkspace({ ...input, repoPaths: [input.repoPaths[0]] }).ok, false);
  assert.deepEqual(planWorkspace({ ...input, repoPaths: [input.repoPaths[0], input.repoPaths[0]] }), {
    ok: false, error: `Duplicate repository path: ${input.repoPaths[0]}`,
  });
  const duplicateName = planWorkspace({ ...input, repoPaths: [input.repoPaths[0], path.resolve('/other/wizard')] });
  assert.deepEqual(duplicateName, { ok: false, error: 'Duplicate repository directory name: wizard' });
});

test('workspace planning uses stable folder and branch names', () => {
  const planned = planWorkspace(input);
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal(planned.plan.folder, path.join(input.worktreeRoot, 'ws-Wizard-Workbench-12345678'));
  assert.equal(planned.plan.branch, `glimmervoid/workspace/${input.sessionId}`);
  assert.deepEqual(planned.plan.members.map((member) => member.dir), [
    path.join(planned.plan.folder, 'wizard'), path.join(planned.plan.folder, 'context-mill'),
  ]);
});

test('workspace map names members, bases and ownership without guessing an unknown base', () => {
  const planned = planWorkspace(input);
  if (!planned.ok) throw new Error(planned.error);
  const members = planned.plan.members.map((member, index) => ({ ...member, base: index === 0 ? 'main' : null }));
  const map = renderWorkspaceAgentsMd({ sessionName: input.sessionName, branch: planned.plan.branch, members });
  assert.match(map, /wizard\/: .* \(base main\)/);
  assert.match(map, /context-mill\/: .*\n/);
  assert.doesNotMatch(map, /context-mill\/: .*base/);
  assert.match(map, /Read wizard\/AGENTS.md or wizard\/CLAUDE.md before editing there/);
  assert.match(map, /You own commits, pushes and pull requests/);
  assert.equal(WORKSPACE_CLAUDE_MD, '@AGENTS.md\n');
});
