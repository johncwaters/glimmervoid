import assert from 'node:assert/strict';
import { access, appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileAsync } from '../server/child-process-safe.ts';
import { glimmervoidHomeDir } from '../server/config-store.ts';
import { buildCoherenceShims } from '../server/core/coherence-session-core.ts';
import { createFactoryPoller } from '../server/factory-poller.ts';
import type { FactoryPoller } from '../server/factory-poller.ts';
import { createGitWorkspace, runFactoryGit } from '../server/git-workspace.ts';
import type { GitWorkspaceInstance } from '../server/git-workspace.ts';
import { CoherenceWorkInspect } from '../shared/contracts/coherence.ts';
import { FactoryLaneState } from '../shared/contracts/factory.ts';
import { createFactoryWiring } from '../server/factory-wiring.ts';
import { cliPath as glimmervoidCliPath, resolvePackageBin } from '../server/runtime-paths.ts';
import type { FactoryState } from '../shared/contracts/factory.ts';
import { waitFor } from './helpers/wait-for.ts';

const REAL_PROCESS_DEADLINE_MS = 30_000;

test('factory wiring is disabled until explicitly enabled and hides state after disabling', async (context) => {
  const config = { factory: { enabled: false }, projects: [] };
  let gitInvocations = 0;
  const gitWorkspace = createGitWorkspace({ git: () => { gitInvocations += 1; throw new Error('Disabled factory invoked Git'); } });
  const pollers: FactoryPoller[] = [];
  const wiring = createFactoryWiring({
    config, gitWorkspace, broadcast: () => {}, listFactoryProjects: () => [], firstTickDelayMs: () => 0,
    createPoller: (deps) => {
      const poller = createFactoryPoller(deps);
      pollers.push(poller);
      return poller;
    },
  });
  context.after(wiring.stop);
  wiring.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pollers.length, 0);
  assert.equal(gitInvocations, 0);
  assert.equal(wiring.getState(), null);
  config.factory.enabled = true;
  wiring.restartIfConfigChanged();
  await waitFor(() => wiring.getState() !== null, 'enabled factory reads its first state', REAL_PROCESS_DEADLINE_MS);
  assert.equal(pollers.length, 1);
  wiring.restartIfConfigChanged();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pollers.length, 1);
  config.factory.enabled = false;
  wiring.restartIfConfigChanged();
  await waitFor(() => wiring.getState() === null, 'disabled factory hides its state');
});

