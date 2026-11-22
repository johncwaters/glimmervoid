import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HookRouter } from '../detection/hook-source.ts';
import antigravity from '../session/adapters/antigravity.ts';
import type { GeneratedHomeInjection } from '../session/adapters/index.ts';
import { promptContextReplyOf, refocusReplyFor, relayedHookContextOutput } from '../session/core/refocus-core.ts';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';

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

test('an agy session records each new operator prompt once for auto-naming and skips wakeups and injected steps', async (testContext) => {
  withTemporaryHome(testContext);
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-prompts-'));
  const hookRouter = new HookRouter();
  const session = new Session({
    id: 'agy-prompts', name: 'glimmervoid', path: projectPath, agent: 'antigravity',
    hookRouter, getHookPort: () => 4321,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => fakePty(),
  });
  testContext.after(() => {
    session.destroy();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });
  const taskPrompts: string[] = [];
  session.on('task-prompt', ({ prompt }: { prompt: string }) => { taskPrompts.push(prompt); });
  await session.start();
  const token = session._hooks.token();
  assert.ok(token);
  async function postHook(event: string, payload: Record<string, unknown>): Promise<void> {
    const enriched = await hookRouter.enrich({ glimmervoidId: session.id, event, token, payload });
    assert.equal(hookRouter.handle({ glimmervoidId: session.id, event, token, payload: enriched }).status, 200);
  }
  await postHook('SessionStart', { conversationId: 'conv-1', lastUserInput: 'Fix the failing login flow' });
  await postHook('PreInvocation', { conversationId: 'conv-1', invocationNum: 0, lastUserInput: 'Fix the failing login flow' });
  await postHook('PreInvocation', { conversationId: 'conv-1', invocationNum: 1, lastUserInput: 'Glimmervoid supervises this session.' });
  await postHook('PreInvocation', { conversationId: 'conv-1', invocationNum: 0, lastUserInput: 'Glimmervoid supervises this session.' });
  await postHook('PreInvocation', { conversationId: 'conv-1', invocationNum: 0, lastUserInput: 'Fix the failing login flow' });
  await postHook('PreInvocation', { conversationId: 'conv-1', invocationNum: 0, lastUserInput: 'Add regression coverage for logout' });
  await postHook('PostInvocation', { conversationId: 'conv-1', invocationNum: 0, lastUserInput: 'Board "Lanternfish" changed since your last read.' });
  await postHook('PreInvocation', { conversationId: 'conv-1', invocationNum: 0, lastUserInput: 'Board "Lanternfish" changed since your last read.' });
  await postHook('SessionStart', { conversationId: 'conv-2', lastUserInput: 'Fix the failing login flow' });
  await postHook('PreInvocation', { conversationId: 'conv-2', invocationNum: 0, lastUserInput: 'Fix the failing login flow' });

  assert.equal(session.taskTitle, 'Fix the failing login flow');
  assert.deepEqual(taskPrompts, [
    'Fix the failing login flow',
    'Add regression coverage for logout',
    'Fix the failing login flow',
  ]);
});

test('AgentState idle stays working while background tasks or subagents run and drops subagents from enriched payloads', () => {
  const enrich = antigravity.hooks.createPayloadEnricher?.();
  assert.ok(enrich);
  enrich('PreInvocation', { conversationId: 'conv-bg', invocationNum: 0, lastUserInput: 'Run tests in background' });

  const withBackgroundTask = enrich('AgentState', { agent_state: 'idle', task_count: 1 });
  assert.equal(antigravity.mapHookToSignal('AgentState', withBackgroundTask), 'working');
  assert.equal(withBackgroundTask.isTurnOpen, true);

  const withRunningSubagent = enrich('AgentState', {
    agent_state: 'idle',
    task_count: 0,
    subagents: [{ name: 'reviewer', role: 'x'.repeat(2048), status: 'running' }],
  });
  assert.equal('subagents' in withRunningSubagent, false);
  assert.equal(withRunningSubagent.hasRunningSubagent, true);
  assert.equal(antigravity.mapHookToSignal('AgentState', withRunningSubagent), 'working');

  const replayedSubagentRunning = enrich('AgentState', { agent_state: 'idle', task_count: 0, hasRunningSubagent: true });
  assert.equal(replayedSubagentRunning.hasRunningSubagent, true);
  assert.equal(replayedSubagentRunning.isTurnOpen, true);
  assert.equal(antigravity.mapHookToSignal('AgentState', replayedSubagentRunning), 'working');

  const settledIdle = enrich('AgentState', {
    agent_state: 'idle',
    task_count: 0,
    subagents: [{ name: 'reviewer', role: 'done', status: 'completed' }],
  });
  assert.equal('subagents' in settledIdle, false);
  assert.equal(settledIdle.hasRunningSubagent, false);
  assert.equal(antigravity.mapHookToSignal('AgentState', settledIdle), 'ready');

  const idleAfterClose = enrich('AgentState', { agent_state: 'idle' });
  assert.equal(antigravity.mapHookToSignal('AgentState', idleAfterClose), null);
});
