import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import antigravity from '../session/adapters/antigravity.ts';
import type { GeneratedHomeInjection } from '../session/adapters/index.ts';

function withTemporaryHome(t: test.TestContext): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-home-'));
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test('an agy spawn writes the Glimmervoid plugin agy loads hooks from and trusts the session folder for that launch only', (t) => {
  const home = withTemporaryHome(t);
  const injection = antigravity.hooks.injection as GeneratedHomeInjection;
  const prepared = injection.prepareHome(process.env, { listenerPort: 4321, folderTrustRoot: '/work/repo', isCleanHome: false });
  assert.ok(!('refusal' in prepared));

  const pluginFolder = path.join(home, '.gemini', 'config', 'plugins', 'glimmervoid');
  assert.equal(prepared.home, pluginFolder);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pluginFolder, 'plugin.json'), 'utf8')).name, 'glimmervoid');
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginFolder, 'hooks.json'), 'utf8')).glimmervoid;
  assert.match(hooks.Stop[0].command, / Stop$/);
  assert.equal(hooks.PreToolUse[0].matcher, '*');
  assert.match(hooks.PreToolUse[0].hooks[0].command, / PreToolUse$/);
  assert.match(JSON.parse(fs.readFileSync(path.join(pluginFolder, 'mcp_config.json'), 'utf8')).mcpServers.glimmervoid.args.join(' '), /mcp-bridge/);
  assert.equal(fs.existsSync(path.join(home, '.gemini', 'config', 'hooks.json')), false);

  assert.equal(prepared.args?.[0], '--settings');
  const sessionSettings = JSON.parse(prepared.args?.[1] ?? '{}');
  assert.deepEqual(sessionSettings.trustedWorkspaces, ['/work/repo']);
  assert.match(sessionSettings.title.command, / AgentState$/);
  assert.equal(prepared.homeEnvValue, 'http://127.0.0.1:4321/mcp');
});
