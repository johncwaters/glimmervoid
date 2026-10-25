import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import pty from 'node-pty';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { glimmervoidHomeDir } from '../server/config-store.ts';
import { workRole } from '../server/guardrails/core/guardrails-roles-core.ts';
import { prepareGuardrailsLaunch, pruneLeftoverSessionTempFolders, sweepOrphanedGuardrailsLaunches } from '../server/guardrails/guardrails-launch.ts';

async function launchLockedCheckout(checkout: string, launchId: string) {
  const prepared = await prepareGuardrailsLaunch({ role: workRole({ vendor: 'claude', cwd: checkout, checkout, agentSessionId: null, readablePaths: [] }), launchId });
  assert.ok(prepared.ok, prepared.ok ? '' : prepared.reason);
  return prepared.launch;
}

test('a locked checkout with a project .claude folder gets the runtime deny mount points created for the launch and left in place after', async (context) => {
  const factoryFolder = await mkdtemp(path.join(glimmervoidHomeDir(), 'factory-'));
  context.after(() => rm(factoryFolder, { recursive: true, force: true }));
  const checkout = path.join(factoryFolder, 'repo');
  await mkdir(path.join(checkout, '.claude'), { recursive: true });
  await writeFile(path.join(checkout, '.claude', 'release-profile.json'), '{}\n');
  const bareCheckout = path.join(factoryFolder, 'bare');
  await mkdir(bareCheckout);

  const launch = await launchLockedCheckout(checkout, 'locked-claude-launch');
  await launch.wrap('/bin/true', [], { hasTerminal: false });
  assert.deepEqual((await readdir(path.join(checkout, '.claude'))).sort(), ['agents', 'commands', 'release-profile.json']);
  await launch.dispose();
  assert.deepEqual((await readdir(path.join(checkout, '.claude'))).sort(), ['agents', 'commands', 'release-profile.json']);

  const bareLaunch = await launchLockedCheckout(bareCheckout, 'locked-bare-launch');
  await bareLaunch.wrap('/bin/true', [], { hasTerminal: false });
  assert.deepEqual(await readdir(bareCheckout), []);
  await bareLaunch.dispose();
});

function linuxSandboxSkipReason(): string | false {
  if (process.platform !== 'linux') return 'the bridge sockets exist on Linux only';
  const { errors } = SandboxManager.checkDependencies();
  return errors.length === 0 ? false : errors.join('; ');
}

for (const longTempFolderSource of ['inherited', 'caller'] as const) {
  test(`a guarded launch starts when the ${longTempFolderSource} temp folder leaves no room for a bridge socket, and the agent writes to its guarded temp folder`, { skip: linuxSandboxSkipReason() }, async (context) => {
    const launchFolder = await mkdtemp(path.join(glimmervoidHomeDir(), 'long-temp-'));
    context.after(() => rm(launchFolder, { recursive: true, force: true }));
    const checkout = path.join(launchFolder, 'repo');
    const longTempFolder = path.join(launchFolder, 't'.repeat(Math.max(1, 90 - launchFolder.length)));
    await mkdir(checkout);
    await mkdir(longTempFolder);
    const inheritedTempFolder = process.env.TMPDIR;
    process.env.TMPDIR = longTempFolderSource === 'inherited' ? longTempFolder : '/tmp';
    context.after(() => {
      if (inheritedTempFolder === undefined) delete process.env.TMPDIR;
      if (inheritedTempFolder !== undefined) process.env.TMPDIR = inheritedTempFolder;
    });
    const prepared = await prepareGuardrailsLaunch({ role: { vendors: [], vendorHome: { scope: 'state' }, network: { access: 'none' }, writableRoots: [checkout], lockedCheckouts: [], commitCheckouts: [], readDenied: [], readableWithinDenied: [] }, launchId: `long-temp-${longTempFolderSource}-launch` });
    assert.ok(prepared.ok, prepared.ok ? '' : prepared.reason);
    context.after(() => prepared.launch.dispose());
    const wrapped = await prepared.launch.wrap('/bin/sh', ['-c', 'printf written > "$TMPDIR/probe" && printf %s "$TMPDIR"'], { hasTerminal: false });
    const launched = spawnSync(wrapped.file, wrapped.args, { cwd: checkout, env: { ...process.env, TMPDIR: longTempFolder, ...prepared.launch.env }, encoding: 'utf8' });
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(launched.stdout, prepared.launch.env.CLAUDE_CODE_TMPDIR);
  });
}

