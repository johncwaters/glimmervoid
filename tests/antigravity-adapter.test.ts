import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import antigravity from '../session/adapters/antigravity.ts';
import type { GeneratedHomeInjection } from '../session/adapters/index.ts';
import { HookRouter } from '../detection/hook-source.ts';
import { Session } from '../session/sessions.ts';
import { promptContextReplyOf, refocusReplyFor, relayedHookContextOutput } from '../session/core/refocus-core.ts';
import { STATES } from '../shared/states.ts';

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
  const prepared = injection.prepareHome(process.env, { listenerPort: 4321, folderTrustRoot: '/work', sessionFolder: '/work/repo', isCleanHome: false, packSkillDirs: ['/packs/acme-1/named/.agents/skills/acme-deploy', '/packs/acme-1/named/.agents/skills/acme-test'] });
  assert.ok(!('refusal' in prepared));
  assert.deepEqual(prepared.args?.slice(2), ['--add-dir', '/packs/acme-1/named']);

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
  assert.deepEqual(sessionSettings.trustedWorkspaces, ['/work/repo', '/packs/acme-1/named']);
  assert.match(sessionSettings.title.command, / AgentState$/);
  assert.equal(prepared.homeEnvValue, 'http://127.0.0.1:4321/mcp');
});

test('an agy spawn from a checkout names the installed glimmervoid relay in the shared plugin, so deleting the checkout cannot break other agy sessions', (t) => {
  const home = withTemporaryHome(t);
  const installedRelay = path.join(home, '.glimmervoid', 'bin', 'glimmervoid-relay');
  fs.mkdirSync(path.dirname(installedRelay), { recursive: true });
  fs.writeFileSync(installedRelay, '', { mode: 0o755 });
  const injection = antigravity.hooks.injection as GeneratedHomeInjection;
  const prepared = injection.prepareHome(process.env, { listenerPort: 4321, folderTrustRoot: '/work', sessionFolder: '/work/repo', isCleanHome: false });
  assert.ok(!('refusal' in prepared));
  const pluginFolder = path.join(home, '.gemini', 'config', 'plugins', 'glimmervoid');
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginFolder, 'hooks.json'), 'utf8')).glimmervoid;
  assert.equal(hooks.Stop[0].command, `${installedRelay} __run hook-relay Stop`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pluginFolder, 'mcp_config.json'), 'utf8')).mcpServers.glimmervoid, { command: installedRelay, args: ['__run', 'mcp-bridge'] });
});

test('a prompt note reaches agy as a PreInvocation injectSteps user message the relay prints', () => {
  assert.equal(antigravity.promptContextReply, 'inject-steps');
  const reply = refocusReplyFor({ accepted: true, event: 'PreInvocation', payload: {}, readContext: () => ({ taskTitle: null }), takePromptSupervision: () => promptContextReplyOf('inject-steps', 'board note') });
  assert.deepEqual(JSON.parse(relayedHookContextOutput('PreInvocation', JSON.stringify(reply)) ?? 'null'), { injectSteps: [{ userMessage: 'board note' }] });
});

test('a killed agy subagent that never fires Stop does not hold the finished turn or escalate it to WAITING', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = new Session({ id: 'agy-killed-subagent', name: 'agy-killed-subagent', path: process.cwd(), agent: 'antigravity', statusConflictMs: 20, statusDedupMs: 10, agentTtlMs: 60_000, gateReleaseSettleMs: 10_000 });
  context.after(() => session.destroy());
  session.state = STATES.IDLE;
  const enrichPayload = antigravity.hooks.createPayloadEnricher?.();
  assert.ok(enrichPayload);
  const router = new HookRouter();
  router.register(session.id, {
    token: 'test-token',
    hooks: antigravity.hooks,
    onSignal: (signal) => session.ingestHookSignal(signal),
  });
  const sendHook = (event: string, payload: Record<string, unknown>) => {
    router.handle({ glimmervoidId: session.id, event, token: 'test-token', payload: enrichPayload(event, payload) });
    context.mock.timers.tick(50);
  };

  sendHook('SessionStart', { conversationId: 'parent-conv' });
  sendHook('PreInvocation', { conversationId: 'parent-conv', invocationNum: 0 });
  sendHook('PreToolUse', { conversationId: 'parent-conv', toolCall: { name: 'invoke_subagent', args: {} } });
  sendHook('PostToolUse', { conversationId: 'parent-conv', toolCall: { name: 'invoke_subagent', args: {} } });
  sendHook('SessionStart', { conversationId: 'subagent-conv' });
  sendHook('Stop', { conversationId: 'parent-conv', fullyIdle: true });
  context.mock.timers.tick(80_000);

  assert.equal(session.state, STATES.COMPLETE);
  sendHook('PostToolUse', { conversationId: 'subagent-conv', toolCall: { name: 'run_command', args: {} } });
  sendHook('Stop', { conversationId: 'subagent-conv', fullyIdle: true });
  assert.equal(session.state, STATES.COMPLETE);
  assert.equal(session.resumeSessionId, 'parent-conv');

  sendHook('PreInvocation', { conversationId: 'parent-conv', invocationNum: 1 });
  sendHook('PreToolUse', { conversationId: 'parent-conv', toolCall: { name: 'invoke_subagent', args: {} } });
  sendHook('PostToolUse', { conversationId: 'parent-conv', toolCall: { name: 'invoke_subagent', args: {} } });
  sendHook('SessionStart', { conversationId: 'subagent-conv-2' });
  sendHook('AgentState', { agent_state: 'idle', subagents: [{ status: 'completed' }] });
  context.mock.timers.tick(80_000);
  assert.equal(session.state, STATES.COMPLETE);
});