test('lane start writes coherence shims atomically and preserves matching content across starts', async (context) => {
  const homeDir = await mkdtemp(path.join(glimmervoidHomeDir(), 'factory shim home '));
  context.after(() => rm(homeDir, { recursive: true, force: true }));
  const config = { factory: { enabled: false }, projects: [] };
  let completedStarts = 0;
  const wiring = createFactoryWiring({
    config, homeDir, firstTickDelayMs: () => 0,
    broadcast: () => { completedStarts += 1; },
  });
  context.after(wiring.stop);
  assert.equal(wiring.binDir, path.join(homeDir, 'factory', 'bin'));
  wiring.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completedStarts, 0);
  await assert.rejects(access(wiring.binDir), { code: 'ENOENT' });
  config.factory.enabled = true;
  wiring.restartIfConfigChanged();
  await waitFor(() => wiring.getState() !== null, 'enabled lane finishes shim setup before the first tick', REAL_PROCESS_DEADLINE_MS);
  const cliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  assert.ok(cliPath);
  const shims = buildCoherenceShims({ nodePath: process.execPath, cliPath, glimmervoidCliPath });
  const originalMtimes: number[] = [];
  for (const shim of shims) {
    const shimPath = path.join(wiring.binDir, shim.fileName);
    assert.equal(await readFile(shimPath, 'utf8'), shim.text);
    if (process.platform !== 'win32') assert.equal((await stat(shimPath)).mode & 0o777, shim.mode);
    await utimes(shimPath, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    originalMtimes.push((await stat(shimPath)).mtimeMs);
  }
  assert.deepEqual((await readdir(wiring.binDir)).sort(), ['coherence', 'coherence.cmd', 'glimmervoid', 'glimmervoid.cmd']);
  if (process.platform !== 'win32') await chmod(path.join(wiring.binDir, 'coherence'), 0o644);
  const broadcastsBeforeRestart = completedStarts;
  wiring.start();
  await waitFor(() => completedStarts > broadcastsBeforeRestart, 'restarted lane checks existing shims', REAL_PROCESS_DEADLINE_MS);
  for (const [index, shim] of shims.entries()) {
    const shimPath = path.join(wiring.binDir, shim.fileName);
    assert.equal((await stat(shimPath)).mtimeMs, originalMtimes[index]);
    if (process.platform !== 'win32') assert.equal((await stat(shimPath)).mode & 0o777, shim.mode);
  }
  await writeFile(path.join(wiring.binDir, 'coherence.cmd'), 'stale launcher');
  const broadcastsBeforeRepair = completedStarts;
  wiring.start();
  await waitFor(() => completedStarts > broadcastsBeforeRepair, 'restarted lane replaces stale shim content', REAL_PROCESS_DEADLINE_MS);
  assert.equal(await readFile(path.join(wiring.binDir, 'coherence.cmd'), 'utf8'), shims.find((shim) => shim.fileName === 'coherence.cmd')?.text);
  assert.deepEqual((await readdir(wiring.binDir)).sort(), ['coherence', 'coherence.cmd', 'glimmervoid', 'glimmervoid.cmd']);
  await context.test('the POSIX shim executes coherence doctrine with the JSON argument forwarded', { skip: process.platform === 'win32' }, async () => {
    const { stdout } = await execFileAsync(path.join(wiring.binDir, 'coherence'), ['doctrine', '--json'], { encoding: 'utf8', timeout: 20_000 });
    const direct = await execFileAsync(process.execPath, [cliPath, 'doctrine', '--json'], { encoding: 'utf8', timeout: 20_000 });
    assert.ok(stdout.trim());
    assert.ok(JSON.parse(stdout));
    assert.equal(stdout, direct.stdout);
  });
  await context.test('the POSIX shim preserves the installed coherence CLI rejection of --version', { skip: process.platform === 'win32' }, async () => {
    await assert.rejects(execFileAsync(process.execPath, [cliPath, '--version'], { encoding: 'utf8', timeout: 20_000 }),
      { code: 2, stdout: '', stderr: /^usage: coherence / });
    await assert.rejects(execFileAsync(path.join(wiring.binDir, 'coherence'), ['--version'], { encoding: 'utf8', timeout: 20_000 }),
      { code: 2, stdout: '', stderr: /^usage: coherence / });
  });
});

test('a shim write failure logs and leaves the factory lane running', async (context) => {
  const directory = await mkdtemp(path.join(glimmervoidHomeDir(), 'factory-shim-failure-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const homeDir = path.join(directory, 'not-a-directory');
  await writeFile(homeDir, 'occupied');
  const warnings: string[] = [];
  const wiring = createFactoryWiring({
    config: { factory: { enabled: true }, projects: [] }, homeDir,
    firstTickDelayMs: () => 0, broadcast: () => {},
    log: { warn: (message: string) => { warnings.push(message); } },
  });
  context.after(wiring.stop);
  wiring.start();
  await waitFor(() => wiring.getState() !== null, 'lane runs despite shim setup failure', REAL_PROCESS_DEADLINE_MS);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[factory\] coherence shim setup failed:/);
  assert.equal(await readFile(homeDir, 'utf8'), 'occupied');
});

for (const configuredBranch of [undefined, 'integration']) {
  test(`real factory checkout follows ${configuredBranch ?? 'the detected default'} and runs read-only coherence`, async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-wiring-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const projectPath = path.join(directory, 'repo');
    const homeDir = path.join(directory, 'home');
    await mkdir(projectPath);
    const git = async (args: string[], cwd = projectPath) => {
      const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 20_000 });
      return stdout.trim();
    };
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.email', 'factory@example.test']);
    await git(['config', 'user.name', 'Factory']);
    await git(['config', 'commit.gpgsign', 'false']);
    await writeFile(path.join(projectPath, 'coherence.config.json'), '{}\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'Initial ledger']);
    if (configuredBranch) await git(['checkout', '-b', configuredBranch]);
    const firstSha = await git(['rev-parse', 'HEAD']);
    const pollers: FactoryPoller[] = [];
    const messages: FactoryState[] = [];
    const wiring = createFactoryWiring({
      config: { factory: { enabled: true }, integrationBranch: configuredBranch, projects: [{ id: 'project-1', name: 'Factory', path: projectPath }] },
      homeDir, broadcast: (message) => messages.push(message), firstTickDelayMs: () => 3_600_000,
      createPoller: (deps) => {
        const poller = createFactoryPoller(deps);
        pollers.push(poller);
        return poller;
      },
    });
    context.after(wiring.stop);
    wiring.start();
    await waitFor(() => pollers.length === 1, 'factory creates its poller');
    const checkoutPath = path.join(homeDir, 'factory', 'project-1', 'control');
    await pollers[0].tick();
    assert.equal(messages[0].projects[0].error, null);
    assert.equal(messages[0].projects[0].headSha, firstSha);
    assert.equal(await git(['rev-parse', 'HEAD'], checkoutPath), firstSha);
    assert.equal(await git(['status', '--porcelain'], checkoutPath), '');
    await assert.rejects(git(['symbolic-ref', '--quiet', 'HEAD'], checkoutPath));
    assert.equal(await readFile(path.join(checkoutPath, 'coherence.config.json'), 'utf8'), '{}\n');
    await writeFile(path.join(projectPath, 'coherence.config.json'), '{"name":"Next"}\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'Move integration tip']);
    const secondSha = await git(['rev-parse', 'HEAD']);
    await pollers[0].tick();
    assert.equal(messages[1].projects[0].error, null);
    assert.equal(messages[1].projects[0].headSha, secondSha);
    assert.equal(await git(['rev-parse', 'HEAD'], checkoutPath), secondSha);
    assert.equal(await git(['status', '--porcelain'], checkoutPath), '');
    await wiring.stop();
    assert.equal(wiring.getState(), null);
    await assert.rejects(access(checkoutPath), { code: 'ENOENT' });
  });
}

