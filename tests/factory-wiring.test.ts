import assert from 'node:assert/strict';
import { factoryRepoId } from '../server/factory/core/factory-repos-core.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { access, appendFile, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileAsync } from '../server/child-process-safe.ts';
import { glimmervoidHomeDir } from '../server/config-store.ts';
import { buildCoherenceShims } from '../server/coherence/core/coherence-session-core.ts';
import { createFactoryPoller } from '../server/factory/factory-poller.ts';
import type { FactoryPoller } from '../server/factory/factory-poller.ts';
import { createGitWorkspace, runHardenedGit } from '../server/git/git-workspace.ts';
import type { GitWorkspaceInstance } from '../server/git/git-workspace.ts';
import { CoherenceWorkInspect } from '../shared/contracts/coherence.ts';
import { FactoryLaneState } from '../shared/contracts/factory.ts';
import { FactoryDecisionLogLine } from '../shared/contracts/factory-decision-log.ts';
import { createFactoryWiring } from '../server/factory/factory-wiring.ts';
import { cliPath as glimmervoidCliPath, resolvePackageBin } from '../server/runtime-paths.ts';
import type { FactoryState } from '../shared/contracts/factory.ts';
import type { ProjectConfig } from '../shared/contracts/config.ts';
import {
  createRepositoryWithOrigin, gitRunnerIn, initGitRepository, NATIVE_COHERENCE_CLAUDE_CONTROL, stubEnvironmentVariable, writeNativeCoherenceControl,
} from './helpers/factory-fixture.ts';
import { FACTORY_STALL_MS, buildFactoryIntentDigest, buildOrchestratorPrompt, decideIntentClose } from '../server/factory/core/factory-core.ts';
import { FACTORY_ORCHESTRATOR_ALLOW, FACTORY_ORCHESTRATOR_DENY } from '../server/factory/factory-orchestrator.ts';
import type { LaneSpend } from '../server/usage/core/usage-scan-core.ts';
import type { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import { plainSession } from './helpers/fake-session.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { passthroughWorkLane } from './helpers/passthrough-work-lane.ts';
import type { SessionSpawnOverrides } from '../server/session/session-factory.ts';
import { readCoherenceFixture } from './helpers/factory-coherence-reports.ts';
import { waitFor } from './helpers/wait-for.ts';
import { ORCHESTRATOR_AGENT_VERBS } from '../shared/contracts/session.ts';

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
    const factoryProjectId = factoryRepoId(projectPath);
    const homeDir = path.join(directory, 'home');
    await mkdir(projectPath);
    const git = gitRunnerIn(projectPath);
    await initGitRepository(git, 'main');
    await writeFile(path.join(projectPath, 'coherence.config.json'), '{}\n');
    await writeNativeCoherenceControl(projectPath);
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
    const checkoutPath = path.join(homeDir, 'factory', factoryProjectId, 'control');
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
  const factoryProjectId = factoryRepoId(projectPath);
  const homeDir = path.join(directory, 'home');
  await mkdir(projectPath);
  const git = gitRunnerIn(projectPath);
  const commitLedger = async (cwd: string, content: string) => {
    await writeFile(path.join(cwd, 'coherence.config.json'), content);
    await writeNativeCoherenceControl(cwd);
    await git(['add', '.'], cwd);
    await git(['commit', '-m', 'Ledger'], cwd);
    return git(['rev-parse', 'HEAD'], cwd);
  };
  const initRepository = (cwd: string) => initGitRepository(git, 'main', cwd);
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
  const checkoutPath = path.join(homeDir, 'factory', factoryProjectId, 'control');
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

test('a coherence config committed without the native Claude hook control keeps the project off the floor', async (context) => {
  const { projectPath, checkoutPath, git, initRepository, startWiring, pollers, messages } = await createFactoryFixture(context);
  await initRepository(projectPath);
  await writeFile(path.join(projectPath, 'coherence.config.json'), '{}\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Config without hooks']);
  await startWiring();
  await pollers[0].tick();
  assert.deepEqual(messages[0].projects, []);
  await assert.rejects(access(checkoutPath), { code: 'ENOENT' });
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
  const homeDir = path.join(directory, 'home');
  const { projectPath, originPath, git } = await createRepositoryWithOrigin(directory, 'integration', { 'coherence.config.json': '{}\n', ...NATIVE_COHERENCE_CLAUDE_CONTROL });
  const factoryProjectId = factoryRepoId(projectPath);
  const config = { factory: { enabled: true }, integrationBranch: 'integration', projects: [{ id: 'project-1', name: 'Factory', path: projectPath, factoryProfile: {} as ProjectConfig['factoryProfile'] }] };
  const broadcasts: FactoryState[] = [];
  const start = async (gitWorkspace?: GitWorkspaceInstance, runCoherence?: (request: { cwd: string; args: string[] }) => Promise<string>,
    sessionOptions: Pick<Parameters<typeof createFactoryWiring>[0], 'now' | 'notify' | 'orchestratorOptions' | 'createPoller' | 'readSpentTodayUsd' | 'trustClaudeFolder' | 'prepareCheckRunner' | 'saveProjectFactoryProfile' | 'spawnReviewer'> = {}) => {
    const wiring = createFactoryWiring({
      config, homeDir, gitWorkspace, runCoherence, firstTickDelayMs: () => 0, ...sessionOptions,
      broadcast: (message) => broadcasts.push(message),
    });
    wirings.push(wiring);
    wiring.start();
    await waitFor(() => wiring.getState() !== null, 'factory reads the integration ledger', REAL_PROCESS_DEADLINE_MS);
    return wiring;
  };
  const request = {
    projectId: factoryProjectId, objective: 'Ship retries', criteria: ['Retry tests pass', 'No lost work'],
    risk: 'low' as const, boundary: 'This repository', writeScopes: ['server/retry.ts'],
  };
  const statePath = path.join(homeDir, 'factory', factoryProjectId, 'state.json');
  const readState = async () => FactoryLaneState.parse(JSON.parse(await readFile(statePath, 'utf8')));
  return { projectPath, homeDir, originPath, config, broadcasts, git, start, request, statePath, readState };
}

test('queue proves and saves an unprofiled project once, reruns setup on demand, and refuses unrunnable checks before creating work', async (context) => {
  const fixture = await createIntentFixture(context);
  fixture.config.projects[0].factoryProfile = undefined;
  await mkdir(path.join(fixture.projectPath, 'tests'));
  await writeFile(path.join(fixture.projectPath, 'package.json'), JSON.stringify({ scripts: {
    test: 'node --test tests/*.test.js', 'test:files': 'node --test',
  } }));
  await writeFile(path.join(fixture.projectPath, 'tests', 'passing.js'), "require('node:test')('passes', () => {});\n");
  await writeFile(path.join(fixture.projectPath, 'tests', 'failing.test.js'), "require('node:test')('baseline failure', () => { throw new Error('existing failure'); });\n");
  await fixture.git(['add', '.']);
  await fixture.git(['commit', '-m', 'Add project checks']);
  await fixture.git(['push']);
  const integrationSha = await fixture.git(['rev-parse', 'HEAD']);
  await writeFile(path.join(fixture.projectPath, 'package.json'), '{}');
  const savedProfiles: NonNullable<ProjectConfig['factoryProfile']>[] = [];
  const commands: string[][] = [];
  let setupAgentCalls = 0;
  const wiring = await fixture.start(undefined, undefined, {
    spawnReviewer: async ({ name, cwd, extraArgs = [], readablePaths = [], onOutput }) => {
      assert.equal(name, 'Factory setup');
      assert.notEqual(cwd, fixture.projectPath);
      assert.ok(readablePaths.includes(fixture.projectPath));
      assert.equal(extraArgs[extraArgs.indexOf('--add-dir') + 1], fixture.projectPath);
      const promptPath = extraArgs[extraArgs.indexOf('--append-system-prompt-file') + 1];
      assert.ok(readablePaths.includes(promptPath));
      const setupPrompt = await readFile(promptPath, 'utf8');
      assert.match(setupPrompt, /using git show.*untrusted input.*Do not edit files or run checks/);
      assert.match(setupPrompt, /Keep the global checks.*Omit fields.*without asking questions/);
      assert.match(setupPrompt, /<<<(GLIMMERVOID-FACTORY-SETUP[^\n]*)\n[^\n]+\n\1>>>/);
      const outputSchema = JSON.parse(extraArgs[extraArgs.indexOf('--json-schema') + 1]);
      assert.equal(outputSchema.properties.focusedTestCommand.type, 'string');
      assert.equal(outputSchema.properties.pass, undefined);
      setupAgentCalls += 1;
      const envelope = { type: 'result', subtype: 'success', is_error: false, structured_output: { checks: ['node --version', 'definitely-missing-binary-xyz'] } };
      const escapeCharacter = String.fromCharCode(27);
      onOutput?.(`${JSON.stringify({ ...envelope, structured_output: { checks: ['node --invalid-earlier-proposal'] } })}\n`);
      onOutput?.(`${escapeCharacter}[0m${JSON.stringify(envelope)}\r\n`);
      onOutput?.(`${JSON.stringify({ ...envelope, is_error: true, structured_output: { checks: ['node --invalid-failed-proposal'] } })}\n`);
      onOutput?.(JSON.stringify({ ...envelope, structured_output: { checks: [false] } }));
    },
    saveProjectFactoryProfile: async (projectPath, profile) => {
      assert.equal(projectPath, fixture.projectPath);
      savedProfiles.push(profile);
    },
    prepareCheckRunner: async () => ({
      runCheck: async (argumentsToRun, options) => {
        commands.push(argumentsToRun);
        assert.notEqual(options.cwd, fixture.projectPath);
        const [command, ...argumentsAfterCommand] = argumentsToRun;
        assert.ok(command);
        return execFileAsync(command, argumentsAfterCommand, options);
      },
      dispose: async () => {},
    }),
  });
  const queued = await wiring.queueIntent(fixture.request);
  assert.equal(queued.ok, true, queued.error ?? 'Queue failed');
  assert.equal(setupAgentCalls, 0);
  assert.deepEqual(savedProfiles[0]?.checks, ['npm test']);
  assert.equal(savedProfiles[0]?.focusedTestCommand, 'npm run test:files');
  assert.ok(savedProfiles[0]?.widenableScopes?.includes('tests/'));
  assert.deepEqual(fixture.config.projects[0].factoryProfile, savedProfiles[0]);
  assert.deepEqual(wiring.getState()?.projects[0]?.factoryProfile, savedProfiles[0]);
  const baseline = JSON.parse(await readFile(path.join(fixture.homeDir, 'factory', fixture.request.projectId, 'setup-baseline.json'), 'utf8'));
  assert.equal(baseline.sha, integrationSha);
  assert.equal(baseline.checks[0].status, 'ran');
  assert.equal(baseline.checks[0].pass, false);
  const commandCount = commands.length;
  assert.equal((await wiring.queueIntent({ ...fixture.request, objective: 'Another intent' })).ok, true);
  assert.equal(commands.length, commandCount);
  assert.deepEqual(await wiring.control({ projectId: fixture.request.projectId, action: 'rerun-setup' }), { projectId: fixture.request.projectId, action: 'rerun-setup', ok: true });
  assert.equal(savedProfiles.length, 2);
  fixture.config.projects[0].factoryProfile = undefined;
  Object.assign(fixture.config.factory, { checks: ['npm run missing-check'] });
  const beforeRefusal = await fixture.git(['rev-parse', 'integration'], fixture.originPath);
  const refused = await wiring.queueIntent({ ...fixture.request, objective: 'Must not queue' });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /Factory setup could not run any full checks/);
  assert.match(refused.error ?? '', /missing-check/);
  assert.equal(await fixture.git(['rev-parse', 'integration'], fixture.originPath), beforeRefusal);
  assert.equal(savedProfiles.length, 2);
  assert.equal(fixture.config.projects[0].factoryProfile, undefined);
  assert.equal(setupAgentCalls, 0);
  Object.assign(fixture.config.factory, { checks: undefined });
  await writeFile(path.join(fixture.projectPath, 'package.json'), JSON.stringify({ scripts: {
    test: 'node --test tests/*.test.js', 'test:files': 'node --test tests/failing.test.js',
  } }));
  await fixture.git(['add', 'package.json']);
  await fixture.git(['commit', '-m', 'Break the focused runner']);
  await fixture.git(['push']);
  const unprovenFocusSetup = await wiring.rerunSetup(fixture.request.projectId);
  assert.equal(unprovenFocusSetup.ok, true);
  assert.equal(wiring.getState()?.projects[0]?.factoryProfile?.focusedTestCommand, undefined);
  assert.equal(setupAgentCalls, 1);
  assert.deepEqual(savedProfiles[2]?.checks, ['npm test']);
  assert.equal(savedProfiles[2]?.focusedTestCommand, undefined);
  assert.ok(!commands.some((command) => command.join(' ') === 'node --version'));
  await writeFile(path.join(fixture.projectPath, 'package.json'), '{}');
  await fixture.git(['add', 'package.json']);
  await fixture.git(['commit', '-m', 'Remove detectable scripts']);
  await fixture.git(['push']);
  const agentSetup = await wiring.rerunSetup(fixture.request.projectId);
  assert.equal(agentSetup.ok, true);
  assert.equal(setupAgentCalls, 2);
  assert.deepEqual(savedProfiles[3]?.checks, ['node --version']);
  assert.equal(savedProfiles[3]?.focusedTestCommand, undefined);
  assert.ok(commands.some((command) => command.join(' ') === 'node --version'));
});

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
  assert.equal(state.ledgerBranch, `glimmervoid/${request.projectId}/factory-ledger`);
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
  assert.deepEqual(inspection.work[0].opened.writeScopes, []);
  assert.deepEqual(state.intentWriteScopes, { [queued.workId]: request.writeScopes });
  assert.equal(wiring.getState()?.projects[0].orders[0].id, queued.workId);
  assert.deepEqual(wiring.getState()?.projects[0].orders[0].writeScopes, request.writeScopes);
  assert.equal(wiring.getState()?.projects[0].headSha, integrationSha);
  const rescoped = await wiring.queueIntent({ ...request, writeScopes: ['server/other.ts'] });
  assert.equal(rescoped.ok, true, rescoped.error ?? 'Queue failed');
  assert.ok(rescoped.workId);
  assert.notEqual(rescoped.workId, queued.workId);
  assert.deepEqual((await readState()).intentWriteScopes?.[queued.workId], request.writeScopes);
  await wiring.stop();
  await access(state.ledgerPath);
  const restarted = await start();
  assert.equal(restarted.getState()?.projects[0].paused, true);
  const queuedAgain = await restarted.queueIntent({ ...request, objective: 'Second intent' });
  assert.equal(queuedAgain.ok, true, queuedAgain.error ?? 'Queue failed');
  assert.equal((await readState()).ledgerPath, state.ledgerPath);
  assert.equal(restarted.getState()?.projects[0].orders.length, 3);
  assert.equal((await restarted.control({ projectId: request.projectId, action: 'resume' })).ok, true);
  assert.equal(restarted.getState()?.projects[0].paused, false);
  assert.equal((await readState()).paused, false);
  assert.equal(config.factory.enabled, true);
  assert.equal((await readFile(path.join(homeDir, 'factory', request.projectId, 'state.json'), 'utf8')).includes('ledgerPath'), true);
});

