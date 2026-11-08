import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildHookSettings,
  writeSessionSettings,
} from '../detection/settings-injector.ts';
import { getAdapter, listAgentIds } from '../session/adapters/index.ts';
import { agentHookGroupOf } from '../session/core/user-hooks-core.ts';

function tempBase() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-hook-modes-')), 'glimmervoid-hooks');
}

test('the written settings still contain the hooks the session needs', () => {
  const baseDir = tempBase();
  const written = writeSessionSettings({ glimmervoidId: 'sess-5', port: 3000, baseDir });
  try {
    const parsed = JSON.parse(fs.readFileSync(written.settingsPath, 'utf8'));
    assert.equal(typeof parsed.hooks.Stop[0].hooks[0].url, 'string');
    assert.match(parsed.hooks.Stop[0].hooks[0].url, new RegExp(`t=${written.token}$`));
  } finally {
    written.cleanup();
  }
});

test('allow rules are written beside deny rules and the mode, and no permissions key appears without any', () => {
  const base = { port: 3000, glimmervoidId: 'allowed', token: 'tok' };
  const permissions = { allow: ['Bash(codex exec *)', 'Edit(//tmp/codex-dispatch-*.txt)'], deny: ['WebFetch'], defaultMode: 'acceptEdits' };
  assert.deepEqual(buildHookSettings({ ...base, permissions }).permissions, permissions);
  assert.deepEqual(buildHookSettings({ ...base, permissions: { allow: ['Read(//tmp/x.out)'] } }).permissions, { allow: ['Read(//tmp/x.out)'] });
  assert.equal('permissions' in buildHookSettings({ ...base, permissions: { allow: [] } }), false);
});

test('a clean home carries the operator deny and ask rules, sandbox, env and key helper but none of their hooks, plugins or allow rules', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-guardrails-'));
  const userSettingsPath = path.join(directory, 'settings.json');
  fs.writeFileSync(userSettingsPath, JSON.stringify({
    permissions: { allow: ['Bash(*)'], deny: ['Read(~/.ssh/**)'], ask: ['Bash(git push:*)'] },
    sandbox: { enabled: true }, env: { HTTPS_PROXY: 'http://proxy.example:3128' }, apiKeyHelper: '/usr/local/bin/key-helper',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'operator-hook' }] }] }, enabledPlugins: { 'mine@market': true },
  }));
  try {
    const base = { port: 3000, glimmervoidId: 'clean', token: 'tok', userSettingsPath, permissions: { deny: ['WebFetch'] } };
    const clean = buildHookSettings({ ...base, carryOperatorGuardrails: true });
    assert.deepEqual(clean.permissions, { deny: ['WebFetch', 'Read(~/.ssh/**)'], ask: ['Bash(git push:*)'] });
    assert.deepEqual(clean.sandbox, { enabled: true });
    assert.deepEqual(clean.env, { HTTPS_PROXY: 'http://proxy.example:3128' });
    assert.equal(clean.apiKeyHelper, '/usr/local/bin/key-helper');
    assert.equal(JSON.stringify(clean).includes('operator-hook'), false);
    assert.equal('enabledPlugins' in clean, false);
    const operator = buildHookSettings(base);
    assert.deepEqual(operator.permissions, { deny: ['WebFetch'] });
    assert.equal('sandbox' in operator, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('every hook an agent installs is described with a purpose in the Hooks tab', () => {
  const everyFlagOn = { detectScheduledWakeups: true, observeToolCalls: true, planReview: true, hookTools: [{ id: 'saneYolo' as const, binPath: 'C:\\Users\\operator\\node_modules\\.bin\\cc-safety-net', launch: ['node', 'C:\\Users\\operator\\node_modules\\.bin\\cc-safety-net'] }] };
  const groups = listAgentIds().flatMap((agentId) => {
    const adapter = getAdapter(agentId);
    const describeInstalledHooks = adapter?.hooks?.describeInstalledHooks;
    if (!adapter || !describeInstalledHooks) return [];
    return [agentHookGroupOf(adapter.id, adapter.label, describeInstalledHooks(everyFlagOn))];
  });
  const claudeGroup = groups.find((group) => group.agentId === 'claude-code');
  assert.ok(claudeGroup && claudeGroup.rows.length > 0, 'Claude Code reports the hooks its settings file installs');
  assert.ok(claudeGroup.rows.some((row) => row.purpose === 'Sane YOLO catastrophic command protection'), 'a Windows hook-tool path still resolves to its own purpose');
  const undescribed = groups.flatMap((group) => group.rows.filter((row) => row.purpose === 'No description').map((row) => `${group.agentId} ${row.event} ${row.matcher ?? ''}`));
  assert.deepEqual(undescribed, []);
});