async function createFactoryFixture(context: test.TestContext, { integrationBranch }: { integrationBranch?: string } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-wiring-'));
  const stopWirings: Array<() => Promise<void>> = [];
  context.after(async () => {
    for (const stopWiring of stopWirings) await stopWiring();
    await rm(directory, { recursive: true, force: true });
  });
  const projectPath = path.join(directory, 'repo');
  const homeDir = path.join(directory, 'home');
  await mkdir(projectPath);
  const git = async (args: string[], cwd = projectPath) => {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 20_000 });
    return stdout.trim();
  };
  const commitLedger = async (cwd: string, content: string) => {
    await writeFile(path.join(cwd, 'coherence.config.json'), content);
    await git(['add', '.'], cwd);
    await git(['commit', '-m', 'Ledger'], cwd);
    return git(['rev-parse', 'HEAD'], cwd);
  };
  const initRepository = async (cwd: string) => {
    await git(['init', '--initial-branch=main'], cwd);
    await git(['config', 'user.email', 'factory@example.test'], cwd);
    await git(['config', 'user.name', 'Factory'], cwd);
    await git(['config', 'commit.gpgsign', 'false'], cwd);
  };
  const pollers: FactoryPoller[] = [];
  const messages: FactoryState[] = [];
  const config = { factory: { enabled: true }, integrationBranch, projects: [{ id: 'project-1', name: 'Factory', path: projectPath }] };
  const startWiring = async () => {
    const wiring = createFactoryWiring({
      config, homeDir, broadcast: (message) => messages.push(message), firstTickDelayMs: () => 3_600_000,
      createPoller: (deps) => {
        const poller = createFactoryPoller(deps);
        pollers.push(poller);
        return poller;
      },
    });
    stopWirings.push(wiring.stop);
    wiring.start();
    await waitFor(() => pollers.length === 1, 'factory creates its poller');
    return wiring;
  };
  const checkoutPath = path.join(homeDir, 'factory', 'project-1', 'control');
  return { directory, projectPath, checkoutPath, config, git, commitLedger, initRepository, startWiring, pollers, messages };
}

test('a stray directory at the control path is replaced by a fresh checkout', async (context) => {
  const { projectPath, checkoutPath, git, commitLedger, initRepository, startWiring, pollers, messages } = await createFactoryFixture(context);
  await initRepository(projectPath);
  const sha = await commitLedger(projectPath, '{}\n');
  await mkdir(checkoutPath, { recursive: true });
  await writeFile(path.join(checkoutPath, 'leftover.txt'), 'stale\n');
  await startWiring();
  await pollers[0].tick();
  assert.equal(messages[0].projects[0].error, null);
  assert.equal(messages[0].projects[0].headSha, sha);
  assert.equal(await git(['rev-parse', 'HEAD'], checkoutPath), sha);
  await assert.rejects(access(path.join(checkoutPath, 'leftover.txt')), { code: 'ENOENT' });
});