async function launchFolderNames(launchId: string): Promise<string[]> {
  const glimmervoidHome = await realpath(glimmervoidHomeDir());
  const candidates = [
    path.join(glimmervoidHome, 'guardrails-policies', `${launchId}.json`),
    path.join(glimmervoidHome, 'guardrails-policies', `${launchId}.owner.json`),
    path.join(glimmervoidHome, 'guardrails-homes', launchId),
    path.join(glimmervoidHome, 'guardrails-temp', launchId),
  ];
  const present = await Promise.all(candidates.map((candidate) => lstat(candidate).then(() => true, () => false)));
  return candidates.filter((_candidate, index) => present[index]).map((candidate) => path.relative(glimmervoidHome, candidate));
}

test('the startup sweep removes only the launch folders whose owning process has exited', async (context) => {
  const factoryFolder = await mkdtemp(path.join(glimmervoidHomeDir(), 'factory-'));
  context.after(() => rm(factoryFolder, { recursive: true, force: true }));
  const checkout = path.join(factoryFolder, 'repo');
  await mkdir(checkout);
  const liveLaunch = await launchLockedCheckout(checkout, 'sweep-live-launch');
  context.after(() => liveLaunch.dispose());
  await launchLockedCheckout(checkout, 'sweep-orphaned-launch');
  const orphanedOwnerPath = path.join(glimmervoidHomeDir(), 'guardrails-policies', 'sweep-orphaned-launch.owner.json');
  const exitedPid = spawnSync(process.execPath, ['-e', '']).pid;
  assert.ok(exitedPid);
  await writeFile(orphanedOwnerPath, JSON.stringify({ ...JSON.parse(await readFile(orphanedOwnerPath, 'utf8')), ownerPid: exitedPid }));
  const otherNamespaceLaunch = await launchLockedCheckout(checkout, 'sweep-other-namespace-launch');
  context.after(() => otherNamespaceLaunch.dispose());
  const otherNamespaceOwnerPath = path.join(glimmervoidHomeDir(), 'guardrails-policies', 'sweep-other-namespace-launch.owner.json');
  await writeFile(otherNamespaceOwnerPath, JSON.stringify({ ...JSON.parse(await readFile(otherNamespaceOwnerPath, 'utf8')), ownerPid: exitedPid, ownerPidNamespace: 'pid:[1]' }));
  const otherNamespaceFoldersBefore = await launchFolderNames('sweep-other-namespace-launch');
  const liveFoldersBefore = await launchFolderNames('sweep-live-launch');
  assert.ok(liveFoldersBefore.includes(path.join('guardrails-policies', 'sweep-live-launch.owner.json')), liveFoldersBefore.join(', '));
  assert.ok(liveFoldersBefore.includes(path.join('guardrails-temp', 'sweep-live-launch')), liveFoldersBefore.join(', '));
  assert.equal((await launchFolderNames('sweep-orphaned-launch')).length, liveFoldersBefore.length);

  await sweepOrphanedGuardrailsLaunches({ log: () => {}, warn: (line: string) => assert.fail(line) });

  assert.deepEqual(await launchFolderNames('sweep-orphaned-launch'), []);
  assert.deepEqual(await launchFolderNames('sweep-live-launch'), liveFoldersBefore);
  assert.equal(otherNamespaceFoldersBefore.length, liveFoldersBefore.length);
  assert.deepEqual(await launchFolderNames('sweep-other-namespace-launch'), otherNamespaceFoldersBefore);
});

test('a guarded terminal launch can switch its own terminal to raw mode but cannot reach another terminal', { skip: process.platform !== 'darwin' }, async (context) => {
  const launchFolder = await mkdtemp(path.join(glimmervoidHomeDir(), 'terminal-'));
  context.after(() => rm(launchFolder, { recursive: true, force: true }));
  const checkout = path.join(launchFolder, 'repo');
  await mkdir(checkout);
  const launch = await launchLockedCheckout(checkout, 'terminal-launch');
  context.after(() => launch.dispose());

  const siblingTerminal = pty.spawn('/bin/sh', ['-c', 'tty; sleep 30'], { cols: 80, rows: 24 });
  context.after(() => siblingTerminal.kill());
  let siblingOutput = '';
  siblingTerminal.onData((chunk) => { siblingOutput += chunk; });
  const siblingPath = await new Promise<string>((resolve) => {
    const poll = setInterval(() => {
      const siblingName = /\/dev\/ttys\d+/.exec(siblingOutput)?.[0];
      if (siblingName === undefined) return;
      clearInterval(poll);
      resolve(siblingName);
    }, 20);
  });

  const script = `stty -icanon -echo && echo raw-mode-set; (printf x > ${siblingPath}) 2>/dev/null && echo sibling-reached || echo sibling-denied`;
  const wrapped = await launch.wrap('/bin/sh', ['-c', script], { hasTerminal: true });
  const terminal = pty.spawn(wrapped.file, wrapped.args, { cols: 80, rows: 24, cwd: checkout, env: { ...process.env, ...launch.env } });
  let output = '';
  terminal.onData((chunk) => { output += chunk; });
  await new Promise((resolve) => terminal.onExit(resolve));
  assert.match(output, /raw-mode-set/, output);
  assert.match(output, /sibling-denied/, output);
});