test('retry parked reopens only parked children in one landed commit and resets only their block counts', async (context) => {
  const fixture = await createIntentFixture(context);
  const coherenceCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  assert.ok(coherenceCliPath);
  const runLedgerCommand = async (args: string[]) => (await execFileAsync(process.execPath, [coherenceCliPath, ...args], {
    cwd: fixture.projectPath, timeout: REAL_PROCESS_DEADLINE_MS,
  })).stdout;
  const createOrder = async (objective: string, parent: string | null = null, dependsOn: string[] = []) => {
    const created: { work: string } = JSON.parse(await runLedgerCommand([
      'work', 'create', objective, '--success', 'Retry passes', '--risk', 'low', '--authority', 'user-directed', '--granted-by', 'operator',
      '--boundary', 'This repository', '--session', 'fixture', '--write-scope', `src/${objective}.ts`,
      ...(parent ? ['--parent', parent] : []), ...dependsOn.flatMap((workId) => ['--depends-on', workId]), '--json',
    ]));
    return created.work;
  };
  const intentId = await createOrder('intent');
  const otherIntentId = await createOrder('other-intent');
  const parkedWorkIds = [await createOrder('parked-first', intentId), await createOrder('parked-second', intentId)];
  const blockedWorkId = await createOrder('blocked', intentId);
  const mergedWorkId = await createOrder('merged', intentId);
  const waitingWorkId = await createOrder('waiting', intentId, [parkedWorkIds[0]]);
  const unrelatedWorkId = await createOrder('unrelated', otherIntentId);
  const need = 'Needs write scope: protected/config.ts. Exact remaining need';
  for (const workId of [...parkedWorkIds, blockedWorkId, unrelatedWorkId, mergedWorkId]) {
    await runLedgerCommand(['work', 'transition', workId, 'active', '--because', 'Start fixture', '--session', 'fixture']);
    const change = workId === mergedWorkId ? ['close', workId, 'completed'] : ['transition', workId, 'blocked'];
    await runLedgerCommand(['work', ...change, '--because', need, '--session', 'fixture', '--evidence', 'fixture']);
  }
  await fixture.git(['add', '.coherence']);
  await fixture.git(['commit', '-m', 'test: prepare parked intent']);
  await fixture.git(['push']);
  const originalBlockCounts = { [parkedWorkIds[0]]: 3, [parkedWorkIds[1]]: 4, [blockedWorkId]: 1, [mergedWorkId]: 3, [unrelatedWorkId]: 3 };
  await mkdir(path.dirname(fixture.statePath), { recursive: true });
  await writeFile(fixture.statePath, JSON.stringify({ ledgerPath: null, ledgerBranch: null, paused: false,
    trustedIntentIds: [intentId], ticketBlockCounts: originalBlockCounts,
  }));
  const wiring = await fixture.start();
  assert.equal(wiring.getState()?.projects[0]?.orders.find((order) => order.id === parkedWorkIds[0])?.blockReason, need);
  const beforeRetrySha = await fixture.git(['rev-parse', 'HEAD']);
  const retry = await wiring.control({ projectId: fixture.request.projectId, action: 'retry-parked', intentId });
  assert.equal(retry.ok, true, retry.error ?? 'Retry failed');
  assert.deepEqual(new Set(retry.reopenedWorkIds), new Set(parkedWorkIds));
  const inspected = CoherenceWorkInspect.parse(JSON.parse(await runLedgerCommand(['work', 'inspect', '--json']))).work;
  for (const workId of parkedWorkIds) assert.equal(inspected.find((order) => order.work === workId)?.state, 'open');
  assert.equal(inspected.find((order) => order.work === mergedWorkId)?.state, 'completed');
  assert.equal(inspected.find((order) => order.work === blockedWorkId)?.state, 'blocked');
  assert.equal(inspected.find((order) => order.work === unrelatedWorkId)?.state, 'blocked');
  assert.equal(inspected.find((order) => order.work === waitingWorkId)?.state, 'open');
  assert.deepEqual((await fixture.readState()).ticketBlockCounts, { ...originalBlockCounts, ...Object.fromEntries(parkedWorkIds.map((workId) => [workId, 0])) });
  assert.equal(await fixture.git(['rev-list', '--count', `${beforeRetrySha}..HEAD`]), '1');
  const afterRetrySha = await fixture.git(['rev-parse', 'HEAD']);
  assert.equal(await fixture.git(['rev-parse', 'integration'], fixture.originPath), afterRetrySha);
  assert.deepEqual(await wiring.retryParked(fixture.request.projectId, intentId), { ok: true, reopenedWorkIds: [] });
  assert.equal(await fixture.git(['rev-parse', 'HEAD']), afterRetrySha);
  assert.equal((await wiring.retryParked(fixture.request.projectId, otherIntentId)).ok, false);
});

