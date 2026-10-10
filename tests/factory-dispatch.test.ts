import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createBackendHttpApp } from '../server/backend-http.ts';
import { execFileAsync } from '../server/child-process-safe.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../server/config-store.ts';
import { buildCoherenceShims, buildCoherenceUserHooks } from '../server/core/coherence-session-core.ts';
import type { FactoryCloseOutWorker } from '../server/factory-closeout.ts';
import { createFactoryDispatch } from '../server/factory-dispatch.ts';
import { factoryWrittenRecordId } from '../server/core/factory-core.ts';
import { LANE_ENVIRONMENT_ARGS } from '../server/core/lane-permissions-core.ts';
import { commitAndLandFactoryLedger } from '../server/factory-ledger.ts';
import { createGitWorkspace } from '../server/git-workspace.ts';
import { cliPath, resolvePackageBin } from '../server/runtime-paths.ts';
import { createSessionFactory } from '../server/session-factory.ts';
import type { SessionSpawnOverrides } from '../server/session-factory.ts';
import { HookRouter } from '../detection/hook-source.ts';
import { Session } from '../session/sessions.ts';
import { CoherenceOrient, CoherenceWorkInspect } from '../shared/contracts/coherence.ts';
import { buildFactoryProjectState } from '../server/core/factory-core.ts';
import type { FactoryWorkerEvent } from '../shared/contracts/factory.ts';
import { AGENT_URL_ENV } from '../shared/contracts/session.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

