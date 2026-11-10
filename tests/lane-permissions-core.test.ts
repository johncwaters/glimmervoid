import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ACCEPT_EDITS_MODE, buildLanePermissions, laneAccess } from '../server/lanes/core/lane-permissions-core.ts';
import { buildHookSettings } from '../detection/settings-injector.ts';
import { LANE_SPAWN_DENY_TOOLS } from '../server/lanes/lane-spawn.ts';

test('the boundary is acceptEdits over the throwaway cwd, and there is no allow list at all', () => {
  const posture = buildLanePermissions({ denyTools: ['Bash'] });
  assert.equal(posture.permissions.defaultMode, ACCEPT_EDITS_MODE);
  assert.deepEqual(posture.permissions.deny, ['Bash']);

  assert.equal(Object.hasOwn(posture.permissions, 'allow'), false);
});

test('the mode is set by the lane, not inherited: an operator running auto has a classifier deciding', () => {
  assert.equal(buildLanePermissions({ denyTools: LANE_SPAWN_DENY_TOOLS }).permissions.defaultMode, 'acceptEdits');
});

test('no lane denies a bare Read, Write, Glob or Grep: a bare Read deny refuses the Write tool', () => {
  for (const tool of ['Read', 'Write', 'Glob', 'Grep']) {
    assert.equal(LANE_SPAWN_DENY_TOOLS.includes(tool), false, `${tool} in ${LANE_SPAWN_DENY_TOOLS.join(',')}`);
  }
});

test('no lane leans on a path deny: probed, it does not refuse a Write tool call', () => {
  for (const rule of LANE_SPAWN_DENY_TOOLS) {
    assert.equal(
      /^(Edit|Write)\(/.test(rule), false,
      `${rule} reads as a write boundary and is not one; the cwd plus acceptEdits is the boundary`
    );
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

test('an allow-list never replaces the deny list, and never becomes a bare Write allow', () => {
  const { permissions, args } = buildLanePermissions({ denyTools: ['Bash'], allowTools: ['Read', 'Write'] });
  assert.deepEqual(permissions.deny, ['Bash']);
  assert.equal(Object.hasOwn(permissions, 'allow'), false);
  assert.equal(permissions.defaultMode, ACCEPT_EDITS_MODE);
  assert.ok(args.includes('--tools'));
});

test('a lane opens GitHub and the web only on Claude Code with a read token and no inherited proxy, and the open lane can reach nothing else', () => {
  const base = { agent: 'claude-code', readToken: 'github_pat_read', extraFetchDomains: ['docs.example.com'], ghConfigDir: '/scratch/gh', inheritedEnv: {} };
  for (const closedInput of [{ ...base, readToken: null }, { ...base, agent: 'codex' }, { ...base, inheritedEnv: { https_proxy: 'http://corp:3128' } }, { ...base, inheritedEnv: { CLAUDE_CODE_USE_BEDROCK: '1' } }]) {
    const closed = laneAccess(closedInput);
    assert.equal(closed.isOpen, false);
    assert.equal(closed.env.GH_TOKEN, '');
    assert.equal(closed.env.HTTPS_PROXY, undefined);
    assert.ok(closed.denyRules.includes('Bash(gh:*)') && closed.denyRules.includes('WebFetch'));
  }
  const open = laneAccess({ ...base, inheritedEnv: { ANTHROPIC_BASE_URL: 'https://gateway.internal:8443/v1' } });
  assert.equal(open.env.GH_TOKEN, 'github_pat_read');
  assert.equal(open.env.GH_CONFIG_DIR, '/scratch/gh');
  assert.equal(open.env.HTTPS_PROXY, 'http://127.0.0.1:9');
  assert.deepEqual(open.env.NO_PROXY.split(',').filter((host) => host.includes('example') || host.includes('gateway')), ['docs.example.com', 'gateway.internal']);
  assert.ok(open.allowRules.includes('WebFetch(domain:docs.example.com)'));
  assert.equal(open.allowRules.some((rule) => rule === 'WebFetch' || rule.startsWith('Bash(curl')), false);
  for (const shellCapableCommand of ['curl', 'gh auth', 'gh alias', 'gh extension', 'gh ext', 'gh config', 'gh copilot', 'gh repo clone', 'gh gist clone', 'gh pr checkout', 'gh co']) {
    assert.ok(open.denyRules.includes(`Bash(${shellCapableCommand}:*)`), shellCapableCommand);
  }
});