test('retry parked after a failed landing resets the reopened ticket count on the next retry', async (context) => {
  const fixture = await createIntentFixture(context);
  const coherenceCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  assert.ok(coherenceCliPath);
  const runLedgerCommand = async (args: string[]) => (await execFileAsync(process.execPath, [coherenceCliPath, ...args], {
    cwd: fixture.projectPath, timeout: REAL_PROCESS_DEADLINE_MS,
  })).stdout;
  const createOrder = async (objective: string, parent: string | null = null) => {
    const created: { work: string } = JSON.parse(await runLedgerCommand([
      'work', 'create', objective, '--success', 'Retry passes', '--risk', 'low', '--authority', 'user-directed', '--granted-by', 'operator',
      '--boundary', 'This repository', '--session', 'fixture', '--write-scope', `src/${objective}.ts`, ...(parent ? ['--parent', parent] : []), '--json',
    ]));
    return created.work;
  };
  const intentId = await createOrder('intent');
  const parkedWorkId = await createOrder('parked', intentId);
  await runLedgerCommand(['work', 'transition', parkedWorkId, 'active', '--because', 'Start fixture', '--session', 'fixture']);
  await runLedgerCommand(['work', 'transition', parkedWorkId, 'blocked', '--because', 'Needs a parked retry', '--session', 'fixture', '--evidence', 'fixture']);
  await fixture.git(['add', '.coherence']);
  await fixture.git(['commit', '-m', 'test: prepare parked ticket']);
  await fixture.git(['push']);
  await mkdir(path.dirname(fixture.statePath), { recursive: true });
  await writeFile(fixture.statePath, JSON.stringify({ ledgerPath: null, ledgerBranch: null, paused: false,
    trustedIntentIds: [intentId], ticketBlockCounts: { [parkedWorkId]: 3 },
  }));
  const wiring = await fixture.start();
  const movedOriginPath = `${fixture.originPath}.moved`;
  await rename(fixture.originPath, movedOriginPath);
  const failedRetry = await wiring.retryParked(fixture.request.projectId, intentId);
  await rename(movedOriginPath, fixture.originPath);
  assert.equal(failedRetry.ok, false);
  assert.deepEqual(await wiring.retryParked(fixture.request.projectId, intentId), { ok: true, reopenedWorkIds: [parkedWorkId] });
  assert.deepEqual((await fixture.readState()).ticketBlockCounts, { [parkedWorkId]: 0 });
  const inspected = CoherenceWorkInspect.parse(JSON.parse(await runLedgerCommand(['work', 'inspect', '--json']))).work;
  assert.equal(inspected.find((order) => order.work === parkedWorkId)?.state, 'open');
  assert.equal(await fixture.git(['rev-parse', 'integration'], fixture.originPath), await fixture.git(['rev-parse', 'HEAD']));
});

