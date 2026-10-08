import assert from 'node:assert/strict';
import { access, appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileAsync } from '../server/child-process-safe.ts';
import { createFactoryPoller } from '../server/factory-poller.ts';
import type { FactoryPoller } from '../server/factory-poller.ts';
import { createFactoryWiring } from '../server/factory-wiring.ts';
import { resolvePackageBin } from '../server/runtime-paths.ts';
import type { FactoryState } from '../shared/contracts/factory.ts';
import { waitFor } from './helpers/wait-for.ts';

test('factory wiring is disabled until explicitly enabled and hides state after disabling', async (context) => {
  const config = { factory: { enabled: false }, projects: [] };
  const pollers: FactoryPoller[] = [];
  const wiring = createFactoryWiring({
    config, broadcast: () => {}, listFactoryProjects: () => [], firstTickDelayMs: () => 0,
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
  assert.equal(wiring.getState(), null);
  config.factory.enabled = true;
  wiring.restartIfConfigChanged();
  await waitFor(() => wiring.getState() !== null, 'enabled factory reads its first state');
  assert.equal(pollers.length, 1);
  wiring.restartIfConfigChanged();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pollers.length, 1);
  config.factory.enabled = false;
  wiring.restartIfConfigChanged();
  await waitFor(() => wiring.getState() === null, 'disabled factory hides its state');
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
