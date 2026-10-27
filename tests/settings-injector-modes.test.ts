import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildHookSettings,
  writeSessionSettings,
} from '../detection/settings-injector.ts';

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

test('a guardrails block is written verbatim as the top-level Claude Code sandbox key and is absent when none is given', () => {
  const base = { port: 3000, glimmervoidId: 'guarded', token: 'tok' };
  const guardrails = { enabled: true, network: { strictAllowlist: true, allowedDomains: ['api.openai.com'] } };
  const settings = buildHookSettings({ ...base, guardrails, permissions: { deny: ['WebFetch'] } });
  assert.deepEqual(settings.sandbox, guardrails);
  assert.deepEqual(settings.permissions, { deny: ['WebFetch'] });
  assert.ok(settings.hooks.Stop, 'the hooks stay in the same file');
  assert.equal('sandbox' in buildHookSettings(base), false);
  assert.equal('sandbox' in buildHookSettings({ ...base, guardrails: null }), false);
});

test('allow rules are written beside deny rules and the mode, and no permissions key appears without any', () => {
  const base = { port: 3000, glimmervoidId: 'allowed', token: 'tok' };
  const permissions = { allow: ['Bash(codex exec *)', 'Edit(//tmp/codex-dispatch-*.txt)'], deny: ['WebFetch'], defaultMode: 'acceptEdits' };
  assert.deepEqual(buildHookSettings({ ...base, permissions }).permissions, permissions);
  assert.deepEqual(buildHookSettings({ ...base, permissions: { allow: ['Read(//tmp/x.out)'] } }).permissions, { allow: ['Read(//tmp/x.out)'] });
  assert.equal('permissions' in buildHookSettings({ ...base, permissions: { allow: [] } }), false);
});