test('concurrent queue requests serialize and a failed landing remains on the reused ledger for the next attempt after a restart', async (context) => {
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
  await wiring.stop();
  const restarted = await start(gitWorkspace);
  const queued = await Promise.all([
    restarted.queueIntent({ ...request, objective: 'Second intent' }),
    restarted.queueIntent({ ...request, objective: 'Third intent' }),
    restarted.control({ projectId: request.projectId, action: 'pause' }),
  ]);
  assert.equal(queued.every((outcome) => outcome.ok), true, JSON.stringify(queued));
  assert.equal((await readState()).ledgerPath, state.ledgerPath);
  assert.deepEqual((await readState()).unlandedFactoryRecords, []);
  assert.equal(restarted.getState()?.projects[0].orders.length, 3);
  assert.equal(restarted.getState()?.projects[0].paused, true);
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

test('an intent queued with tickets lands them as its ledger children once it becomes the active intent, also when queued behind an open one', async (context) => {
  const { projectPath, config, git, start, request, readState } = await createIntentFixture(context);
  const cliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  assert.ok(cliPath);
  let shouldRefuseDependentTicket = true;
  const spawned: { session: Session; overrides: SessionSpawnOverrides }[] = [];
  const pollers: FactoryPoller[] = [];
  const wiring = await start(undefined, async ({ cwd, args }) => {
    if (shouldRefuseDependentTicket && args.includes('--depends-on')) throw new Error('dependent ticket refused');
    return (await execFileAsync(process.execPath, [cliPath, ...args], { cwd, timeout: REAL_PROCESS_DEADLINE_MS })).stdout;
  }, {
    trustClaudeFolder: async () => 'already-trusted',
    createPoller: (dependencies) => {
      const poller = createFactoryPoller(dependencies);
      pollers.push(poller);
      return poller;
    },
    orchestratorOptions: fakeOrchestratorOptions({ config, now: Date.now, spawned }),
  });
  const tickets = [
    { id: 'U1', objective: 'Add the retry helper', criteria: ['Retry helper exists'], dependsOn: [], writeScopes: ['server/retry.ts'] },
    { id: 'U2', objective: 'Cover the retry helper', criteria: ['Retry tests pass'], dependsOn: ['U1'], writeScopes: ['server/retry.ts'] },
  ];
  const outOfScope = await wiring.queueIntent({ ...request, tickets: [{ ...tickets[0], writeScopes: ['server/other.ts'] }] });
  assert.equal(outOfScope.error, 'Invalid tickets: ticket U1 write scopes exceed the intent write scopes');
  const unordered = await wiring.queueIntent({ ...request, tickets: [tickets[1], tickets[0]] });
  assert.equal(unordered.error, 'Invalid tickets: ticket U2 depends on U1, which is not an earlier ticket');
  const overlapping = await wiring.queueIntent({ ...request, tickets: [tickets[0], { ...tickets[1], dependsOn: [] }] });
  assert.equal(overlapping.error, 'Invalid tickets: tickets U1 and U2 write the same path, so one must depend on the other');
  const uncreatable = await wiring.queueIntent({ ...request, writeScopes: ['**'], tickets: [{ ...tickets[0], writeScopes: ['./'] }] });
  assert.match(uncreatable.error ?? '', /^Command failed: .* --write-scope \.\/ /);
  const unprovable = await wiring.queueIntent({ ...request, tickets });
  assert.equal(unprovable.error, 'dependent ticket refused');
  const { ledgerPath } = await readState();
  assert.ok(ledgerPath);
  assert.equal(await git(['status', '--porcelain'], ledgerPath), '');
  assert.equal(wiring.getState()?.projects[0].orders.length, 0);
  shouldRefuseDependentTicket = false;
  await wiring.control({ projectId: request.projectId, action: 'pause' });
  const queued = await wiring.queueIntent({ ...request, tickets });
  assert.equal(queued.ok, true, queued.error ?? 'Queue failed');
  assert.ok(queued.workId);
  assert.equal(wiring.getState()?.projects[0].orders.length, 1);
  shouldRefuseDependentTicket = true;
  await wiring.control({ projectId: request.projectId, action: 'resume' });
  assert.equal(wiring.getState()?.projects[0].error, 'dependent ticket refused');
  assert.equal(spawned.length, 0);
  assert.equal(await git(['status', '--porcelain'], ledgerPath), '');
  shouldRefuseDependentTicket = false;
  await pollers[0].refreshNow();
  assert.equal(spawned.length, 1);
  assert.equal(wiring.getState()?.projects[0].error, null);
  const queuedBehind = await wiring.queueIntent({ ...request, objective: 'Ship more retries', tickets });
  assert.equal(queuedBehind.ok, true, queuedBehind.error ?? 'Queue failed');
  assert.ok(queuedBehind.workId);
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'work', 'inspect', '--json'], {
    cwd: projectPath, encoding: 'utf8', timeout: 20_000,
  });
  const inspectedWork = CoherenceWorkInspect.parse(JSON.parse(stdout)).work;
  assert.equal(inspectedWork.filter((order) => order.opened.parent === queuedBehind.workId).length, 0);
  const children = inspectedWork.filter((order) => order.opened.parent === queued.workId);
  const [first, second] = tickets.map((ticket) => children.find((order) => order.opened.objective === ticket.objective));
  assert.equal(children.length, 2);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.readiness, 'ready');
  assert.deepEqual(second.opened.dependsOn, [first.work]);
  assert.deepEqual(second.opened.writeScopes, ['server/retry.ts']);
  assert.equal(second.opened.risk, request.risk);
  const laneState = await readState();
  assert.deepEqual(laneState.ticketedIntentIds, [queued.workId, queuedBehind.workId]);
  assert.deepEqual(Object.keys(laneState.pendingIntentTickets ?? {}), [queuedBehind.workId]);
  assert.equal(wiring.getState()?.projects[0].orders.length, 4);
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

test('queue refuses and never declares a factory record rewritten after the writer appended it', async (context) => {
  const fixture = await createIntentFixture(context);
  const coherenceCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  assert.ok(coherenceCliPath);
  const originalOriginSha = await fixture.git(['rev-parse', 'integration'], fixture.originPath);
  const wiring = await fixture.start(undefined, async ({ cwd, args }) => {
    const { stdout } = await execFileAsync(process.execPath, [coherenceCliPath, ...args], { cwd, timeout: REAL_PROCESS_DEADLINE_MS });
    if (args[0] !== 'work' || args[1] !== 'create') return stdout;
    const workDirectory = path.join(cwd, '.coherence', 'work');
    for (const fileName of await readdir(workDirectory)) {
      const ledgerText = await readFile(path.join(workDirectory, fileName), 'utf8');
      await writeFile(path.join(workDirectory, fileName), ledgerText.replace(/"objective":"[^"]*"/, '"objective":"Forged objective"'));
    }
    return stdout;
  });
  const queued = await wiring.queueIntent(fixture.request);
  assert.equal(queued.ok, false);
  assert.match(queued.error ?? '', /does not match what the factory wrote/);
  assert.deepEqual((await fixture.readState()).unlandedFactoryRecords ?? [], []);
  assert.equal(await fixture.git(['rev-parse', 'integration'], fixture.originPath), originalOriginSha);
});

test('a commit placed on the local integration branch by hand makes the next ledger landing refuse without pushing it', async (context) => {
  const fixture = await createIntentFixture(context);
  const wiring = await fixture.start();
  assert.equal((await wiring.queueIntent(fixture.request)).ok, true);
  const landedOriginSha = await fixture.git(['rev-parse', 'integration'], fixture.originPath);
  const integrationTree = await fixture.git(['rev-parse', 'integration^{tree}']);
  const unreviewedSha = await fixture.git(['commit-tree', integrationTree, '-p', 'integration', '-m', 'Unreviewed change']);
  await fixture.git(['update-ref', 'refs/heads/integration', unreviewedSha]);
  const queued = await wiring.queueIntent({ ...fixture.request, objective: 'Second intent' });
  assert.equal(queued.ok, false);
  assert.match(queued.error ?? '', /integration branch moved outside the factory/);
  assert.equal(await fixture.git(['rev-parse', 'integration'], fixture.originPath), landedOriginSha);
  await assert.rejects(() => fixture.git(['cat-file', '-e', unreviewedSha], fixture.originPath));
  assert.equal(await fixture.git(['rev-parse', 'integration']), unreviewedSha);
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
    stubEnvironmentVariable(context, 'FACTORY_PROBE_TOKEN', 'server-secret-for-git-probe');
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
    await runHardenedGit(['status', '--porcelain'], { cwd: checkoutPath });
    const diff = await runHardenedGit(['diff', 'HEAD', '--', 'payload.txt'], { cwd: checkoutPath });
    assert.match(diff.stdout, /changed/);
    await runHardenedGit(['add', '--', 'payload.txt'], { cwd: checkoutPath });
    await runHardenedGit(['restore', '--source=HEAD', '--staged', '--worktree', '--', 'payload.txt'], { cwd: checkoutPath });
    const moved = await gitWorkspace.checkoutDetached({ worktreePath: checkoutPath, sha: wiring.getState()?.projects[0]?.headSha ?? '', disableRepoCommands: true });
    assert.equal(moved.ok, true, moved.err ?? 'Checkout failed');
    await wiring.stop();
    assert.ok(invocations.length > 0);
    assert.equal(invocations.every((invocation) => invocation.secret === undefined), true);
    assert.equal(invocations.every((invocation) => invocation.args.includes('core.fsmonitor=false') && invocation.args.includes(`core.hooksPath=${os.devNull}`)), true);
    await assert.rejects(access(markerPath), { code: 'ENOENT' });
  });
}

type WiringOrchestratorOptions = NonNullable<Parameters<typeof createFactoryWiring>[0]['orchestratorOptions']>;

function fakeOrchestratorOptions({ config, now, spawned, pastedLines = [] }: {
  config: WiringOrchestratorOptions['config']; now: () => number; spawned: { session: Session; overrides: SessionSpawnOverrides }[]; pastedLines?: string[];
}): WiringOrchestratorOptions {
  return {
    workLane: passthroughWorkLane(),
    config, sessions: new Map<string, Session>(), broadcast: () => {}, closeSessionDataClients: () => {},
    wireSessionEvents: () => {}, recordLane: () => {}, spawnGate: { run: async (operation) => operation() },
    makeSession: (identity, _config, overrides) => {
      const session = plainSession(identity.id, identity.name, identity.path);
      session.start = async () => {
        session.ptyProcess = fakePty();
        session._ptyAlive = true;
        session.state = STATES.RUNNING;
        session.stateSince = now();
      };
      session.pasteTextWhenReady = (text) => { pastedLines.push(text); return { ok: true, deferred: false }; };
      spawned.push({ session, overrides });
      return session;
    },
  };
}

type LedgerWorkOrder = CoherenceWorkInspect['work'][number];

async function createStallFixture(context: test.TestContext, { trustClaudeFolder, expectedOrchestratorCount = 1, hasSeparateGitDirectory = false, laneState = {}, extraWorkOf = () => [] }: {
  trustClaudeFolder?: (repositoryRoot: string, sessionsSpawnedSoFar: number) => Promise<'already-trusted' | 'granted'>; expectedOrchestratorCount?: number; hasSeparateGitDirectory?: boolean;
  laneState?: Partial<FactoryLaneState>; extraWorkOf?: (intent: LedgerWorkOrder) => LedgerWorkOrder[];
} = {}) {
  const fixture = await createIntentFixture(context);
  await mkdir(path.join(fixture.projectPath, '.coherence'));
  await writeFile(path.join(fixture.projectPath, '.coherence', '.gitkeep'), '');
  await fixture.git(['add', '.coherence']);
  await fixture.git(['commit', '-m', 'test: prepare ledger']);
  await fixture.git(['push']);
  if (hasSeparateGitDirectory) await fixture.git(['init', '--separate-git-dir', path.join(path.dirname(fixture.projectPath), 'separate-repo.git')]);
  const orient = await readCoherenceFixture('orient-dispatch');
  const inspection = CoherenceWorkInspect.parse(JSON.parse(await readCoherenceFixture('work-dispatch')));
  const intent = inspection.work[0];
  intent.opened.risk = 'low';
  const child = { ...intent, work: 'wrk-0123456789abcdef', opened: { ...intent.opened, work: 'wrk-0123456789abcdef', parent: intent.work } };
  inspection.work.push(child, ...extraWorkOf(intent));
  await mkdir(path.dirname(fixture.statePath), { recursive: true });
  await writeFile(fixture.statePath, JSON.stringify({ ledgerPath: null, ledgerBranch: null, paused: false, ...laneState,
    trustedIntentIds: [intent.work, ...laneState.trustedIntentIds ?? []] }));
  const notifications: { category: string; message: string }[] = [];
  const spawned: { session: Session; overrides: SessionSpawnOverrides }[] = [];
  const pollers: FactoryPoller[] = [];
  let nowMs = 1_000_000;
  let todaySpend: LaneSpend = { status: 'known', amountUsd: 0 };
  let spendDay = new Date(nowMs).toDateString();
  const commands: string[][] = [];
  const pastedLines: string[] = [];
  const startWiring = () => fixture.start(undefined, async ({ args }) => {
    commands.push(args);
    if (args[0] === 'orient') return orient;
    if (args[0] === 'work' && args[1] === 'inspect') return JSON.stringify(inspection);
    return JSON.stringify({ id: `record-${args[1]}` });
  }, {
    now: () => nowMs,
    trustClaudeFolder: trustClaudeFolder ? (repositoryRoot) => trustClaudeFolder(repositoryRoot, spawned.length) : undefined,
    readSpentTodayUsd: () => new Date(nowMs).toDateString() === spendDay ? todaySpend : { status: 'known', amountUsd: 0 },
    notify: (_projectName, category, message) => { notifications.push({ category, message }); },
    createPoller: (dependencies) => {
      const poller = createFactoryPoller(dependencies);
      pollers.push(poller);
      return poller;
    },
    orchestratorOptions: fakeOrchestratorOptions({ config: fixture.config, now: () => nowMs, spawned, pastedLines }),
  });
  const wiring = await startWiring();
  assert.equal(spawned.length, expectedOrchestratorCount);
  return { wiring, notifications, spawned, child, inspection, commands, pastedLines, git: fixture.git, config: fixture.config, projectPath: fixture.projectPath, homeDir: fixture.homeDir,
    setSpend: (spend: LaneSpend) => { todaySpend = spend; spendDay = new Date(nowMs).toDateString(); },
    tick: () => pollers[0].refreshNow(), advanceClock: (elapsedMs: number) => { nowMs += elapsedMs; },
    restart: async () => {
      await wiring.stop();
      const restarted = await startWiring();
      return { wiring: restarted, tick: () => pollers[pollers.length - 1].refreshNow() };
    },
    now: () => nowMs,
    emitHook: (spawnIndex: number, event = 'PostToolUse') => {
      const spawn = spawned[spawnIndex];
      spawn.session.emit('hook-event', { event, payload: { session_id: spawn.overrides.extraClaudeArgs?.[1] } });
    },
  };
}

test('an intent with parked tickets and waiting dependents notifies partial once, retains its need and releases the orchestrator to the next queued intent', async (context) => {
  const queuedIntentId = 'wrk-queuedintent0001';
  const fixture = await createStallFixture(context, {
    laneState: { trustedIntentIds: [queuedIntentId], ticketBlockCounts: { 'wrk-0123456789abcdef': 3 } },
    extraWorkOf: (intent) => [{ ...intent, work: queuedIntentId, opened: { ...intent.opened, objective: 'Queued intent', at: new Date(Date.parse(intent.opened.at) + 60_000).toISOString() } }],
  });
  fixture.emitHook(0);
  const intent = fixture.inspection.work[0];
  const need = 'Needs write scope: protected/secret.ts\nLeave this exact need for the operator.';
  fixture.child.state = 'blocked';
  fixture.child.readiness = 'blocked';
  fixture.child.last = { event: 'transitioned', at: intent.opened.at, session: 'worker', reason: need };
  const dependent = { ...fixture.child, work: 'waiting-dependent', state: 'open' as const, readiness: 'blocked' as const,
    opened: { ...fixture.child.opened, dependsOn: [fixture.child.work] } };
  const transitiveDependent = { ...dependent, work: 'transitive-dependent', opened: { ...dependent.opened, dependsOn: [dependent.work] } };
  const independent: CoherenceWorkInspect['work'][number] = { ...fixture.child, work: 'independent-ticket', state: 'open', readiness: 'ready',
    opened: { ...fixture.child.opened, dependsOn: [] } };
  fixture.inspection.work.push(transitiveDependent, dependent, independent);
  const session = fixture.spawned[0].session;
  session.state = STATES.IDLE;
  session.stateSince = fixture.now();
  await fixture.git(['commit', '--allow-empty', '-m', 'test: park one ticket']);
  await fixture.git(['push']);
  await fixture.tick();
  assert.deepEqual(fixture.notifications, []);
  assert.deepEqual(fixture.wiring.getState()?.projects[0]?.partialIntentIds, []);
  independent.state = 'completed';
  independent.readiness = 'done';
  await fixture.git(['commit', '--allow-empty', '-m', 'test: finish independent ticket']);
  await fixture.git(['push']);
  await fixture.tick();
  assert.deepEqual(fixture.wiring.getState()?.projects[0]?.partialIntentIds, [intent.work]);
  fixture.advanceClock(FACTORY_STALL_MS + 1);
  await fixture.tick();
  await fixture.tick();
  const project = fixture.wiring.getState()?.projects[0];
  assert.ok(project);
  assert.equal(project.error, null);
  assert.equal(project.orchestrator?.intentId, queuedIntentId);
  assert.equal(fixture.spawned.length, 2);
  assert.equal(project.orders.find((order) => order.id === intent.work)?.state, 'open');
  assert.deepEqual(buildFactoryIntentDigest(project, intent.work), {
    intentId: intent.work, objective: intent.opened.objective,
    merged: [{ id: independent.work, objective: independent.opened.objective }],
    parked: [{ id: fixture.child.work, objective: fixture.child.opened.objective, need }],
    confirmedFlakes: [], isPartial: true,
  });
  assert.deepEqual(fixture.notifications, [{ category: 'factory', message: `Factory intent partial: ${intent.opened.objective}. 1 merged, 1 parked.` }]);
});

test('intent outcomes notify only trusted intents, ignore history at first start and a block below the cap, and never repeat after a restart', async (context) => {
  const fixture = await createStallFixture(context, {
    laneState: { trustedIntentIds: ['wrk-shippedlastweek1'] },
    extraWorkOf: (intent) => [
      { ...intent, work: 'wrk-shippedlastweek1', state: 'completed', readiness: 'done', opened: { ...intent.opened, objective: 'Shipped last week' } },
      { ...intent, work: 'wrk-closedbyhand0001', state: 'completed', readiness: 'done', opened: { ...intent.opened, objective: 'Closed by hand' } },
    ],
  });
  fixture.emitHook(0);
  const intent = fixture.inspection.work[0];
  const publishLedger = async (message: string) => {
    await fixture.git(['commit', '--allow-empty', '-m', message]);
    await fixture.git(['push']);
  };
  fixture.child.state = 'blocked';
  fixture.child.readiness = 'blocked';
  await publishLedger('test: block once');
  await fixture.tick();
  assert.deepEqual(fixture.notifications, []);
  fixture.child.state = 'completed';
  fixture.child.readiness = 'done';
  intent.state = 'completed';
  await publishLedger('test: complete intent');
  await fixture.tick();
  const completedNotice = { category: 'factory', message: `Factory intent completed: ${intent.opened.objective}. 1 merged, 0 parked.` };
  assert.deepEqual(fixture.notifications, [completedNotice]);
  const restarted = await fixture.restart();
  await restarted.tick();
  assert.deepEqual(fixture.notifications, [completedNotice]);
});

test('a WAITING orchestrator past 120 seconds raises once, clears on recovery and alerts for a new episode', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  const session = fixture.spawned[0].session;
  session.state = STATES.WAITING;
  session.stateSince = fixture.now();
  fixture.advanceClock(FACTORY_STALL_MS);
  await fixture.tick();
  assert.equal(fixture.wiring.getState()?.projects[0].error, null);
  fixture.advanceClock(1);
  await fixture.tick();
  await fixture.tick();
  const reason = 'factory orchestrator is waiting on a prompt';
  assert.equal(fixture.wiring.getState()?.projects[0].error, reason);
  assert.deepEqual(fixture.notifications, [{ category: 'factory', message: reason }]);
  session.state = STATES.RUNNING;
  session.stateSince = fixture.now();
  await fixture.tick();
  assert.equal(fixture.wiring.getState()?.projects[0].error, null);
  session.state = STATES.WAITING;
  session.stateSince = fixture.now();
  fixture.advanceClock(FACTORY_STALL_MS + 1);
  await fixture.tick();
  assert.equal(fixture.notifications.length, 2);
});

