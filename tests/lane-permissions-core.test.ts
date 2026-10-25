import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ACCEPT_EDITS_MODE, buildLanePermissions } from '../server/lanes/core/lane-permissions-core.ts';
import { buildHookSettings } from '../detection/settings-injector.ts';
import { LANE_SPAWN_DENY_TOOLS } from '../server/lanes/lane-spawn.ts';
import { VISIONS_DENY_TOOLS, makeVisionsWorkDir } from '../server/visions/visions-dispatch.ts';

test('the boundary is acceptEdits over the throwaway cwd, and there is no allow list at all', () => {
  const posture = buildLanePermissions({ denyTools: ['Bash'] });
  assert.equal(posture.permissions.defaultMode, ACCEPT_EDITS_MODE);
  assert.deepEqual(posture.permissions.deny, ['Bash']);

  assert.equal(Object.hasOwn(posture.permissions, 'allow'), false);
});

test('the mode is set by the lane, not inherited: an operator running auto has a classifier deciding', () => {
  for (const denyTools of [LANE_SPAWN_DENY_TOOLS, VISIONS_DENY_TOOLS]) {
    assert.equal(buildLanePermissions({ denyTools }).permissions.defaultMode, 'acceptEdits');
  }
});

test('no lane denies a bare Read, Write, Glob or Grep: a bare Read deny refuses the Write tool', () => {
  for (const denyTools of [LANE_SPAWN_DENY_TOOLS, VISIONS_DENY_TOOLS]) {
    for (const tool of ['Read', 'Write', 'Glob', 'Grep']) {
      assert.equal(denyTools.includes(tool), false, `${tool} in ${denyTools.join(',')}`);
    }
  }
});

test('no lane leans on a path deny: probed, it does not refuse a Write tool call', () => {
  for (const denyTools of [LANE_SPAWN_DENY_TOOLS, VISIONS_DENY_TOOLS]) {
    for (const rule of denyTools) {
      assert.equal(
        /^(Edit|Write)\(/.test(rule), false,
        `${rule} reads as a write boundary and is not one; the cwd plus acceptEdits is the boundary`
      );
    }
  }
});

test('the managed settings file carries the mode, or the boundary never reaches the session', () => {
  const posture = buildLanePermissions({ denyTools: ['Bash'] });
  const settings = buildHookSettings({
    port: 3000, glimmervoidId: 'sess-1', token: 't', permissions: posture.permissions,
  });
  assert.deepEqual(settings.permissions, { deny: ['Bash'], defaultMode: 'acceptEdits' });
});

test('a lane passing neither deny nor mode leaves an ordinary session byte-identical', () => {
  const bare = buildHookSettings({ port: 3000, glimmervoidId: 'sess-1', token: 't' });
  assert.equal(Object.hasOwn(bare, 'permissions'), false);
  const denyOnly = buildHookSettings({
    port: 3000, glimmervoidId: 'sess-1', token: 't', permissions: { deny: ['Bash(gh:*)'] },
  });
  assert.deepEqual(denyOnly.permissions, { deny: ['Bash(gh:*)'] }, 'the deny-only lanes are unchanged');
});

test('a lane on this seam is told what NOT to load, since a settings file cannot say it', () => {
  const { args } = buildLanePermissions();
  assert.deepEqual(args, ['--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project,local']);
  assert.ok(args.includes('--strict-mcp-config'), 'no --mcp-config beside it means zero MCP servers, so no lane can reach Gmail or Slack');
  assert.equal(args.includes('user'), false, "the operator's own hooks and output style are not this lane's");
});

test('--tools is never the last token, since only a following option ends the variadic flag', () => {
  const { args } = buildLanePermissions({ allowTools: ['Read', 'Write'] });
  assert.deepEqual(args.slice(0, 2), ['--tools', 'Read,Write'], 'emitted ahead of the environment flags, which always follow it');
  assert.notEqual(args.at(-1), 'Read,Write', 'a trailing --tools value eats the positional prompt: "Input must be provided"');
  assert.ok(args.at(-2)?.startsWith('--'), 'whatever ends the argv, the variadic is already bounded by an option');

  assert.equal(args.filter((arg) => arg === 'Read' || arg === 'Write').length, 0);
});

test('the visions dispatch work dir is an empty directory under the system temp dir', async () => {
  const workDir = await makeVisionsWorkDir();
  try {
    const realTmp = fs.realpathSync(os.tmpdir());
    assert.equal(
      fs.realpathSync(workDir).startsWith(realTmp + path.sep), true,
      'a lane must cwd into a temp dir, or --setting-sources project,local loads a real repo\'s settings and hooks',
    );
    assert.deepEqual(fs.readdirSync(workDir), [], 'a lane must cwd into an EMPTY dir it owns');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('an allow-list never replaces the deny list, and never becomes a bare Write allow', () => {
  const { permissions, args } = buildLanePermissions({ denyTools: ['Bash'], allowTools: ['Read', 'Write'] });
  assert.deepEqual(permissions.deny, ['Bash']);
  assert.equal(Object.hasOwn(permissions, 'allow'), false);
  assert.equal(permissions.defaultMode, ACCEPT_EDITS_MODE);
  assert.ok(args.includes('--tools'));
});