test('a control checkout deleted between ticks is restaged on the following tick', async (context) => {
  const { projectPath, checkoutPath, git, commitLedger, initRepository, startWiring, pollers, messages } = await createFactoryFixture(context);
  await initRepository(projectPath);
  await commitLedger(projectPath, '{}\n');
  await startWiring();
  await pollers[0].tick();
  assert.equal(messages[0].projects[0].error, null);
  await rm(checkoutPath, { recursive: true, force: true });
  const movedSha = await commitLedger(projectPath, '{"name":"Next"}\n');
  await pollers[0].tick();
  assert.ok(messages[1].projects[0].error);
  await pollers[0].tick();
  assert.equal(messages[2].projects[0].error, null);
  assert.equal(messages[2].projects[0].headSha, movedSha);
  assert.equal(await git(['rev-parse', 'HEAD'], checkoutPath), movedSha);
});

test('an integration branch present only on origin resolves to the origin tip', async (context) => {
  const { directory, projectPath, checkoutPath, git, commitLedger, initRepository, startWiring, pollers, messages } = await createFactoryFixture(context, { integrationBranch: 'main' });
  const originPath = path.join(directory, 'origin');
  await mkdir(originPath);
  await initRepository(originPath);
  const originSha = await commitLedger(originPath, '{}\n');
  await initRepository(projectPath);
  await git(['remote', 'add', 'origin', originPath]);
  await git(['fetch', 'origin']);
  await assert.rejects(git(['rev-parse', '--verify', 'refs/heads/main']));
  await startWiring();
  await pollers[0].tick();
  assert.equal(messages[0].projects[0].error, null);
  assert.equal(messages[0].projects[0].headSha, originSha);
  assert.equal(await git(['rev-parse', 'HEAD'], checkoutPath), originSha);
});

async function registeredWorktreePaths(git: (args: string[]) => Promise<string>): Promise<string[]> {
  const listing = await git(['worktree', 'list', '--porcelain']);
  return listing.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
}

test('removing a project from the config removes and unregisters its control checkout', async (context) => {
  const { projectPath, checkoutPath, config, git, commitLedger, initRepository, startWiring, pollers, messages } = await createFactoryFixture(context);
  await initRepository(projectPath);
  await commitLedger(projectPath, '{}\n');
  await startWiring();
  await pollers[0].tick();
  assert.equal(messages[0].projects[0].error, null);
  assert.equal((await registeredWorktreePaths(git)).length, 2);
  config.projects = [];
  await pollers[0].tick();
  assert.deepEqual(messages[1].projects, []);
  await assert.rejects(access(checkoutPath), { code: 'ENOENT' });
  assert.equal((await registeredWorktreePaths(git)).length, 1);
});

test('deleting the coherence config removes and unregisters the control checkout', async (context) => {
  const { projectPath, checkoutPath, git, commitLedger, initRepository, startWiring, pollers, messages } = await createFactoryFixture(context);
  await initRepository(projectPath);
  await commitLedger(projectPath, '{}\n');
  await startWiring();
  await pollers[0].tick();
  assert.equal(messages[0].projects[0].error, null);
  await git(['rm', 'coherence.config.json']);
  await git(['commit', '-m', 'Drop ledger']);
  await pollers[0].tick();
  assert.deepEqual(messages[1].projects, []);
  await assert.rejects(access(checkoutPath), { code: 'ENOENT' });
  assert.equal((await registeredWorktreePaths(git)).length, 1);
});