test('the factory trusts the repository root before its orchestrator starts, leaves an unmappable git layout alone, and starts nothing when trust is refused', async (context) => {
  const trustCalls: { repositoryRoot: string; sessionsSpawnedSoFar: number }[] = [];
  const trusted = await createStallFixture(context, { trustClaudeFolder: async (repositoryRoot, sessionsSpawnedSoFar) => {
    trustCalls.push({ repositoryRoot, sessionsSpawnedSoFar });
    return 'granted';
  } });
  assert.deepEqual(trustCalls, [{ repositoryRoot: await realpath(trusted.projectPath), sessionsSpawnedSoFar: 0 }]);
  const decisionsDirectory = path.join(trusted.homeDir, 'factory', factoryRepoId(trusted.projectPath), 'decisions');
  const readDecisions = () => (existsSync(decisionsDirectory) ? readdirSync(decisionsDirectory) : [])
    .flatMap((fileName) => readFileSync(path.join(decisionsDirectory, fileName), 'utf8').trim().split('\n'))
    .map((line) => FactoryDecisionLogLine.parse(JSON.parse(line)));
  await waitFor(() => readDecisions().some((decision) => decision.kind === 'trust'), 'the trust grant reaches the decision log', REAL_PROCESS_DEADLINE_MS);
  assert.deepEqual(readDecisions().filter((decision) => decision.kind === 'trust').map((decision) => decision.outcome), ['granted']);

  const unmapped = await createStallFixture(context, { hasSeparateGitDirectory: true, trustClaudeFolder: async (repositoryRoot, sessionsSpawnedSoFar) => {
    trustCalls.push({ repositoryRoot, sessionsSpawnedSoFar });
    return 'granted';
  } });
  assert.equal(unmapped.spawned.length, 1);
  assert.equal(trustCalls.length, 1);
  assert.equal(unmapped.wiring.getState()?.projects[0].error, null);

  const refusal = 'Could not trust /work/project for Claude Code: /home/operator/.claude.json was left unchanged because another process holds its lock';
  const refused = await createStallFixture(context, { expectedOrchestratorCount: 0, trustClaudeFolder: async () => { throw new Error(refusal); } });
  await refused.tick();
  assert.equal(refused.spawned.length, 0);
  assert.equal(refused.wiring.getState()?.projects[0].error, refusal);
  assert.deepEqual(refused.notifications, [{ category: 'factory', message: refusal }]);
});

