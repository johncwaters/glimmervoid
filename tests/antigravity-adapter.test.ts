import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HookRouter } from '../detection/hook-source.ts';
import antigravity from '../session/adapters/antigravity.ts';
import type { GeneratedHomeInjection } from '../session/adapters/index.ts';
import { renderAntigravityPlugin } from '../session/core/antigravity-plugin-core.ts';
import { promptContextReplyOf, refocusReplyFor, relayedHookContextOutput } from '../session/core/refocus-core.ts';
import { hintFor, toolHookFactsOf } from '../session/core/session-routes.ts';
import { antigravityRecordsFromLine } from '../server/core/conversation/antigravity-core.ts';
import { shouldRefreshHookPrs } from '../server/core/session-pr-link-core.ts';
import { appendChatRecords, createChatPartsState } from '../public/chat/chat-parts-core.ts';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
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
  await postHook('Stop', { conversationId: 'conv-1', fullyIdle: true });
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

test('Antigravity plugin wires Sane YOLO PreToolUse hook and describes its installed hooks', () => {
  const pluginFiles = renderAntigravityPlugin(['node', '/relay.js'], ['node', '/bridge.js'], [], null, ['node', '/tool-relay.js']);
  assert.ok(pluginFiles);
  const parsedHooks = JSON.parse(pluginFiles['hooks.json']) as { glimmervoid: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
  const saneYoloEntry = parsedHooks.glimmervoid.PreToolUse.find((entry) => entry.hooks.some((hook) => hook.command.includes('saneYolo antigravity')));
  assert.ok(saneYoloEntry);
  assert.equal(saneYoloEntry.matcher, '*');
  assert.equal(antigravity.capabilities.saneYolo, true);

  const installed = antigravity.hooks.describeInstalledHooks?.({ detectScheduledWakeups: true, observeToolCalls: true, hookTools: [] });
  assert.ok(installed && 'hooks' in installed);
  assert.ok(installed.hooks.some((hook) => hook.route === 'saneYolo' && hook.event === 'PreToolUse'));
  assert.ok(installed.hooks.some((hook) => hook.event === 'AgentState'));
});

test('Antigravity enriches subagent metadata, transcript path, PR refresh, and command hints', () => {
  const enrich = antigravity.hooks.createPayloadEnricher?.();
  assert.ok(enrich);
  enrich('PreInvocation', { conversationId: 'parent-1', invocationNum: 0, lastUserInput: 'Review diff' });
  enrich('PreToolUse', {
    conversationId: 'parent-1',
    toolCall: { id: 'call-denied', name: 'invoke_subagent', args: { TypeName: 'denied-type', Role: 'Denied' } },
  });
  enrich('PostToolUse', {
    conversationId: 'parent-1',
    toolCall: { id: 'call-denied', name: 'invoke_subagent', args: { TypeName: 'denied-type', Role: 'Denied' } },
    error: 'Permission denied',
  });
  enrich('PreToolUse', {
    conversationId: 'parent-1',
    toolCall: { id: 'call-ok', name: 'invoke_subagent', args: { TypeName: 'qa-code-reviewer', Role: 'Code Review Lane' } },
  });
  const subagentStart = enrich('SessionStart', { conversationId: 'sub-1' });
  assert.equal(subagentStart.agent_id, 'sub-1');
  assert.equal(subagentStart.agent_type, 'qa-code-reviewer');
  assert.deepEqual(subagentStart.tool_input, { subagent_type: 'qa-code-reviewer', description: 'Code Review Lane' });

  const subagentStop = enrich('Stop', { conversationId: 'sub-1', transcriptPath: '/tmp/brain/sub-1/transcript_full.jsonl' });
  assert.equal(subagentStop.agent_id, 'sub-1');
  assert.equal(subagentStop.agent_type, 'qa-code-reviewer');
  assert.equal(subagentStop.agent_transcript_path, '/tmp/brain/sub-1/transcript_full.jsonl');

  const parentCallRecords = antigravityRecordsFromLine(JSON.stringify({
    step_index: 0,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'qa-code-reviewer', Role: 'Code Review Lane' } }],
  }), { vendorSessionId: 'parent-1', now: 1000 });
  const parentResultRecords = antigravityRecordsFromLine(JSON.stringify({
    step_index: 1,
    source: 'TOOL',
    type: 'GENERIC',
    content: 'Created the following subagent:\n{\n  "conversationId": "sub-1"\n}',
  }), { vendorSessionId: 'parent-1', now: 1010 });
  const subagentRecords = antigravityRecordsFromLine(JSON.stringify({
    step_index: 0,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    content: 'Subagent report',
    tool_calls: [{ name: 'run_command', args: { CommandLine: 'git status' } }],
  }), { vendorSessionId: 'parent-1', now: 1500, agentId: 'sub-1', agentType: 'qa-code-reviewer' });
  assert.ok(subagentRecords.every((record) => record.agentId === 'sub-1' && record.agentType === 'qa-code-reviewer' && record.uuid?.startsWith('sub-1:step-')));

  const chatState = createChatPartsState();
  const running = appendChatRecords(chatState, [
    ...parentCallRecords,
    ...parentResultRecords,
    { ts: 1020, uuid: null, parentUuid: null, vendorSessionId: 'parent-1', kind: 'subagent', phase: 'start', subagentId: 'sub-1', subagentType: 'qa-code-reviewer', task: 'Code Review Lane' },
    ...subagentRecords,
  ]);
  assert.deepEqual(running.runningSubagents, [{ type: 'qa-code-reviewer', model: null }]);
  const appended = appendChatRecords(chatState, [
    { ts: 2000, uuid: null, parentUuid: null, vendorSessionId: 'parent-1', kind: 'subagent', phase: 'stop', subagentId: 'sub-1', subagentType: 'qa-code-reviewer', task: null },
  ]);
  assert.deepEqual(appended.runningSubagents, []);
  assert.equal([...running.parts, ...appended.parts].some((part) => part.kind === 'turn'), false);

  const pushPayload = enrich('PostToolUse', {
    conversationId: 'parent-1',
    toolCall: { name: 'run_command', args: { CommandLine: 'git push origin main' } },
  });
  assert.equal(shouldRefreshHookPrs('PostToolUse', pushPayload), true);

  const writePayload = enrich('PostToolUse', {
    conversationId: 'parent-1',
    toolCall: { name: 'write_file', args: { Path: '/tmp/report.html' } },
  });
  const writeFacts = toolHookFactsOf('PostToolUse', writePayload);
  assert.ok(writeFacts);
  const hintGate = { answers: () => true, hintedCommands: new Set<string>(), ranCommands: new Set<string>() };
  assert.equal(hintFor(writeFacts, hintGate)?.command, 'show');

  const subagentToolPayload = enrich('PostToolUse', {
    conversationId: 'parent-1',
    toolCall: { name: 'invoke_subagent', args: { TypeName: 'research', Role: 'Scout' } },
  });
  const subagentFacts = toolHookFactsOf('PostToolUse', subagentToolPayload);
  assert.ok(subagentFacts);
  assert.equal(hintFor(subagentFacts, hintGate)?.command, 'spawn');
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