async function createFixture(context: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-dispatch-'));
  const projectPath = path.join(directory, 'repo');
  await mkdir(projectPath);
  const git = async (args: string[], cwd = projectPath) => (await execFileAsync('git', args, { cwd, timeout: 20_000 })).stdout.trim();
  await git(['init', '--bare', '--initial-branch=integration', path.join(directory, 'origin.git')]);
  await git(['init', '--initial-branch=integration']);
  await git(['config', 'user.email', 'factory@example.test']);
  await git(['config', 'user.name', 'Factory']);
  await git(['config', 'commit.gpgsign', 'false']);
  await mkdir(path.join(projectPath, 'src'));
  await writeFile(path.join(projectPath, 'src', 'retry.ts'), 'export const retries = 0;\n');
  await writeFile(path.join(projectPath, 'coherence.config.json'), '{}\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'test: initialize']);
  await git(['remote', 'add', 'origin', path.join(directory, 'origin.git')]);
  await git(['push', '-u', 'origin', 'integration']);
  const coherenceCli = resolvePackageBin('@danilocampos/coherence', 'coherence');
  const hookCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence-hook');
  assert.ok(coherenceCli);
  assert.ok(hookCliPath);
  const gitWorkspace = createGitWorkspace();
  const ledger = await gitWorkspace.create({ projectPath, teamId: 'repo', label: 'factory-ledger', baseBranch: 'integration',
    configuredIntegrationBranch: 'integration', worktreeBase: directory, shareList: [] });
  assert.ok(ledger.isGit);
  const commands: string[][] = [];
  const writtenRecordIds = new Set<string>();
  const runCoherence = async ({ cwd, args }: { cwd: string; args: string[] }) => {
    commands.push(args);
    const isFactoryWrite = args[args.indexOf('--session') + 1] === 'glimmervoid-factory';
    const writeArgs = isFactoryWrite && args[0] !== 'defect' && !args.includes('--json') ? [...args, '--json'] : args;
    const output = (await execFileAsync(process.execPath, [coherenceCli, ...writeArgs], { cwd, timeout: 20_000 })).stdout;
    const recordId = isFactoryWrite ? factoryWrittenRecordId(output) : null;
    if (recordId) writtenRecordIds.add(recordId);
    return output;
  };
  let orderSequence = 0;
  const createOrder = async (parent: string | null, scope = 'src/retry.ts') => {
    orderSequence += 1;
    const created: { work: string } = JSON.parse(await runCoherence({ cwd: ledger.cwd, args: [
      'work', 'create', `Ship retries ${orderSequence}`, '--success', 'Retries pass', '--risk', 'medium',
      '--authority', parent ? 'orchestrator-delegated' : 'user-directed', '--granted-by', 'operator',
      '--boundary', 'This repo', '--session', 'glimmervoid-factory', '--write-scope', scope,
      ...(parent ? ['--parent', parent] : []), '--json',
    ] }));
    return created.work;
  };
  const intentId = await createOrder(null, 'src');
  const workId = await createOrder(intentId);
  const land = async (_projectId: string, _projectPath: string, message: string) => {
    await commitAndLandFactoryLedger({ projectPath, ledger, targetBranch: 'integration', message, gitWorkspace, trusted: true, writtenRecordIds });
  };
  await land('repo', projectPath, 'factory: create orders');
  const config: GlimmervoidConfig = { projects: [{ id: 'repo', name: 'Factory', path: projectPath }], integrationBranch: 'integration',
    worktreeRoot: path.join(directory, 'workers'), worktreeShare: [], recordSignals: false, liveWorktreeReview: false,
    factory: { enabled: true, dailyBudgetUsd: 10 }, agentApi: { enabled: false }, usage: { budget: { dailyUsd: 10 } } };
  const sessions = new Map<string, Session>();
  const spawned: { project: ProjectEntry; overrides: SessionSpawnOverrides; session: Session }[] = [];
  const events: FactoryWorkerEvent[] = [];
  const turnEnds: FactoryCloseOutWorker[] = [];
  const readyIntents: string[] = [];
  const broadcasts: Record<string, unknown>[] = [];
  const laneRecords: string[] = [];
  const exceptions = new Map<string, string>();
  const spawnEnvs: Record<string, string | undefined>[] = [];
  const spawnArguments: string[][] = [];
  const factory = createSessionFactory({ configStore: { configPath: path.join(directory, 'config.json') },
    hookRouter: new HookRouter(), getHookPort: () => 12345, getGitWorkspace: () => gitWorkspace, getPlanReviewPort: () => null,
    resolveHookTools: () => [], getUserHooks: () => [] });
  let spentTodayUsd: number | null = 10;
  let isPaused = false;
  let isOrchestratorLive = true;
  let shouldThrowOnMake = false;
  let projectChain: Promise<unknown> = Promise.resolve();
  const dependencies: Parameters<typeof createFactoryDispatch<Session>>[0] = {
    onReadyIntent: (_projectId, intentId) => { readyIntents.push(intentId); },
    onWorkerTurnEnd: async (worker) => { turnEnds.push(worker); },
    config, sessions, nodePath: process.execPath, hookCliPath, shimDir: path.join(directory, 'bin'),
    getOrchestrator: (sessionId) => sessionId === 'orchestrator' && isOrchestratorLive ? { projectId: 'repo', intentId } : null,
    serializeProject: <T>(_projectId: string, operation: () => Promise<T>) => {
      const next = projectChain.then(operation, operation);
      projectChain = next;
      return next;
    },
    ensureLedger: async () => ledger, commitAndLand: land, runCoherence,
    readSpentTodayUsd: () => spentTodayUsd,
    readPaused: async () => isPaused,
    readTrustedIntentIds: async () => new Set([intentId]),
    setException: (projectId, reason) => { if (reason === null) { exceptions.delete(projectId); return; } exceptions.set(projectId, reason); },
    notifyOrchestrator: (_projectId, event) => { events.push(event); },
    makeSession: (project, currentConfig, overrides) => {
      if (shouldThrowOnMake) throw new Error('Session construction failed');
      const session = factory(project, currentConfig, overrides);
      session._spawnCommand = { path: process.execPath, kind: 'exe' };
      session._ptySpawn = (_file, args, options) => { spawnArguments.push([...args]); if (options.env) spawnEnvs.push(options.env); return fakePty(); };
      spawned.push({ project, overrides, session });
      return session;
    },
    wireSessionEvents: () => {}, closeSessionDataClients: () => {},
    broadcast: (message) => { broadcasts.push(message); },
    recordLane: (_sessionId, lane) => { laneRecords.push(lane); },
    spawnGate: { run: async (operation) => operation() },
  };
  const dispatcher = createFactoryDispatch(dependencies);
  context.after(async () => { await dispatcher.stop(); await Promise.allSettled([projectChain]); await rm(directory, { recursive: true, force: true }); });
  const inspect = async () => CoherenceWorkInspect.parse(JSON.parse(await runCoherence({ cwd: projectPath, args: ['work', 'inspect', '--json'] })));
  return { dispatcher, dependencies, runCoherence, config, git, ledger, inspect, createOrder, workId, intentId, spawned, sessions, commands, events, broadcasts, laneRecords, exceptions, hookCliPath,
    spawnEnvs, spawnArguments, projectPath, turnEnds, readyIntents, setSpend: (spend: number | null) => { spentTodayUsd = spend; },
    settle: async () => { let settled: Promise<unknown> | null = null; while (settled !== projectChain) { settled = projectChain; await settled.catch(() => {}); } },
    setPaused: (paused: boolean) => { isPaused = paused; },
    endOrchestrator: () => { isOrchestratorLive = false; }, failMake: (shouldFail = true) => { shouldThrowOnMake = shouldFail; } };
}

test('dispatch hands off and activates at the integration tip, then provisions a worker worktree with coherence hooks', async (context) => {
  const fixture = await createFixture(context);
  const reply = await fixture.dispatcher.dispatch('orchestrator', { workId: fixture.workId });
  if (!reply.ok) throw new Error(reply.reason);
  assert.equal(reply.ok, true);
  const spawned = fixture.spawned[0];
  assert.equal(reply.sessionId, `factory-work-${fixture.workId.slice(-8)}`);
  assert.equal(spawned.project.path, fixture.projectPath);
  assert.equal(spawned.project.id, reply.sessionId);
  assert.equal(spawned.project.dangerouslySkipPermissions, false);
  const overrides = spawned.overrides;
  assert.deepEqual(overrides.extraUserHooks, buildCoherenceUserHooks({ nodePath: process.execPath, hookCliPath: fixture.hookCliPath }));
  assert.equal(overrides.extraClaudeArgs?.[0], '--session-id');
  const claudeSessionId = overrides.extraClaudeArgs?.[1];
  assert.match(claudeSessionId ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(overrides.agent, 'claude-code');
  assert.equal(overrides.ephemeral, true);
  assert.equal(overrides.agentApi, false);
  assert.equal(overrides.requireWorktree, true);
  assert.equal(overrides.dangerouslySkipPermissions, false);
  assert.deepEqual(overrides.spawnEnv, { COHERENCE_HOOK_HOST: 'claude', SSH_AUTH_SOCK: '', SSH_ASKPASS: '', GIT_ASKPASS: '', GIT_SSH_COMMAND: 'false',
    GIT_TERMINAL_PROMPT: '0', GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '' });
  assert.deepEqual(overrides.extraClaudeArgs?.slice(2), [...LANE_ENVIRONMENT_ARGS]);
  assert.equal('gitWorkspace' in overrides, false);
  assert.deepEqual(overrides.settingsPermissions, { defaultMode: 'acceptEdits',
    allow: ['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(coherence context:*)', 'Bash(npm run typecheck:*)', 'Bash(npm run lint:*)', 'Bash(npm test:*)'],
    deny: ['Bash(git push:*)', 'Bash(gh:*)', 'Bash(glimmervoid:*)', 'WebFetch', 'Edit(**/.git/**)', 'Edit(**/.claude/**)'] });
  assert.ok(spawned.session.worktreeDir);
  assert.notEqual(spawned.session.worktreeDir, fixture.projectPath);
  assert.notEqual(spawned.session.worktreeDir, fixture.ledger.cwd);
  assert.equal(await fixture.git(['rev-parse', 'HEAD'], spawned.session.worktreeDir), await fixture.git(['rev-parse', 'integration']));
  const work = (await fixture.inspect()).work.find((candidate) => candidate.work === fixture.workId);
  assert.equal(work?.state, 'active');
  assert.deepEqual(work?.owner, { session: claudeSessionId, agent: 'claude-code' });
  assert.equal(await fixture.git(['rev-parse', 'integration']), await fixture.git(['rev-parse', 'origin/integration']));
  assert.equal(fixture.spawnEnvs[0].COHERENCE_HOOK_HOST, 'claude');
  assert.equal(fixture.spawnEnvs[0].SSH_AUTH_SOCK, '');
  assert.equal(fixture.spawnEnvs[0].GIT_ASKPASS, '');
  assert.equal(fixture.spawnEnvs[0].PATH?.split(path.delimiter)[0], overrides.prependPathDirs?.[0]);
  assert.equal(fixture.spawnEnvs[0].GLIMMERVOID_AGENT_URL, undefined);
  assert.ok(fixture.spawnArguments[0].includes('--setting-sources'));
  const settingsIndex = fixture.spawnArguments[0].indexOf('--settings');
  assert.ok(settingsIndex >= 0);
  const settingsFile = fixture.spawnArguments[0][settingsIndex + 1];
  assert.ok(settingsFile);
  const settings: { hooks: Record<string, unknown> } = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.ok(settings.hooks.PostToolUse);
  assert.equal(fixture.spawnArguments[0].includes('--dangerously-skip-permissions'), false);
  assert.equal(fixture.sessions.get(reply.sessionId), spawned.session);
  spawned.session.emit('claude-session-id', { id: claudeSessionId, vendor: 'claude' });
  assert.deepEqual(fixture.laneRecords, ['factory']);
  assert.deepEqual(fixture.dispatcher.getLiveWorkers('repo'), [{ workId: fixture.workId, sessionId: reply.sessionId }]);
  assert.equal(fixture.events.at(-1)?.event, 'dispatched');
  assert.equal(fixture.broadcasts[0].type, 'session-added');
  spawned.session.destroy();
  assert.deepEqual(fixture.dispatcher.getLiveWorkers('repo'), []);
  assert.equal(fixture.events.at(-1)?.event, 'ended');
  assert.equal(fixture.events.filter((event) => event.event === 'ended').length, 1);
  assert.equal(fixture.broadcasts.at(-1)?.type, 'session-removed');
  await fixture.settle();
  const reopened = (await fixture.inspect()).work.find((candidate) => candidate.work === fixture.workId);
  assert.equal(reopened?.state, 'open');
  assert.equal(reopened?.last?.session, 'glimmervoid-factory');
});

test('dispatch refuses missing orders, invalid callers, disabled factory and over-budget work without spawning', async (context) => {
  const fixture = await createFixture(context);
  assert.equal((await fixture.dispatcher.dispatch('orchestrator', { workId: 'bad' })).ok, false);
  assert.equal((await fixture.dispatcher.dispatch('normal', { workId: fixture.workId })).ok, false);
  assert.equal((await fixture.dispatcher.dispatch('orchestrator', { workId: 'wrk-ffffffffffffffff' })).ok, false);
  fixture.setSpend(11);
  assert.deepEqual(await fixture.dispatcher.dispatch('orchestrator', { workId: fixture.workId }), { ok: false, reason: 'daily spend is over budget' });
  assert.equal(fixture.exceptions.get('repo'), 'daily spend is over budget');
  assert.equal(fixture.spawned.length, 0);
  assert.equal(fixture.commands.some((args) => args[1] === 'handoff'), false);
  fixture.config.factory = { enabled: false };
  assert.equal((await fixture.dispatcher.dispatch('orchestrator', { workId: fixture.workId })).ok, false);
  assert.equal((await fixture.inspect()).work.find((candidate) => candidate.work === fixture.workId)?.state, 'open');
});

test('serialized concurrent dispatches enforce the live-worker cap and exit releases admission', async (context) => {
  const fixture = await createFixture(context);
  fixture.config.factory = { enabled: true, maxLiveWorkers: 1, checks: ['npm test'] };
  const secondId = await fixture.createOrder(fixture.intentId, 'src/other.ts');
  const replies = await Promise.all([fixture.workId, secondId].map((workId) => fixture.dispatcher.dispatch('orchestrator', { workId })));
  assert.equal(replies.filter((reply) => reply.ok).length, 1);
  assert.equal(fixture.spawned.length, 1);
  const refusal = replies.find((reply) => !reply.ok);
  assert.ok(refusal && !refusal.ok);
  assert.match(refusal.reason, /cap/);
  fixture.spawned[0].session.emit('exit');
  assert.deepEqual(fixture.dispatcher.getLiveWorkers('repo'), []);
  assert.equal((await fixture.dispatcher.dispatch('orchestrator', { workId: secondId })).ok, true);
});

test('a failed spawn reopens the order so the real admission gate admits a second dispatch', async (context) => {
  const fixture = await createFixture(context);
  fixture.failMake();
  assert.deepEqual(await fixture.dispatcher.dispatch('orchestrator', { workId: fixture.workId }), { ok: false, reason: 'Session construction failed' });
  assert.equal(fixture.sessions.size, 0);
  assert.deepEqual(fixture.dispatcher.getLiveWorkers('repo'), []);
  assert.equal((await fixture.inspect()).work.find((candidate) => candidate.work === fixture.workId)?.state, 'open');
  fixture.failMake(false);
  const second = await fixture.dispatcher.dispatch('orchestrator', { workId: fixture.workId });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal((await fixture.inspect()).work.find((candidate) => candidate.work === fixture.workId)?.state, 'active');
});

test('a repository whose attributes name a filter driver refuses dispatch with a factory exception before any ledger write', async (context) => {
  const fixture = await createFixture(context);
  await writeFile(path.join(fixture.ledger.cwd, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  await writeFile(path.join(fixture.ledger.cwd, 'asset.bin'), 'pointer\n');
  await fixture.git(['add', '.gitattributes', 'asset.bin'], fixture.ledger.cwd);
  await fixture.git(['commit', '-m', 'track binaries with lfs'], fixture.ledger.cwd);
  const reason = 'repository uses git filter drivers (lfs), which factory workers cannot run safely';
  assert.deepEqual(await fixture.dispatcher.dispatch('orchestrator', { workId: fixture.workId }), { ok: false, reason });
  assert.equal(fixture.exceptions.get('repo'), reason);
  assert.equal(fixture.events.at(-1)?.event, 'refused');
  assert.equal(fixture.commands.some((args) => args[1] === 'handoff'), false);
  assert.equal(fixture.spawned.length, 0);
  assert.equal((await fixture.inspect()).work.find((candidate) => candidate.work === fixture.workId)?.state, 'open');
});

test('a repository whose tracked path list exceeds the pipe buffer still passes the filter scan and admits dispatch', async (context) => {
  const fixture = await createFixture(context);
  const bulkDirectory = path.join(fixture.projectPath, 'generated-fixtures-with-a-deliberately-long-directory-name');
  await mkdir(bulkDirectory);
  const trackedFileNames = Array.from({ length: 1500 }, (_, index) => `tracked-fixture-file-with-a-long-descriptive-name-${index}.txt`);
  await Promise.all(trackedFileNames.map((fileName) => writeFile(path.join(bulkDirectory, fileName), 'fixture\n')));
  await fixture.git(['add', '.']);
  await fixture.git(['commit', '-m', 'track many fixtures']);
  await fixture.git(['push', 'origin', 'integration']);
  await fixture.git(['merge', '--ff-only', 'integration'], fixture.ledger.cwd);
  const trackedPathBytes = Buffer.byteLength(await fixture.git(['ls-files', '-z'], fixture.ledger.cwd));
  assert.ok(trackedPathBytes > 128 * 1024, String(trackedPathBytes));
  const reply = await fixture.dispatcher.dispatch('orchestrator', { workId: fixture.workId });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(fixture.exceptions.has('repo'), false);
  assert.equal(fixture.spawned.length, 1);
});

test('a paused factory refuses dispatch before any ledger write', async (context) => {
  const fixture = await createFixture(context);
  fixture.setPaused(true);
  assert.deepEqual(await fixture.dispatcher.dispatch('orchestrator', { workId: fixture.workId }), { ok: false, reason: 'factory is paused' });
  assert.equal(fixture.commands.some((args) => args[1] === 'handoff'), false);
  assert.equal(fixture.spawned.length, 0);
  fixture.setPaused(false);
  assert.equal((await fixture.dispatcher.dispatch('orchestrator', { workId: fixture.workId })).ok, true);
});

test('a daily budget with unknown spend refuses dispatch and raises the factory exception', async (context) => {
  const fixture = await createFixture(context);
  fixture.setSpend(null);
  assert.deepEqual(await fixture.dispatcher.dispatch('orchestrator', { workId: fixture.workId }), { ok: false, reason: 'daily budget set but usage tracking is off' });
  assert.equal(fixture.exceptions.get('repo'), 'daily budget set but usage tracking is off');
  assert.equal(fixture.spawned.length, 0);
});

test('lane start reconciles a factory-activated order with no live worker back to open', async (context) => {
  const fixture = await createFixture(context);
  await fixture.dispatcher.dispatch('orchestrator', { workId: fixture.workId });
  await fixture.dispatcher.stop();
  await fixture.settle();
  assert.equal((await fixture.inspect()).work.find((candidate) => candidate.work === fixture.workId)?.state, 'active');
  const restarted = createFactoryDispatch({ ...fixture.dependencies });
  context.after(() => restarted.stop());
  const inspection = await fixture.inspect();
  const orientText = await fixture.runCoherence({ cwd: fixture.projectPath, args: ['orient', '--json'] })
    .catch((error: unknown) => error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '');
  const project = buildFactoryProjectState({ projectId: 'repo', projectName: 'Factory', headSha: null, error: null, work: inspection,
    orient: CoherenceOrient.parse(JSON.parse(orientText)) });
  assert.equal(project.orders.find((order) => order.id === fixture.workId)?.state, 'active');
  await restarted.reconcileActiveOrders(project);
  assert.equal((await fixture.inspect()).work.find((candidate) => candidate.work === fixture.workId)?.state, 'open');
  const handedCount = fixture.commands.filter((args) => args[1] === 'transition').length;
  await restarted.reconcileActiveOrders(project);
  assert.equal(fixture.commands.filter((args) => args[1] === 'transition').length, handedCount);
});

test('glimmervoid shims invoke the runtime-resolved CLI with quoted paths and forwarded arguments', () => {
  const shims = buildCoherenceShims({ nodePath: '/node with spaces', cliPath: '/coherence.js', glimmervoidCliPath: cliPath });
  assert.deepEqual(shims.slice(0, 2), [
    { fileName: 'glimmervoid', mode: 0o755, text: `#!/bin/sh\nexec "/node with spaces" "${cliPath}" "$@"\n` },
    { fileName: 'glimmervoid.cmd', mode: 0o644, text: `@echo off\r\n"/node with spaces" "${cliPath}" %*\r\n` },
  ]);
});

test('HTTP permits only a live orchestrator to dispatch with the global agent API off and keeps bearer authentication', async (context) => {
  const session = new Session({ id: 'orchestrator', name: 'Master', path: os.tmpdir(), agentApi: true, ptySpawn: () => fakePty() });
  session._hooks.inject();
  const token = session.agentToken;
  assert.ok(token);
  const handled: string[] = [];
  const regularVerbs: string[] = [];
  let isOrchestrator = true;
  let isAgentApiEnabled = false;
  const app = createBackendHttpApp({ staticDir: null, configStore: { configPath: path.join(os.tmpdir(), 'dispatch-config.json') },
    remote: { allowedOrigins: [] }, remoteAuth: null, allowedHosts: [], listenerPortsFor: () => [], pageToken: 'page',
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) }, getSession: () => session, getUsage: () => ({ ingestStatusline: () => {} }),
    getAgentApi: () => ({ enabled: () => isAgentApiEnabled, handle: async (_session, verb) => {
      assert.equal(isAgentApiEnabled, true);
      regularVerbs.push(verb);
      return { status: 200, body: { ok: true } };
    } }),
    getFactory: () => ({ getLiveOrchestrator: () => isOrchestrator ? { projectId: 'repo', intentId: 'intent' } : null,
      dispatch: async (_sessionId, payload) => { handled.push(String(payload.workId)); return { ok: true, sessionId: 'worker' }; } }),
  });
  const server = http.createServer(app);
  await listenOnLoopback(server);
  context.after(async () => { session.destroy(); server.closeAllConnections(); await closeServer(server); });
  const post = (verb: string, presented = token) => fetch(`http://127.0.0.1:${boundPort(server)}/agent/orchestrator/${verb}`, {
    method: 'POST', headers: { authorization: `Bearer ${presented}` }, body: JSON.stringify({ workId: 'wrk-0123456789abcdef' }),
  });
  assert.equal((await post('dispatch', 'wrong')).status, 404);
  assert.equal((await post('dispatch')).status, 200);
  assert.deepEqual(handled, ['wrk-0123456789abcdef']);
  for (const verb of ['spawn', 'board', 'attention']) assert.equal((await post(verb)).status, 403);
  isOrchestrator = false;
  assert.equal((await post('dispatch')).status, 403);
  assert.equal((await post('spawn')).status, 404);
  assert.deepEqual(handled, ['wrk-0123456789abcdef']);
  assert.deepEqual(regularVerbs, []);
  isAgentApiEnabled = true;
  for (const verb of ['spawn', 'board', 'attention']) assert.equal((await post(verb)).status, 200);
  assert.deepEqual(regularVerbs, ['spawn', 'board', 'attention']);
  assert.equal((await post('dispatch')).status, 403);
  isOrchestrator = true;
  for (const verb of ['spawn', 'board', 'attention', 'unknown']) assert.equal((await post(verb)).status, 403);
  assert.equal((await post('dispatch')).status, 200);
  assert.deepEqual(regularVerbs, ['spawn', 'board', 'attention']);
  await context.test('the POSIX glimmervoid launcher forwards dispatch to the authenticated running server', { skip: process.platform === 'win32' }, async (shimContext) => {
    const shimDir = await mkdtemp(path.join(os.tmpdir(), 'factory shim '));
    shimContext.after(() => rm(shimDir, { recursive: true, force: true }));
    const shim = buildCoherenceShims({ nodePath: process.execPath, cliPath: '/unused-coherence.js', glimmervoidCliPath: cliPath })
      .find((candidate) => candidate.fileName === 'glimmervoid');
    assert.ok(shim);
    const launcherPath = path.join(shimDir, shim.fileName);
    await writeFile(launcherPath, shim.text, { mode: shim.mode });
    const { stdout } = await execFileAsync(launcherPath, ['dispatch', 'wrk-0123456789abcdef', 'ignored'], {
      env: { ...process.env, [AGENT_URL_ENV]: `http://127.0.0.1:${boundPort(server)}/agent/orchestrator?t=${token}` },
      timeout: 20_000,
    });
    assert.deepEqual(JSON.parse(stdout), { ok: true, sessionId: 'worker' });
    assert.deepEqual(handled, ['wrk-0123456789abcdef', 'wrk-0123456789abcdef', 'wrk-0123456789abcdef']);
  });
});


test('a required worktree refuses to start a terminal when provisioning falls back to the repository', async () => {
  let spawnCount = 0;
  const errors: string[] = [];
  const session = new Session({ id: 'factory-no-worktree', name: 'Worker', path: os.tmpdir(), requireWorktree: true,
    spawnCommand: { path: process.execPath, kind: 'exe' }, ptySpawn: () => { spawnCount += 1; return fakePty(); } });
  session.on('error', (error: Error) => { errors.push(error.message); });
  try {
    await session.start();
    assert.equal(spawnCount, 0);
    assert.deepEqual(errors, ['This session requires its own git worktree']);
  } finally {
    session.destroy();
  }
});


test('factory worker main Stop hands the pinned worktree base and order to close-out', async (context) => {
  const fixture = await createFixture(context);
  const dispatched = await fixture.dispatcher.dispatch('orchestrator', { workId: fixture.workId });
  assert.equal(dispatched.ok, true);
  const worker = fixture.spawned[0];
  const claudeSessionId = worker.overrides.extraClaudeArgs?.[1];
  assert.ok(claudeSessionId);
  worker.session.emit('hook-event', { event: 'Stop', payload: { session_id: 'another-session' } });
  worker.session.emit('hook-event', { event: 'PostToolUse', payload: { session_id: claudeSessionId } });
  assert.equal(fixture.turnEnds.length, 0);
  worker.session.emit('hook-event', { event: 'Stop', payload: { session_id: claudeSessionId } });
  assert.equal(fixture.turnEnds.length, 1);
  const closeOutWorker = fixture.turnEnds[0];
  assert.equal(closeOutWorker.baseSha, worker.session.baseSha);
  assert.ok(closeOutWorker.baseSha);
  assert.equal(closeOutWorker.workId, fixture.workId);
  assert.equal(closeOutWorker.intentId, fixture.intentId);
  assert.equal(closeOutWorker.claudeSessionId, claudeSessionId);
  assert.equal(closeOutWorker.session.worktreeDir, worker.session.worktreeDir);
  assert.deepEqual(closeOutWorker.writeScopes, ['src/retry.ts']);
  assert.deepEqual(closeOutWorker.criteria, ['Retries pass']);
});


test('dispatch ready authenticates the active root intent and never spawns a worker', async (context) => {
  const fixture = await createFixture(context);
  assert.equal((await fixture.dispatcher.dispatch('normal', { readyIntent: fixture.intentId })).ok, false);
  assert.equal((await fixture.dispatcher.dispatch('orchestrator', { readyIntent: fixture.workId })).ok, false);
  assert.equal((await fixture.dispatcher.dispatch('orchestrator', { readyIntent: fixture.intentId, workId: fixture.workId })).ok, false);
  assert.deepEqual(await fixture.dispatcher.dispatch('orchestrator', { readyIntent: fixture.intentId }), { ok: true, sessionId: 'orchestrator' });
  assert.deepEqual(fixture.readyIntents, [fixture.intentId]);
  assert.equal(fixture.spawned.length, 0);
});