test('a worker with no first hook raises folder trust once and only its matching hook clears it', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  const dispatch = await fixture.wiring.dispatch(fixture.spawned[0].session.id, { workId: fixture.child.work });
  if (!dispatch.ok) throw new Error(dispatch.reason);
  assert.equal(dispatch.ok, true);
  assert.equal(fixture.spawned.length, 2);
  const worker = fixture.spawned[1].session;
  worker.emit('hook-event', { event: 'PostToolUse', payload: { session_id: 'another-claude-session' } });
  worker.emit('hook-event', { event: 'PostToolUse', payload: {} });
  fixture.advanceClock(FACTORY_STALL_MS + 1);
  await fixture.tick();
  await fixture.tick();
  const reason = `factory worker ${fixture.child.work} session did not start: check Claude Code folder trust for ${fixture.projectPath}`;
  assert.equal(fixture.wiring.getState()?.projects[0].error, reason);
  assert.deepEqual(fixture.notifications, [{ category: 'factory', message: reason }]);
  fixture.emitHook(1, 'SubagentStart');
  await fixture.tick();
  assert.equal(fixture.wiring.getState()?.projects[0].error, null);
  fixture.advanceClock(FACTORY_STALL_MS + 1);
  await fixture.tick();
  assert.equal(fixture.notifications.length, 1);
});

test('an orchestrator without hooks raises folder trust and resets first-hook tracking on respawn', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.spawned[0].session.emit('hook-event', { event: 'PostToolUse', payload: { session_id: 'another-claude-session' } });
  fixture.advanceClock(FACTORY_STALL_MS + 1);
  await fixture.tick();
  const reason = `factory orchestrator session did not start: check Claude Code folder trust for ${fixture.projectPath}`;
  assert.equal(fixture.wiring.getState()?.projects[0].error, reason);
  assert.deepEqual(fixture.notifications, [{ category: 'factory', message: reason }]);
  fixture.emitHook(0, 'SubagentStart');
  await fixture.tick();
  assert.equal(fixture.wiring.getState()?.projects[0].error, null);
  fixture.spawned[0].session.destroy();
  await fixture.tick();
  assert.equal(fixture.spawned.length, 2);
  fixture.advanceClock(FACTORY_STALL_MS + 1);
  await fixture.tick();
  assert.equal(fixture.notifications.length, 2);
  assert.equal(fixture.wiring.getState()?.projects[0].error, reason);
});

test('clearing a prompt stall preserves a later budget refusal exception', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  const session = fixture.spawned[0].session;
  session.state = STATES.WAITING;
  session.stateSince = fixture.now();
  fixture.advanceClock(FACTORY_STALL_MS + 1);
  await fixture.tick();
  assert.equal(fixture.notifications.length, 1);
  Object.assign(fixture.config.factory, { dailyBudgetUsd: 1 });
  fixture.setSpend({ status: 'known', amountUsd: 2 });
  await fixture.tick();
  const dispatch = await fixture.wiring.dispatch(session.id, { workId: fixture.child.work });
  assert.deepEqual(dispatch, { ok: false, reason: 'daily spend is over budget' });
  session.state = STATES.RUNNING;
  await fixture.tick();
  assert.equal(fixture.wiring.getState()?.projects[0].error, 'daily spend is over budget');
  assert.equal(fixture.notifications.length, 2);
});