test('a trailing AgentState working poll after parent Stop does not cancel the COMPLETE transition', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = new Session({ id: 'agy-trailing-working', name: 'agy-trailing-working', path: process.cwd(), agent: 'antigravity', statusConflictMs: 750, statusDedupMs: 10 });
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
  };

  sendHook('SessionStart', { conversationId: 'parent-conv' });
  sendHook('PreInvocation', { conversationId: 'parent-conv', invocationNum: 0 });
  context.mock.timers.tick(100);
  assert.equal(session.state, STATES.RUNNING);

  sendHook('Stop', { conversationId: 'parent-conv', fullyIdle: true });
  context.mock.timers.tick(190);
  sendHook('AgentState', { agent_state: 'working', subagents: [{ status: 'completed' }] });
  context.mock.timers.tick(800);
  assert.equal(session.state, STATES.COMPLETE);

  const signalWithRunningSubagent = antigravity.hooks.mapSignal('AgentState', enrichPayload('AgentState', { agent_state: 'working', subagents: [{ status: 'running' }] }));
  assert.equal(signalWithRunningSubagent, 'working');
});

test('hooks from a nested agy conversation mid-turn never complete the main session or overwrite its resume id', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = new Session({ id: 'agy-nested', name: 'agy-nested', path: process.cwd(), agent: 'antigravity', statusConflictMs: 750, statusDedupMs: 10 });
  context.after(() => session.destroy());
  session.state = STATES.IDLE;
  const enrichPayload = antigravity.hooks.createPayloadEnricher?.();
  assert.ok(enrichPayload);
  const observedConversationIds: string[] = [];
  const router = new HookRouter();
  router.register(session.id, {
    token: 'test-token',
    hooks: antigravity.hooks,
    onSignal: (signal) => session.ingestHookSignal(signal),
    onEvent: (_event, payload) => {
      if (typeof payload.conversationId === 'string') observedConversationIds.push(payload.conversationId);
    },
  });
  const sendHook = (event: string, payload: Record<string, unknown>) =>
    router.handle({ glimmervoidId: session.id, event, token: 'test-token', payload: enrichPayload(event, payload) });

  sendHook('SessionStart', { conversationId: 'parent-conv' });
  sendHook('PreInvocation', { conversationId: 'parent-conv', invocationNum: 0 });
  sendHook('AgentState', { conversation_id: 'parent-conv', agent_state: 'working' });
  context.mock.timers.tick(100);
  assert.equal(session.state, STATES.RUNNING);

  const nestedStart = sendHook('SessionStart', { conversationId: 'nested-conv' });
  const nestedPre = sendHook('PreInvocation', { conversationId: 'nested-conv', invocationNum: 0 });
  const nestedStop = sendHook('Stop', { conversationId: 'nested-conv', fullyIdle: true });
  context.mock.timers.tick(1000);

  assert.equal(nestedStart.reason, 'foreign-conversation');
  assert.equal(nestedPre.reason, 'foreign-conversation');
  assert.equal(nestedStop.reason, 'foreign-conversation');
  assert.equal(session.state, STATES.RUNNING);
  assert.equal(session.resumeSessionId, 'parent-conv');
  assert.equal(observedConversationIds.includes('nested-conv'), false);

  sendHook('Stop', { conversationId: 'parent-conv', fullyIdle: true });
  context.mock.timers.tick(1000);
  assert.equal(session.state, STATES.COMPLETE);
});