test('a coherence config committed only on a checked-out feature branch keeps the project off the floor', async (context) => {
  const { projectPath, checkoutPath, git, commitLedger, initRepository, startWiring, pollers, messages } = await createFactoryFixture(context);
  await initRepository(projectPath);
  await writeFile(path.join(projectPath, 'README.md'), 'factory\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  await git(['checkout', '-b', 'feature']);
  await commitLedger(projectPath, '{}\n');
  await startWiring();
  await pollers[0].tick();
  assert.deepEqual(messages[0].projects, []);
  await assert.rejects(access(checkoutPath), { code: 'ENOENT' });
});

test('a coherence config on the integration tip shows the project while the working copy sits on an older branch without it', async (context) => {
  const { projectPath, checkoutPath, git, commitLedger, initRepository, startWiring, pollers, messages } = await createFactoryFixture(context);
  await initRepository(projectPath);
  await writeFile(path.join(projectPath, 'README.md'), 'factory\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  await git(['branch', 'older']);
  const integrationSha = await commitLedger(projectPath, '{}\n');
  await git(['checkout', 'older']);
  await assert.rejects(access(path.join(projectPath, 'coherence.config.json')), { code: 'ENOENT' });
  await startWiring();
  await pollers[0].tick();
  assert.equal(messages[0].projects[0].error, null);
  assert.equal(messages[0].projects[0].headSha, integrationSha);
  assert.equal(await readFile(path.join(checkoutPath, 'coherence.config.json'), 'utf8'), '{}\n');
});

test('a project path that is not a git repository is skipped without an error state', async (context) => {
  const { projectPath, startWiring, pollers, messages } = await createFactoryFixture(context);
  await writeFile(path.join(projectPath, 'coherence.config.json'), '{}\n');
  await startWiring();
  await pollers[0].tick();
  assert.deepEqual(messages[0].projects, []);
});

test('a real coherence refusal over a malformed work ledger row shows its reasons without an error', async (context) => {
  const { projectPath, git, commitLedger, initRepository, startWiring, pollers, messages } = await createFactoryFixture(context);
  await initRepository(projectPath);
  await commitLedger(projectPath, '{}\n');
  const coherenceCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  assert.ok(coherenceCliPath);
  await execFileAsync(process.execPath, [
    coherenceCliPath, 'work', 'create', 'Ship the factory', '--success', 'floor renders', '--risk', 'low',
    '--authority', 'user-directed', '--granted-by', 'operator', '--boundary', 'this repository', '--session', 'factory-test', '--json',
  ], { cwd: projectPath, encoding: 'utf8', timeout: 20_000 });
  const ledgerDirectory = path.join(projectPath, '.coherence', 'work');
  const [ledgerFile] = (await readdir(ledgerDirectory)).filter((fileName) => fileName.endsWith('.jsonl'));
  assert.ok(ledgerFile);
  await appendFile(path.join(ledgerDirectory, ledgerFile), 'not json\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Malformed work row']);
  await startWiring();
  await pollers[0].tick();
  const [project] = messages[0].projects;
  assert.equal(project.error, null);
  assert.equal(project.heading.action, 'refuse');
  assert.ok(project.heading.reasons.some((reason) => reason.includes('is malformed JSON')));
});

async function createIntentFixture(context: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-intent-'));
  const wirings: ReturnType<typeof createFactoryWiring>[] = [];
  context.after(async () => {
    for (const wiring of wirings) await wiring.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const projectPath = path.join(directory, 'repo');
  const homeDir = path.join(directory, 'home');
  const originPath = path.join(directory, 'origin.git');
  await mkdir(projectPath);
  const git = async (args: string[], cwd = projectPath) => {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 20_000 });
    return stdout.trim();
  };
  await git(['init', '--bare', '--initial-branch=integration', originPath]);
  await git(['init', '--initial-branch=integration']);
  await git(['config', 'user.email', 'factory@example.test']);
  await git(['config', 'user.name', 'Factory']);
  await git(['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(projectPath, 'coherence.config.json'), '{}\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial ledger']);
  await git(['remote', 'add', 'origin', originPath]);
  await git(['push', '-u', 'origin', 'integration']);
  const config = { factory: { enabled: true }, integrationBranch: 'integration', projects: [{ id: 'project-1', name: 'Factory', path: projectPath }] };
  const broadcasts: FactoryState[] = [];
  const start = async (gitWorkspace?: GitWorkspaceInstance, runCoherence?: (request: { cwd: string; args: string[] }) => Promise<string>) => {
    const wiring = createFactoryWiring({
      config, homeDir, gitWorkspace, runCoherence, firstTickDelayMs: () => 0,
      broadcast: (message) => broadcasts.push(message),
    });
    wirings.push(wiring);
    wiring.start();
    await waitFor(() => wiring.getState() !== null, 'factory reads the integration ledger', REAL_PROCESS_DEADLINE_MS);
    return wiring;
  };
  const request = {
    projectId: 'project-1', objective: 'Ship retries', criteria: ['Retry tests pass', 'No lost work'],
    risk: 'low' as const, boundary: 'This repository', writeScopes: ['server/retry.ts'],
  };
  const statePath = path.join(homeDir, 'factory', 'project-1', 'state.json');
  const readState = async () => FactoryLaneState.parse(JSON.parse(await readFile(statePath, 'utf8')));
  return { projectPath, homeDir, originPath, config, broadcasts, git, start, request, statePath, readState };
}

test('queue intent lands on integration and origin, reuses its ledger, and pause persists across restart', async (context) => {
  const { projectPath, homeDir, originPath, config, git, start, request, readState } = await createIntentFixture(context);
  const originalOriginSha = await git(['rev-parse', 'integration'], originPath);
  const wiring = await start();
  assert.equal(wiring.getState()?.projects[0].paused, false);
  assert.deepEqual(await wiring.control({ projectId: request.projectId, action: 'pause' }), { projectId: request.projectId, action: 'pause', ok: true });
  assert.equal(wiring.getState()?.projects[0].paused, true);
  const queued = await wiring.queueIntent(request);
  assert.equal(queued.ok, true, queued.error ?? 'Queue failed');
  assert.ok(queued.workId);
  const state = await readState();
  assert.equal(state.paused, true);
  assert.equal(state.ledgerBranch, 'glimmervoid/project-1/factory-ledger');
  assert.ok(state.ledgerPath);
  assert.equal(await git(['status', '--porcelain'], state.ledgerPath), '');
  const integrationSha = await git(['rev-parse', 'integration']);
  assert.notEqual(integrationSha, originalOriginSha);
  assert.equal(await git(['rev-parse', 'integration'], originPath), integrationSha);
  assert.equal(await git(['log', '-1', '--format=%s']), `factory: queue intent ${queued.workId}`);
  const cliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  assert.ok(cliPath);
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'work', 'inspect', '--json'], {
    cwd: projectPath, encoding: 'utf8', timeout: 20_000,
  });
  const inspection = CoherenceWorkInspect.parse(JSON.parse(stdout));
  assert.equal(inspection.work.length, 1);
  assert.equal(inspection.work[0].work, queued.workId);
  assert.equal(inspection.work[0].opened.parent, null);
  assert.equal(inspection.work[0].owner.session, 'glimmervoid-factory');
  assert.deepEqual(inspection.work[0].opened.criteria, [...request.criteria].sort());
  assert.deepEqual(inspection.work[0].opened.writeScopes, request.writeScopes);
  assert.equal(wiring.getState()?.projects[0].orders[0].id, queued.workId);
  assert.equal(wiring.getState()?.projects[0].headSha, integrationSha);
  await wiring.stop();
  await access(state.ledgerPath);
  const restarted = await start();
  assert.equal(restarted.getState()?.projects[0].paused, true);
  const queuedAgain = await restarted.queueIntent({ ...request, objective: 'Second intent' });
  assert.equal(queuedAgain.ok, true, queuedAgain.error ?? 'Queue failed');
  assert.equal((await readState()).ledgerPath, state.ledgerPath);
  assert.equal(restarted.getState()?.projects[0].orders.length, 2);
  assert.equal((await restarted.control({ projectId: request.projectId, action: 'resume' })).ok, true);
  assert.equal(restarted.getState()?.projects[0].paused, false);
  assert.equal((await readState()).paused, false);
  assert.equal(config.factory.enabled, true);
  assert.equal((await readFile(path.join(homeDir, 'factory', request.projectId, 'state.json'), 'utf8')).includes('ledgerPath'), true);
});

test('concurrent queue requests serialize and a failed landing remains on the reused ledger for the next attempt', async (context) => {
  const { git, start, request, readState, originPath } = await createIntentFixture(context);
  const gitWorkspace = createGitWorkspace();
  let shouldFailLanding = true;
  const wiring = await start({
    ...gitWorkspace,
    mergeKeep: async (args) => {
      if (shouldFailLanding) return { merged: false, committed: true, branch: args.workspace?.branch ?? null, reason: 'landing refused' };
      return gitWorkspace.mergeKeep(args);
    },
  });
  const failed = await wiring.queueIntent(request);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'landing refused');
  const state = await readState();
  assert.ok(state.ledgerPath);
  assert.ok(state.ledgerBranch);
  assert.notEqual(await git(['rev-parse', state.ledgerBranch]), await git(['rev-parse', 'integration']));
  shouldFailLanding = false;
  const queued = await Promise.all([
    wiring.queueIntent({ ...request, objective: 'Second intent' }),
    wiring.queueIntent({ ...request, objective: 'Third intent' }),
    wiring.control({ projectId: request.projectId, action: 'pause' }),
  ]);
  assert.equal(queued.every((outcome) => outcome.ok), true, JSON.stringify(queued));
  assert.equal((await readState()).ledgerPath, state.ledgerPath);
  assert.equal(wiring.getState()?.projects[0].orders.length, 3);
  assert.equal(wiring.getState()?.projects[0].paused, true);
  assert.equal(await git(['rev-parse', 'integration'], originPath), await git(['rev-parse', 'integration']));
});