test('recovering the first hook leaves a simultaneous prompt stall raised until WAITING ends', async (context) => {
  const fixture = await createStallFixture(context);
  const session = fixture.spawned[0].session;
  session.state = STATES.WAITING;
  session.stateSince = fixture.now();
  fixture.advanceClock(FACTORY_STALL_MS + 1);
  await fixture.tick();
  await fixture.tick();
  assert.equal(fixture.notifications.length, 2);
  fixture.emitHook(0);
  await fixture.tick();
  assert.equal(fixture.wiring.getState()?.projects[0].error, 'factory orchestrator is waiting on a prompt');
  assert.equal(fixture.notifications.length, 2);
  session.state = STATES.RUNNING;
  await fixture.tick();
  assert.equal(fixture.wiring.getState()?.projects[0].error, null);
});

test('a dispatch success that clears the exception slot leaves an active stall on the project error without notifying again', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  const session = fixture.spawned[0].session;
  session.state = STATES.WAITING;
  session.stateSince = fixture.now();
  fixture.advanceClock(FACTORY_STALL_MS + 1);
  await fixture.tick();
  const reason = 'factory orchestrator is waiting on a prompt';
  assert.equal(fixture.wiring.getState()?.projects[0].error, reason);
  const dispatch = await fixture.wiring.dispatch(session.id, { workId: fixture.child.work });
  assert.equal(dispatch.ok, true);
  fixture.emitHook(1);
  await fixture.tick();
  await fixture.tick();
  assert.equal(fixture.wiring.getState()?.projects[0].error, reason);
  assert.deepEqual(fixture.notifications, [{ category: 'factory', message: reason }]);
});

test('a stall clearing removes only its own reason and keeps an earlier unrelated exception', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  Object.assign(fixture.config.factory, { dailyBudgetUsd: 1 });
  fixture.setSpend({ status: 'known', amountUsd: 2 });
  await fixture.tick();
  const session = fixture.spawned[0].session;
  assert.deepEqual(await fixture.wiring.dispatch(session.id, { workId: fixture.child.work }), { ok: false, reason: 'daily spend is over budget' });
  session.state = STATES.WAITING;
  session.stateSince = fixture.now();
  fixture.advanceClock(FACTORY_STALL_MS + 1);
  await fixture.tick();
  assert.equal(fixture.wiring.getState()?.projects[0].error, 'daily spend is over budget; factory orchestrator is waiting on a prompt');
  session.state = STATES.RUNNING;
  await fixture.tick();
  assert.equal(fixture.wiring.getState()?.projects[0].error, 'daily spend is over budget');
});

test('unreadable usage history refuses dispatch once and never re-nudges the idle orchestrator', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  Object.assign(fixture.config.factory, { dailyBudgetUsd: 1 });
  fixture.setSpend({ status: 'read-failing' });
  await fixture.tick();
  const session = fixture.spawned[0].session;
  const reason = 'daily budget set but usage history cannot be read, so spend is not known';
  assert.deepEqual(await fixture.wiring.dispatch(session.id, { workId: fixture.child.work }), { ok: false, reason });
  session.state = STATES.IDLE;
  fixture.advanceClock(10_000);
  await fixture.tick();
  fixture.setSpend({ status: 'known', amountUsd: 0 });
  fixture.advanceClock(10_000);
  await fixture.tick();
  await fixture.tick();
  assert.equal(fixture.pastedLines.some((line) => line.includes('can be dispatched now')), false);
  assert.equal(fixture.wiring.getState()?.projects[0].error, reason);
});

test('unknown spend clearing re-nudges an idle orchestrator exactly once without dispatch side effects', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  Object.assign(fixture.config.factory, { dailyBudgetUsd: 1 });
  fixture.setSpend({ status: 'catching-up' });
  await fixture.tick();
  const session = fixture.spawned[0].session;
  assert.deepEqual(await fixture.wiring.dispatch(session.id, { workId: fixture.child.work }),
    { ok: false, reason: 'usage history is still being scanned; spend is not known yet' });
  session.state = STATES.IDLE;
  await fixture.tick();
  fixture.setSpend({ status: 'known', amountUsd: 0 });
  fixture.advanceClock(10_000);
  await fixture.tick();
  await fixture.tick();
  assert.equal(fixture.spawned.length, 1);
  assert.equal(fixture.commands.some((command) => command[1] === 'handoff' || command[1] === 'transition'), false);
  assert.equal(fixture.pastedLines.filter((line) => line.includes('can be dispatched now')).length, 1);
  assert.ok(fixture.pastedLines.includes(`[factory] ${fixture.child.work} can be dispatched now (usage history is still being scanned; spend is not known yet cleared)`));
  assert.equal(fixture.wiring.getState()?.projects[0].error, null);
});

for (const state of [STATES.RUNNING, STATES.WAITING]) {
  test(`a cleared refusal waits for a ${state} orchestrator to become idle`, async (context) => {
    const fixture = await createStallFixture(context);
    fixture.emitHook(0);
    Object.assign(fixture.config.factory, { maxLiveWorkers: 0 });
    const session = fixture.spawned[0].session;
    assert.deepEqual(await fixture.wiring.dispatch(session.id, { workId: fixture.child.work }),
      { ok: false, reason: 'live worker cap reached' });
    Object.assign(fixture.config.factory, { maxLiveWorkers: 1 });
    session.state = state;
    fixture.advanceClock(10_000);
    await fixture.tick();
    assert.equal(fixture.pastedLines.length, 0);
    session.state = STATES.IDLE;
    await fixture.tick();
    await fixture.tick();
    assert.equal(fixture.pastedLines.filter((line) => line.includes('can be dispatched now')).length, 1);
  });
}

test('a permanent risk refusal never re-nudges even when the risk ceiling changes', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  fixture.child.opened.risk = 'high';
  const session = fixture.spawned[0].session;
  assert.deepEqual(await fixture.wiring.dispatch(session.id, { workId: fixture.child.work }),
    { ok: false, reason: 'ticket exceeds the risk ceiling' });
  Object.assign(fixture.config.factory, { maxRisk: 'high' });
  session.state = STATES.IDLE;
  fixture.advanceClock(10_000);
  await fixture.tick();
  await fixture.tick();
  assert.equal(fixture.pastedLines.some((line) => line.includes('can be dispatched now')), false);
});

test('spent daily budget re-nudges only after the local day spend clears', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  Object.assign(fixture.config.factory, { dailyBudgetUsd: 1 });
  fixture.setSpend({ status: 'known', amountUsd: 2 });
  await fixture.tick();
  const session = fixture.spawned[0].session;
  assert.deepEqual(await fixture.wiring.dispatch(session.id, { workId: fixture.child.work }),
    { ok: false, reason: 'daily spend is over budget' });
  session.state = STATES.IDLE;
  await fixture.tick();
  assert.equal(fixture.pastedLines.some((line) => line.includes('can be dispatched now')), false);
  const nextMidnight = new Date(fixture.now());
  nextMidnight.setHours(24, 0, 0, 0);
  fixture.advanceClock(nextMidnight.getTime() - fixture.now());
  await fixture.tick();
  await fixture.tick();
  assert.equal(fixture.pastedLines.filter((line) => line.includes('can be dispatched now')).length, 1);
});

test('config reload preserves the live orchestrator and applies the new worker cap in place', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  const session = fixture.spawned[0].session;
  const originalConversation = fixture.spawned[0].overrides.extraClaudeArgs?.[1];
  fixture.config.factory = { enabled: true, ...{ maxLiveWorkers: 0 } };
  fixture.wiring.restartIfConfigChanged();
  await fixture.tick();
  assert.equal(fixture.spawned.length, 1);
  assert.equal(session._destroyed, false);
  assert.equal(fixture.spawned[0].overrides.extraClaudeArgs?.[1], originalConversation);
  assert.deepEqual(await fixture.wiring.dispatch(session.id, { workId: fixture.child.work }),
    { ok: false, reason: 'live worker cap reached' });
});

