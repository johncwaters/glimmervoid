import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildSessionCardOptions } from '../public/session-card/card-options-core.ts';

test('snapshot and session messages produce identical card options including workspace identity', () => {
  const sharedFields = { saneYolo: true, path: '/repo/checkout', stateSince: 1234, taskTitle: 'Fix the dashboard', taskTitleIsCustom: true };
  const snapshotOptions = buildSessionCardOptions({ ...sharedFields, dangerouslySkipPermissions: true, isWorktree: true, isWorkspace: true });
  const messageOptions = buildSessionCardOptions({ ...sharedFields, skipPerms: true, worktree: true, workspace: true });
  assert.deepEqual(snapshotOptions, messageOptions);
  assert.deepEqual(snapshotOptions, { ...sharedFields, skipPerms: true, worktree: true, workspace: true });
});

test('missing card fields keep the existing defaults and explicit message flags take precedence', () => {
  assert.deepEqual(buildSessionCardOptions({}), { skipPerms: false, saneYolo: false, worktree: false, workspace: false, path: undefined, stateSince: undefined, taskTitle: null, taskTitleIsCustom: false });
  const options = buildSessionCardOptions({ dangerouslySkipPermissions: true, isWorktree: true, isWorkspace: true, skipPerms: false, worktree: false, workspace: false, taskTitle: null });
  assert.equal(options.skipPerms, false);
  assert.equal(options.worktree, false);
  assert.equal(options.workspace, false);
  assert.equal(options.taskTitle, null);
});

test('all five card creation paths use the builder and dormancy carries both identity flags', () => {
  const appSource = fs.readFileSync(new URL('../public/app.ts', import.meta.url), 'utf8');
  const creationLines = appSource.split('\n').filter((line) => /\bcreateSessionCard\(/.test(line));
  assert.equal(creationLines.length, 5);
  for (const line of creationLines) assert.match(line, /buildSessionCardOptions\(/);
  const dormantSource = appSource.slice(appSource.indexOf('if (msg.to === STATES.DORMANT'), appSource.indexOf('  applyState(msg.id, msg.to'));
  assert.match(dormantSource, /worktree: card\?\.dataset\.worktree !== undefined/);
  assert.match(dormantSource, /workspace: card\?\.dataset\.workspace !== undefined/);
  assert.match(dormantSource, /taskTitle: previousUi\?\.taskTitle, taskTitleIsCustom: previousUi\?\.taskTitleIsCustom/);
});