for (const invalidState of ['invalid JSON', '{"paused":true}']) {
  test(`invalid persisted factory state ${invalidState} defaults to unpaused and no ledger`, async (context) => {
    const { start, request, statePath, readState } = await createIntentFixture(context);
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, invalidState);
    const wiring = await start();
    assert.equal(wiring.getState()?.projects[0].paused, false);
    const queued = await wiring.queueIntent(request);
    assert.equal(queued.ok, true, queued.error ?? 'Queue failed');
    assert.equal((await readState()).paused, false);
  });
}

test('a recorded ledger checkout removed after landing is recreated from integration', async (context) => {
  const { start, request, readState, projectPath } = await createIntentFixture(context);
  const gitWorkspace = createGitWorkspace();
  const wiring = await start(gitWorkspace);
  assert.equal((await wiring.queueIntent(request)).ok, true);
  const previous = await readState();
  assert.ok(previous.ledgerPath);
  const removed = await gitWorkspace.removeWorktreeByPath({ projectPath, cwd: previous.ledgerPath });
  assert.equal(removed.ok, true);
  const next = await wiring.queueIntent({ ...request, objective: 'Second intent' });
  assert.equal(next.ok, true, next.error ?? 'Queue failed');
  const recreated = await readState();
  assert.notEqual(recreated.ledgerPath, previous.ledgerPath);
  assert.equal(recreated.ledgerBranch, previous.ledgerBranch);
  assert.equal(wiring.getState()?.projects[0].orders.length, 2);
});