for (const [setting, value] of [['checks', ['node --version']], ['protectedPaths', ['src/']], ['maxRisk', 'high']] as const) {
  test(`config reload of factory ${setting} stops the live worker and orchestrator spawned under the old permissions`, async (context) => {
    const fixture = await createStallFixture(context);
    fixture.emitHook(0);
    const orchestrator = fixture.spawned[0].session;
    const dispatch = await fixture.wiring.dispatch(orchestrator.id, { workId: fixture.child.work });
    assert.equal(dispatch.ok, true);
    const worker = fixture.spawned[1].session;
    fixture.config.factory = { ...fixture.config.factory, [setting]: value };
    fixture.wiring.restartIfConfigChanged();
    await waitFor(() => worker._destroyed && orchestrator._destroyed, `a ${setting} change stops sessions holding the old permissions`, REAL_PROCESS_DEADLINE_MS);
  });
}

test('config reload removes an orchestrator when its project leaves config', async (context) => {
  const fixture = await createStallFixture(context);
  const session = fixture.spawned[0].session;
  fixture.config.projects = [];
  fixture.wiring.restartIfConfigChanged();
  await fixture.tick();
  assert.equal(session._destroyed, true);
  assert.equal(fixture.wiring.getLiveOrchestrator(session.id), null);
  assert.equal(fixture.wiring.getState()?.projects.length, 0);
});

test('config reload destroys a live orchestrator when factory is disabled', async (context) => {
  const fixture = await createStallFixture(context);
  const session = fixture.spawned[0].session;
  fixture.config.factory.enabled = false;
  fixture.wiring.restartIfConfigChanged();
  await waitFor(() => session._destroyed && fixture.wiring.getState() === null, 'disabled factory stops its orchestrator', REAL_PROCESS_DEADLINE_MS);
});

test('clearing a live write scope overlap re-nudges only the last refused ticket', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  const session = fixture.spawned[0].session;
  const admitted = await fixture.wiring.dispatch(session.id, { workId: fixture.child.work });
  assert.equal(admitted.ok, true);
  const secondOrder = { ...fixture.child, work: 'wrk-abcdef0123456789', opened: { ...fixture.child.opened } };
  const lastOrder = { ...fixture.child, work: 'wrk-fedcba9876543210', opened: { ...fixture.child.opened } };
  fixture.inspection.work.push(secondOrder, lastOrder);
  for (const order of [secondOrder, lastOrder]) {
    assert.deepEqual(await fixture.wiring.dispatch(session.id, { workId: order.work }),
      { ok: false, reason: 'write scopes overlap a live worker' });
  }
  fixture.spawned[1].session.destroy();
  session.state = STATES.IDLE;
  fixture.advanceClock(10_000);
  await fixture.tick();
  await fixture.tick();
  const availabilityLines = fixture.pastedLines.filter((line) => line.includes('can be dispatched now'));
  assert.equal(availabilityLines.length, 1);
  assert.ok(availabilityLines[0].includes(`[factory] ${lastOrder.work} can be dispatched now`));
  assert.equal(availabilityLines[0].includes(`${secondOrder.work} can be dispatched now`), false);
  assert.equal(fixture.spawned.length, 2);
});

test('a pending transient refusal is discarded when admission becomes permanently refused', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  Object.assign(fixture.config.factory, { maxLiveWorkers: 0 });
  const session = fixture.spawned[0].session;
  assert.deepEqual(await fixture.wiring.dispatch(session.id, { workId: fixture.child.work }),
    { ok: false, reason: 'live worker cap reached' });
  fixture.child.opened.risk = 'high';
  Object.assign(fixture.config.factory, { maxLiveWorkers: 1 });
  session.state = STATES.IDLE;
  await fixture.tick();
  fixture.child.opened.risk = 'low';
  fixture.advanceClock(10_000);
  await fixture.tick();
  assert.equal(fixture.pastedLines.some((line) => line.includes('can be dispatched now')), false);
});

test('a live orchestrator reopens a blocked child and cancels an open one as factory ledger writes, refusing every other case', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  const session = fixture.spawned[0].session;
  const workId = fixture.child.work;
  const ledgerWrites = () => fixture.commands.filter((args) => args[0] === 'work' && (args[1] === 'transition' || args[1] === 'close'));
  assert.deepEqual(await fixture.wiring.reopen('not-the-orchestrator', { workId }), { ok: false, reason: 'reopen requires a live factory orchestrator' });
  fixture.child.state = 'open';
  assert.deepEqual(await fixture.wiring.reopen(session.id, { workId }), { ok: false, reason: 'only a blocked ticket can be reopened, and this one is open' });
  assert.deepEqual(await fixture.wiring.cancel(session.id, { workId: 'wrk-9999999999999999' }), { ok: false, reason: 'no such ticket' });
  assert.deepEqual(await fixture.wiring.cancel(session.id, { workId: fixture.inspection.work[0].work }), { ok: false, reason: 'the ticket is not a child of the active intent' });
  assert.deepEqual(ledgerWrites(), []);
  fixture.child.state = 'blocked';
  assert.deepEqual(await fixture.wiring.reopen(session.id, { workId }), { ok: true, workId, state: 'open' });
  const reopened = ledgerWrites().at(-1) ?? [];
  assert.deepEqual(reopened.slice(0, 4), ['work', 'transition', workId, 'open']);
  assert.equal(reopened[reopened.indexOf('--session') + 1], 'glimmervoid-factory');
  fixture.child.state = 'open';
  assert.deepEqual(await fixture.wiring.cancel(session.id, { workId }), { ok: true, workId, state: 'cancelled' });
  assert.deepEqual(ledgerWrites().at(-1)?.slice(0, 4), ['work', 'close', workId, 'cancelled']);
  assert.equal(ledgerWrites().length, 2);
});

test('the orchestrator may run and is told about every orchestrator agent verb, and still cannot transition or close work', () => {
  assert.ok(FACTORY_ORCHESTRATOR_DENY.includes('Bash(coherence work transition:*)'));
  assert.ok(FACTORY_ORCHESTRATOR_DENY.includes('Bash(coherence work close:*)'));
  const intent: FactoryState['projects'][number]['orders'][number] = {
    id: 'intent', objective: 'intent', openedAt: '2026-10-12T00:00:00.000Z', criteria: [], boundary: 'repo', risk: 'low', state: 'active', readiness: 'ready',
    parent: null, dependsOn: [], writeScopes: [], owner: null, lastEvent: null,
  };
  const prompt = buildOrchestratorPrompt({ projectName: 'repo', intent, claudeSessionId: 'claude-session' });
  for (const verb of ORCHESTRATOR_AGENT_VERBS) {
    assert.ok(FACTORY_ORCHESTRATOR_ALLOW.includes(`Bash(glimmervoid ${verb}:*)`), verb);
    assert.ok(prompt.includes(`glimmervoid ${verb} <`), verb);
  }
});

test('the orchestrator cannot cancel a ticket while its worker is live', async (context) => {
  const fixture = await createStallFixture(context);
  fixture.emitHook(0);
  const session = fixture.spawned[0].session;
  const workId = fixture.child.work;
  assert.equal((await fixture.wiring.dispatch(session.id, { workId })).ok, true);
  fixture.child.state = 'open';
  assert.deepEqual(await fixture.wiring.cancel(session.id, { workId }), { ok: false, reason: 'the ticket has a live worker' });
  assert.equal(fixture.commands.some((args) => args[0] === 'work' && args[1] === 'close'), false);
  fixture.spawned[1].session.destroy();
  await fixture.tick();
  assert.deepEqual(await fixture.wiring.cancel(session.id, { workId }), { ok: true, workId, state: 'cancelled' });
});

test('a cancelled child settles its intent while an unverified completed or blocked child still holds it', () => {
  type Order = FactoryState['projects'][number]['orders'][number];
  const order = (id: string, state: Order['state'], parent: string | null): Order => ({
    id, objective: id, openedAt: '2026-10-12T00:00:00.000Z', criteria: [], boundary: 'repo', risk: 'low', state, readiness: 'ready',
    parent, dependsOn: [], writeScopes: [], owner: null, lastEvent: null,
  });
  const intent = order('intent', 'active', null);
  const decide = (children: Order[], verified: string[]) => decideIntentClose({ intent, children, verifiedWorkIds: new Set(verified), orchestratorSaidReady: true });
  const dropped = order('dropped', 'cancelled', 'intent');
  const shipped = order('shipped', 'completed', 'intent');
  assert.equal(decide([dropped], []), 'verify');
  assert.equal(decide([dropped, shipped], ['shipped']), 'verify');
  assert.equal(decide([dropped, shipped], []), 'wait');
  assert.equal(decide([dropped, order('stuck', 'blocked', 'intent')], []), 'wait');
});