test('a session temp folder survives its launch so the next launch of that session finds the same scratch files, and an aged one stays while any launch still uses it', async (context) => {
  const factoryFolder = await mkdtemp(path.join(glimmervoidHomeDir(), 'factory-'));
  const sessionTempFolder = path.join(await realpath(glimmervoidHomeDir()), 'guardrails-temp', 'kept-temp-session');
  context.after(() => Promise.all([rm(factoryFolder, { recursive: true, force: true }), rm(sessionTempFolder, { recursive: true, force: true })]));
  const checkout = path.join(factoryFolder, 'repo');
  await mkdir(checkout);
  const role = workRole({ vendor: 'claude', cwd: checkout, checkout, agentSessionId: null, readablePaths: [] });
  const firstLaunch = await prepareGuardrailsLaunch({ role, launchId: 'kept-temp-first-launch', keptTempFolderName: 'kept-temp-session' });
  assert.ok(firstLaunch.ok, firstLaunch.ok ? '' : firstLaunch.reason);
  assert.equal(firstLaunch.launch.env.CLAUDE_CODE_TMPDIR, sessionTempFolder);
  await writeFile(path.join(sessionTempFolder, 'scratchpad-note'), 'kept');
  await firstLaunch.launch.dispose();

  const secondLaunch = await prepareGuardrailsLaunch({ role, launchId: 'kept-temp-second-launch', keptTempFolderName: 'kept-temp-session' });
  assert.ok(secondLaunch.ok, secondLaunch.ok ? '' : secondLaunch.reason);
  context.after(() => secondLaunch.launch.dispose());
  assert.equal(secondLaunch.launch.env.CLAUDE_CODE_TMPDIR, sessionTempFolder);
  assert.equal(await readFile(path.join(sessionTempFolder, 'scratchpad-note'), 'utf8'), 'kept');

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(sessionTempFolder, eightDaysAgo, eightDaysAgo);
  await pruneLeftoverSessionTempFolders(await realpath(glimmervoidHomeDir()), new Set());
  assert.equal(await readFile(path.join(sessionTempFolder, 'scratchpad-note'), 'utf8'), 'kept');

  await secondLaunch.launch.dispose();
  await pruneLeftoverSessionTempFolders(await realpath(glimmervoidHomeDir()), new Set());
  await assert.rejects(lstat(sessionTempFolder), { code: 'ENOENT' });
});

function secondInstanceScript(sessionIds: string[], { staysRunning }: { staysRunning: boolean }): string {
  const guardrailsLaunchUrl = pathToFileURL(path.resolve('server/guardrails/guardrails-launch.ts')).href;
  const keepRunning = staysRunning ? 'setInterval(() => {}, 1000);' : '';
  return `const { ensureSessionTempFolder } = await import(${JSON.stringify(guardrailsLaunchUrl)}); for (const sessionId of ${JSON.stringify(sessionIds)}) ensureSessionTempFolder(sessionId); console.log('ready'); ${keepRunning}`;
}

async function lockFileNamesOf(glimmervoidHome: string, sessionId: string): Promise<string[]> {
  const policyEntryNames = await readdir(path.join(glimmervoidHome, 'guardrails-policies'));
  return policyEntryNames.filter((entryName) => entryName.startsWith(`${sessionId}.`) && entryName.endsWith('.lock'));
}