test('queue refuses a forged factory record injected after screening and before staging', async (context) => {
  const fixture = await createIntentFixture(context);
  const coherenceCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  assert.ok(coherenceCliPath);
  let forgedPath: string | null = null;
  const originalOriginSha = await fixture.git(['rev-parse', 'integration'], fixture.originPath);
  const wiring = await fixture.start(undefined, async ({ cwd, args }) => {
    const { stdout } = await execFileAsync(process.execPath, [coherenceCliPath, ...args], { cwd, timeout: REAL_PROCESS_DEADLINE_MS });
    if (args[0] !== 'work' || args[1] !== 'create') return stdout;
    forgedPath = '.coherence/consequences/s-forged.jsonl';
    await mkdir(path.join(cwd, '.coherence', 'consequences'), { recursive: true });
    await writeFile(path.join(cwd, forgedPath), `${JSON.stringify({ id: 'forged-id', session: 'glimmervoid-factory', relation: 'verifies' })}\n`);
    return stdout;
  });
  const queued = await wiring.queueIntent(fixture.request);
  assert.equal(queued.ok, false);
  assert.match(queued.error ?? '', /without a declared factory write/);
  assert.ok(forgedPath);
  assert.equal(await fixture.git(['rev-parse', 'integration'], fixture.originPath), originalOriginSha);
  await assert.rejects(() => fixture.git(['cat-file', '-e', `integration:${forgedPath}`], fixture.originPath));
});