async function removeSessionFoldersAndLocks(glimmervoidHome: string, sessionIds: readonly string[]): Promise<void> {
  const lockFileNames = (await Promise.all(sessionIds.map((sessionId) => lockFileNamesOf(glimmervoidHome, sessionId)))).flat();
  await Promise.all([
    ...sessionIds.map((sessionId) => rm(path.join(glimmervoidHome, 'guardrails-temp', sessionId), { recursive: true, force: true })),
    ...lockFileNames.map((lockFileName) => rm(path.join(glimmervoidHome, 'guardrails-policies', lockFileName), { force: true })),
  ]);
}

test('a session temp folder of a second instance survives this instance\'s prune while that instance runs, and goes at any age once it has exited', async (context) => {
  const glimmervoidHome = await realpath(glimmervoidHomeDir());
  const sessionFolderOf = (sessionId: string) => path.join(glimmervoidHome, 'guardrails-temp', sessionId);
  const sessionIds = ['second-instance-running', 'second-instance-exited', 'second-instance-shared', 'unlocked-aged', 'unlocked-recent'];
  const runningInstance = spawn(process.execPath, ['--input-type=module', '-e', secondInstanceScript(['second-instance-running', 'second-instance-shared'], { staysRunning: true })], { stdio: ['ignore', 'pipe', 'inherit'] });
  context.after(async () => {
    runningInstance.kill();
    await removeSessionFoldersAndLocks(glimmervoidHome, sessionIds);
  });
  await once(runningInstance.stdout, 'data');
  const exitedInstance = spawnSync(process.execPath, ['--input-type=module', '-e', secondInstanceScript(['second-instance-exited', 'second-instance-shared'], { staysRunning: false })], { encoding: 'utf8' });
  assert.equal(exitedInstance.status, 0, exitedInstance.stderr);
  await writeFile(path.join(sessionFolderOf('second-instance-exited'), 'scratchpad-note'), 'left behind');
  await writeFile(path.join(sessionFolderOf('second-instance-shared'), 'scratchpad-note'), 'still in use');
  await mkdir(sessionFolderOf('unlocked-aged'), { recursive: true });
  await mkdir(sessionFolderOf('unlocked-recent'), { recursive: true });
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await utimes(sessionFolderOf('unlocked-aged'), eightDaysAgo, eightDaysAgo);
  await utimes(sessionFolderOf('unlocked-recent'), oneDayAgo, oneDayAgo);

  await pruneLeftoverSessionTempFolders(glimmervoidHome, new Set());

  assert.deepEqual(await readdir(sessionFolderOf('second-instance-running')), []);
  assert.equal(await readFile(path.join(sessionFolderOf('second-instance-shared'), 'scratchpad-note'), 'utf8'), 'still in use');
  await assert.rejects(lstat(sessionFolderOf('second-instance-exited')), { code: 'ENOENT' });
  assert.deepEqual(await lockFileNamesOf(glimmervoidHome, 'second-instance-exited'), []);
  assert.equal((await lockFileNamesOf(glimmervoidHome, 'second-instance-running')).length, 1);
  await assert.rejects(lstat(sessionFolderOf('unlocked-aged')), { code: 'ENOENT' });
  await lstat(sessionFolderOf('unlocked-recent'));
});

test('a session temp folder held by a second instance survives the prune until that instance is killed with SIGKILL, then goes with its lock file', async (context) => {
  const glimmervoidHome = await realpath(glimmervoidHomeDir());
  const sessionFolder = path.join(glimmervoidHome, 'guardrails-temp', 'killed-instance');
  const killedInstance = spawn(process.execPath, ['--input-type=module', '-e', secondInstanceScript(['killed-instance'], { staysRunning: true })], { stdio: ['ignore', 'pipe', 'inherit'] });
  context.after(async () => {
    killedInstance.kill('SIGKILL');
    await removeSessionFoldersAndLocks(glimmervoidHome, ['killed-instance']);
  });
  await once(killedInstance.stdout, 'data');
  await writeFile(path.join(sessionFolder, 'scratchpad-note'), 'in use');

  await pruneLeftoverSessionTempFolders(glimmervoidHome, new Set());
  assert.equal(await readFile(path.join(sessionFolder, 'scratchpad-note'), 'utf8'), 'in use');

  const killedInstanceExit = once(killedInstance, 'exit');
  killedInstance.kill('SIGKILL');
  await killedInstanceExit;
  await pruneLeftoverSessionTempFolders(glimmervoidHome, new Set());
  await assert.rejects(lstat(sessionFolder), { code: 'ENOENT' });
  assert.deepEqual(await lockFileNamesOf(glimmervoidHome, 'killed-instance'), []);
});