for (const mechanism of ['fsmonitor', 'smudge', 'clean', 'process', 'external-diff', 'textconv', 'post-checkout']) {
  test(`factory git suppresses worker-configured ${mechanism} and server secrets in real checkouts`, { skip: process.platform === 'win32' }, async (context) => {
    const fixture = await createIntentFixture(context);
    const markerPath = path.join(fixture.homeDir, `${mechanism}-marker`);
    const probePath = path.join(fixture.projectPath, 'probe.mjs');
    await writeFile(probePath, `${String.fromCharCode(35)}!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, process.env.FACTORY_PROBE_TOKEN ?? 'absent');\nprocess.stdin.resume();\n`, { mode: 0o755 });
    await writeFile(path.join(fixture.projectPath, '.gitattributes'), 'payload.txt filter=probe diff=probe\n');
    await writeFile(path.join(fixture.projectPath, 'payload.txt'), 'original\n');
    await fixture.git(['add', '.']);
    await fixture.git(['commit', '-m', 'Plant probe files']);
    await fixture.git(['push', 'origin', 'integration']);
    const probeCommand = `${process.execPath} ${probePath}`;
    const configKey = new Map([
      ['fsmonitor', 'core.fsmonitor'], ['smudge', 'filter.probe.smudge'], ['clean', 'filter.probe.clean'],
      ['process', 'filter.probe.process'], ['external-diff', 'diff.external'], ['textconv', 'diff.probe.textconv'],
    ]).get(mechanism);
    if (configKey) await fixture.git(['config', configKey, probeCommand]);
    if (mechanism === 'post-checkout') {
      const hooksPath = path.join(fixture.projectPath, 'probe-hooks');
      await mkdir(hooksPath);
      await writeFile(path.join(hooksPath, 'post-checkout'), await readFile(probePath), { mode: 0o755 });
      await fixture.git(['config', 'core.hooksPath', hooksPath]);
    }
    if (['smudge', 'clean', 'process'].includes(mechanism)) await fixture.git(['config', 'filter.probe.required', 'true']);
    await fixture.git(['config', 'extensions.worktreeConfig', 'true']);
    if (configKey) await fixture.git(['config', '--worktree', configKey, probeCommand]);
    const previousProbeToken = process.env.FACTORY_PROBE_TOKEN;
    process.env.FACTORY_PROBE_TOKEN = 'server-secret-for-git-probe';
    context.after(() => {
      if (previousProbeToken === undefined) { delete process.env.FACTORY_PROBE_TOKEN; return; }
      process.env.FACTORY_PROBE_TOKEN = previousProbeToken;
    });
    const invocations: { args: string[]; secret: string | undefined }[] = [];
    const gitWorkspace = createGitWorkspace({ git: async (args, cwd, extra) => {
      invocations.push({ args, secret: extra?.replaceEnv?.FACTORY_PROBE_TOKEN });
      assert.ok(extra?.replaceEnv);
      return (await execFileAsync('git', args, { cwd, env: extra.replaceEnv, encoding: 'utf8', timeout: REAL_PROCESS_DEADLINE_MS })).stdout;
    } });
    const wiring = await fixture.start(gitWorkspace);
    assert.equal(wiring.getState()?.projects[0]?.error, null);
    const checkoutPath = path.join(fixture.homeDir, 'factory', fixture.request.projectId, 'control');
    assert.equal(await readFile(path.join(checkoutPath, 'payload.txt'), 'utf8'), 'original\n');
    await writeFile(path.join(checkoutPath, 'payload.txt'), 'changed\n');
    await runFactoryGit(['status', '--porcelain'], { cwd: checkoutPath });
    const diff = await runFactoryGit(['diff', 'HEAD', '--', 'payload.txt'], { cwd: checkoutPath });
    assert.match(diff.stdout, /changed/);
    await runFactoryGit(['add', '--', 'payload.txt'], { cwd: checkoutPath });
    await runFactoryGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', 'payload.txt'], { cwd: checkoutPath });
    const moved = await gitWorkspace.checkoutDetached({ worktreePath: checkoutPath, sha: wiring.getState()?.projects[0]?.headSha ?? '', disableRepoCommands: true });
    assert.equal(moved.ok, true, moved.err ?? 'Checkout failed');
    await wiring.stop();
    assert.ok(invocations.length > 0);
    assert.equal(invocations.every((invocation) => invocation.secret === undefined), true);
    assert.equal(invocations.every((invocation) => invocation.args.includes('core.fsmonitor=false') && invocation.args.includes(`core.hooksPath=${os.devNull}`)), true);
    await assert.rejects(access(markerPath), { code: 'ENOENT' });
  });
}
