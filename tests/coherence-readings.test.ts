import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileAsync } from '../server/child-process-safe.ts';
import { createCoherenceAdopt } from '../server/coherence/coherence-adopt.ts';
import { createCoherenceCheck } from '../server/coherence/coherence-check.ts';
import { createCoherenceNativeHooks } from '../server/coherence/coherence-native-hooks.ts';
import { createCoherenceReadings, integrationTipReader } from '../server/coherence/coherence-readings.ts';
import { createCoherenceRuntime } from '../server/coherence/coherence-runtime.ts';
import { codexHookHashes } from '../server/coherence/core/coherence-codex-trust-core.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import type { ServerMessageOf } from '../shared/contracts/control-messages.ts';
import { ServerMessage } from '../shared/contracts/control-messages.ts';

async function git(cwd: string, ...args: string[]) {
  return execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', message);
  return (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
}

async function nextTrend(messages: ServerMessageOf<'project-coherence-trend'>[], afterCount: number) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const arrived = messages[afterCount];
    if (arrived) return arrived;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no project-coherence-trend message arrived');
}

test('each integration tip move records one sandboxed reading row and pushes the trend, and a language module tip records unavailable without running', async (t) => {
  const runtime = createCoherenceRuntime();
  const workRoot = await mkdtemp(path.join(os.tmpdir(), 'coherence-readings-'));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  const repo = path.join(workRoot, 'repo');
  const seriesRoot = path.join(workRoot, 'series');
  await mkdir(path.join(repo, '.claude'), { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'coherence.config.json'), '{}');
  for (const controlFile of ['settings.json', 'coherence-hook', 'coherence-root']) await writeFile(path.join(repo, '.claude', controlFile), '{}');
  await writeFile(path.join(repo, 'size.ts'), "export enum Size { Small = 'small', Medium = 'medium', Large = 'large', Huge = 'huge' }\n");
  const firstTip = await commitAll(repo, 'init');

  const messages: ServerMessageOf<'project-coherence-trend'>[] = [];
  const readings = createCoherenceReadings({
    seriesRoot,
    listProjects: () => [{ id: 'project-1', path: repo }],
    readSettings: () => ({ isFactoryEnabled: false, isSettingOn: true }),
    readIntegrationTip: integrationTipReader(createGitWorkspace(), () => ({})),
    fetchOrigin: createGitWorkspace().fetchOrigin,
    hasNativeControlAt: runtime.hasNativeControlAt,
    broadcastControl: (message) => messages.push(message),
    debounceMs: 0,
    log: { warn: () => {} },
  });
  t.after(() => readings.stop());

  await readings.pollNow();
  const firstPush = await nextTrend(messages, 0);
  assert.equal(ServerMessage.safeParse(firstPush).success, true);
  assert.equal(firstPush.latest.sha, firstTip);
  assert.equal(firstPush.latest.drift.status, 'needs-components');
  assert.equal(firstPush.latest.decompose.status, 'needs-components');
  assert.deepEqual(firstPush.latest.redundancy, { status: 'ok', pairCount: 0, topPairs: [] });
  assert.equal(firstPush.latest.mass.status, 'ok', JSON.stringify(firstPush.latest.mass));
  await readings.pollNow();

  await writeFile(path.join(repo, 'dimension.ts'), "export enum Dimension { Small = 'small', Medium = 'medium', Large = 'large', Huge = 'huge' }\n");
  const secondTip = await commitAll(repo, 'duplicate the size domain');
  await readings.pollNow();
  const secondPush = await nextTrend(messages, 1);
  assert.equal(secondPush.latest.sha, secondTip);
  assert.equal(secondPush.latest.redundancy.status === 'ok' && secondPush.latest.redundancy.pairCount, 1);
  assert.equal(secondPush.trend.direction, 'decohering');
  assert.deepEqual(readings.snapshotMessage().projects['project-1']?.latest, secondPush.latest);

  const massMarkerPath = path.join(workRoot, 'mass-ran.marker');
  await writeFile(path.join(repo, 'coherence.config.json'), JSON.stringify({ mass: { measures: [{ key: 'pwn', cmd: ['sh', '-c', `touch ${massMarkerPath}`] }] } }));
  const massTip = await commitAll(repo, 'declare a mass command');
  await readings.pollNow();
  const massPush = await nextTrend(messages, 2);
  assert.equal(massPush.latest.sha, massTip);
  assert.deepEqual(massPush.latest.mass, { status: 'unavailable', reason: 'the repo declares mass commands' });
  assert.equal(massPush.latest.redundancy.status, 'ok');
  await assert.rejects(stat(massMarkerPath), { code: 'ENOENT' });

  const markerPath = path.join(workRoot, 'evil-ran.marker');
  await writeFile(path.join(repo, 'evil.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran'); export default {};\n`);
  await writeFile(path.join(repo, 'coherence.config.json'), JSON.stringify({ language: './evil.js' }));
  await commitAll(repo, 'name a language module');
  await readings.pollNow();
  const evilPush = await nextTrend(messages, 3);
  const refused = { status: 'unavailable', reason: 'coherence.config.json names a language module instead of a built-in language' };
  assert.deepEqual([evilPush.latest.drift, evilPush.latest.decompose, evilPush.latest.redundancy, evilPush.latest.mass], [refused, refused, refused, refused]);
  await assert.rejects(stat(markerPath), { code: 'ENOENT' });

  const seriesText = await readFile(path.join(seriesRoot, 'project-project-1.jsonl'), 'utf8');
  assert.deepEqual(seriesText.trim().split('\n').map((line) => JSON.parse(line).sha), [firstTip, secondTip, massTip, evilPush.latest.sha]);
  assert.equal(messages.length, 4);
});

async function seedProjectWithOrigin(workRoot: string, name: string): Promise<{ repo: string; origin: string; tip: string }> {
  const origin = path.join(workRoot, `${name}-origin.git`);
  const repo = path.join(workRoot, name);
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await mkdir(path.join(repo, '.claude'), { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Operator Example');
  await git(repo, 'config', 'user.email', 'operator@example.com');
  await git(repo, 'remote', 'add', 'origin', origin);
  await writeFile(path.join(repo, 'README.md'), '# project\n');
  await writeFile(path.join(repo, '.claude', 'settings.json'), `${JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2)}\n`);
  const tip = await commitAll(repo, 'init');
  await git(repo, 'push', '-q', 'origin', 'main');
  await git(repo, 'fetch', '-q', 'origin');
  return { repo, origin, tip };
}

async function seedHostileProject(workRoot: string, name: string, filesByPath: Record<string, string>): Promise<{ repo: string; origin: string }> {
  const seeded = await seedProjectWithOrigin(workRoot, name);
  for (const [relativePath, text] of Object.entries(filesByPath)) {
    await mkdir(path.dirname(path.join(seeded.repo, relativePath)), { recursive: true });
    await writeFile(path.join(seeded.repo, relativePath), text, { mode: 0o755 });
  }
  await commitAll(seeded.repo, 'agent commit');
  await git(seeded.repo, 'push', '-q', 'origin', 'main');
  await git(seeded.repo, 'fetch', '-q', 'origin');
  return seeded;
}

test('a push to origin made outside Glimmervoid reaches the readings within one origin fetch interval', async (t) => {
  const runtime = createCoherenceRuntime();
  const workRoot = await mkdtemp(path.join(os.tmpdir(), 'coherence-readings-fetch-'));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  const pushed = await seedHostileProject(workRoot, 'pushed', { 'coherence.config.json': '{}', '.claude/coherence-hook': '{}', '.claude/coherence-root': '{}' });
  const outsideClone = path.join(workRoot, 'outside-clone');
  await execFileAsync('git', ['clone', '-q', pushed.origin, outsideClone]);
  const gitWorkspace = createGitWorkspace();
  let clockMs = Date.now();
  const messages: ServerMessageOf<'project-coherence-trend'>[] = [];
  const readings = createCoherenceReadings({
    seriesRoot: path.join(workRoot, 'series'),
    listProjects: () => [{ id: 'project-1', path: pushed.repo }],
    readSettings: () => ({ isFactoryEnabled: false, isSettingOn: true }),
    readIntegrationTip: integrationTipReader(gitWorkspace, () => ({})),
    fetchOrigin: gitWorkspace.fetchOrigin,
    hasNativeControlAt: runtime.hasNativeControlAt,
    broadcastControl: (message) => messages.push(message),
    debounceMs: 0,
    now: () => clockMs,
    log: { warn: () => {} },
  });
  t.after(() => readings.stop());
  await readings.pollNow();
  await nextTrend(messages, 0);

  await writeFile(path.join(outsideClone, 'outside.ts'), 'export const outside = 1;\n');
  const outsideTip = await commitAll(outsideClone, 'push from outside');
  await git(outsideClone, 'push', '-q', 'origin', 'main');
  clockMs += 60_000;
  await readings.pollNow();
  assert.equal((await git(pushed.repo, 'rev-parse', 'refs/remotes/origin/main')).stdout.trim() === outsideTip, false);
  clockMs += 5 * 60_000;
  await readings.pollNow();
  const outsidePush = await nextTrend(messages, 1);
  assert.equal(outsidePush.latest.sha, outsideTip);
});

async function nextStatus(messages: ServerMessageOf<'project-coherence-status'>[]) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const arrived = messages[0];
    if (arrived) return arrived;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('no project-coherence-status message arrived');
}

test('adopting Coherence pushes one fast-forward commit holding exactly the native install, refuses a second adopt, and leaves origin alone when the push is not a fast-forward', async (t) => {
  const workRoot = await mkdtemp(path.join(os.tmpdir(), 'coherence-adopt-'));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  const adopted = await seedProjectWithOrigin(workRoot, 'adopted');
  const raced = await seedProjectWithOrigin(workRoot, 'raced');
  const plantedCliMarker = path.join(workRoot, 'planted-cli-ran.marker');
  const plantedCli = await seedHostileProject(workRoot, 'planted-cli', {
    'package.json': '{ "private": true }\n',
    'node_modules/@danilocampos/coherence/package.json': '{ "name": "@danilocampos/coherence", "version": "0.0.0", "type": "module" }\n',
    'node_modules/@danilocampos/coherence/dist/cli.js': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(plantedCliMarker)}, 'ran');\n`,
  });
  const npmrcGitMarker = path.join(workRoot, 'npmrc-git-ran.marker');
  const npmrcGit = await seedHostileProject(workRoot, 'npmrc-git', {
    '.npmrc': 'git=./evil.sh\n',
    'evil.sh': `#!/bin/sh\necho "$@" > ${JSON.stringify(npmrcGitMarker)}\nexit 1\n`,
    'package.json': `${JSON.stringify({ private: true, dependencies: { x: 'git+ssh://git@example.invalid/x.git' } })}\n`,
  });
  const directoryIgnored = await seedHostileProject(workRoot, 'directory-ignored', { '.gitignore': 'node_modules/\n.coherence/activity/\n' });
  const claudeIgnored = await seedHostileProject(workRoot, 'claude-ignored', { '.gitignore': '.claude/*\n!.claude/release-profile.json\n', '.claude/release-profile.json': '{}\n' });
  const jsonlIgnored = await seedHostileProject(workRoot, 'jsonl-ignored', { '.gitignore': '*.jsonl\n' });
  const realWorkspace = createGitWorkspace();
  const racingClone = path.join(workRoot, 'racing-clone');
  await execFileAsync('git', ['clone', '-q', raced.origin, racingClone]);
  const gitWorkspace = {
    ...realWorkspace,
    fetchOrigin: async (args: Parameters<typeof realWorkspace.fetchOrigin>[0]) => {
      const fetched = await realWorkspace.fetchOrigin(args);
      if (args.projectPath !== raced.repo) return fetched;
      await writeFile(path.join(racingClone, 'race.txt'), 'landed first\n');
      await commitAll(racingClone, 'land first');
      await git(racingClone, 'push', '-q', 'origin', 'main');
      return fetched;
    },
  };
  const statusMessages: ServerMessageOf<'project-coherence-status'>[] = [];
  const adopt = createCoherenceAdopt({
    listProjects: () => [
      { id: 'project-1', path: adopted.repo }, { id: 'project-2', path: raced.repo }, { id: 'project-3', path: plantedCli.repo }, { id: 'project-4', path: npmrcGit.repo },
      { id: 'project-5', path: directoryIgnored.repo }, { id: 'project-6', path: claudeIgnored.repo },
      { id: 'project-7', path: jsonlIgnored.repo },
    ],
    readConfig: () => ({}),
    gitWorkspace,
    broadcastControl: (message) => statusMessages.push(message),
    baseEnv: { ...process.env, npm_config_offline: 'true' },
    log: { warn: () => {} },
  });

  assert.deepEqual((await adopt.statusMessage()).projects, {
    'project-1': { configured: false }, 'project-2': { configured: false }, 'project-3': { configured: false }, 'project-4': { configured: false }, 'project-5': { configured: false },
    'project-6': { configured: false }, 'project-7': { configured: false },
  });
  assert.deepEqual(await adopt.adopt({ projectId: 'project-1', confirm: 'yes' }), { projectId: 'project-1', ok: false, error: 'not confirmed' });

  const result = await adopt.adopt({ projectId: 'project-1', confirm: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  const pushedSha = result.sha ?? '';
  assert.equal(ServerMessage.safeParse({ type: 'project-coherence-adopt-response', requestId: 'r1', ...result }).success, true);
  assert.equal((await git(adopted.origin, 'rev-parse', 'refs/heads/main')).stdout.trim(), pushedSha);
  assert.equal((await git(adopted.origin, 'rev-parse', `${pushedSha}^`)).stdout.trim(), adopted.tip);
  assert.equal((await git(adopted.origin, 'log', '-1', '--format=%an <%ae>%n%s', pushedSha)).stdout.trim(), 'Operator Example <operator@example.com>\nchore: adopt Coherence');
  const committedPaths = (await git(adopted.origin, 'show', '--name-only', '--format=', pushedSha)).stdout.trim().split('\n');
  assert.deepEqual(committedPaths, [
    '.claude/coherence-hook', '.claude/coherence-root', '.claude/settings.json', '.codex/coherence-hook', '.codex/coherence-root', '.codex/hooks.json',
    '.gitignore', 'coherence.config.json', 'package-lock.json', 'package.json',
  ]);
  const committedSettings = JSON.parse((await git(adopted.origin, 'show', `${pushedSha}:.claude/settings.json`)).stdout);
  assert.deepEqual(committedSettings.permissions, { allow: ['Bash(ls)'] });
  assert.equal((await git(adopted.repo, 'status', '--porcelain', '--untracked-files=all')).stdout, '');
  assert.equal((await git(adopted.repo, 'worktree', 'list', '--porcelain')).stdout.match(/^worktree /gm)?.length, 1);

  const freshClone = path.join(workRoot, 'fresh-clone');
  await execFileAsync('git', ['clone', '-q', adopted.origin, freshClone]);
  await execFileAsync('npm', ['ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: freshClone, encoding: 'utf8' });
  const freshCli = path.join(freshClone, 'node_modules', '@danilocampos', 'coherence', 'dist', 'cli.js');
  for (const host of ['claude', 'codex']) await execFileAsync(process.execPath, [freshCli, 'hooks', '--check', '--host', host], { cwd: freshClone, encoding: 'utf8' });
  const journalProbes = ['.coherence/activity/s.jsonl', '.coherence/read-traces/s.jsonl', '.coherence/decisions/s.jsonl', '.coherence/work/s.jsonl'];
  assert.equal((await git(freshClone, 'check-ignore', '--no-index', '--', ...journalProbes)).stdout, '.coherence/activity/s.jsonl\n.coherence/read-traces/s.jsonl\n');

  const status = await nextStatus(statusMessages);
  assert.equal(ServerMessage.safeParse(status).success, true);
  assert.deepEqual(status.projects['project-1'], { configured: true });
  assert.deepEqual(await adopt.adopt({ projectId: 'project-1', confirm: true }), { projectId: 'project-1', ok: false, error: 'already configured' });

  assert.deepEqual(await adopt.adopt({ projectId: 'project-2', confirm: true }), { projectId: 'project-2', ok: false, error: 'push rejected' });
  const racedOriginTip = (await git(raced.origin, 'rev-parse', 'refs/heads/main')).stdout.trim();
  assert.equal(racedOriginTip, (await git(racingClone, 'rev-parse', 'HEAD')).stdout.trim());
  assert.equal((await git(raced.origin, 'ls-tree', '--name-only', racedOriginTip)).stdout.includes('coherence.config.json'), false);
  assert.equal((await git(raced.repo, 'worktree', 'list', '--porcelain')).stdout.match(/^worktree /gm)?.length, 1);

  assert.deepEqual(await adopt.adopt({ projectId: 'project-3', confirm: true }), { projectId: 'project-3', ok: false, error: 'repo tracks node_modules' });
  await assert.rejects(stat(plantedCliMarker), { code: 'ENOENT' });
  assert.deepEqual(await adopt.adopt({ projectId: 'project-4', confirm: true }), { projectId: 'project-4', ok: false, error: 'npm install failed' });
  await assert.rejects(stat(npmrcGitMarker), { code: 'ENOENT' });
  for (const hostile of [plantedCli, npmrcGit]) assert.equal((await git(hostile.origin, 'ls-tree', '--name-only', 'refs/heads/main')).stdout.includes('coherence.config.json'), false);

  const directoryIgnoredResult = await adopt.adopt({ projectId: 'project-5', confirm: true });
  assert.equal(directoryIgnoredResult.ok, true, JSON.stringify(directoryIgnoredResult));
  assert.equal((await git(directoryIgnored.origin, 'show', `${directoryIgnoredResult.sha}:.gitignore`)).stdout.split('\n').slice(0, 4).join('\n'), 'node_modules/\n.coherence/activity/\n.coherence/*\n!.coherence/decisions/');

  assert.deepEqual(await adopt.adopt({ projectId: 'project-6', confirm: true }), {
    projectId: 'project-6', ok: false, error: 'repo ignores Coherence hook files', ignoredPaths: ['.claude/coherence-hook', '.claude/coherence-root'],
  });
  assert.deepEqual(await adopt.adopt({ projectId: 'project-7', confirm: true }), {
    projectId: 'project-7', ok: false, error: 'repo ignores Coherence hook files',
    ignoredPaths: ['.coherence/decisions/', '.coherence/defects/', '.coherence/calibration/', '.coherence/experiments/', '.coherence/work/', '.coherence/consequences/'],
  });
  for (const hostile of [claudeIgnored, jsonlIgnored]) assert.equal((await git(hostile.origin, 'ls-tree', '--name-only', 'refs/heads/main')).stdout.includes('coherence.config.json'), false);
});

test('the Coherence check walks every stage of a native install inside guardrails, and a language module tip fails at install with every later stage skipped and nothing run', async (t) => {
  const runtime = createCoherenceRuntime();
  const workRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'coherence-check-')));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  const installed = await seedProjectWithOrigin(workRoot, 'installed');
  const shippedNodeModules = await realpath(path.join(import.meta.dirname, '..', 'node_modules'));
  const shippedVersion = JSON.parse(await readFile(path.join(shippedNodeModules, '@danilocampos', 'coherence', 'package.json'), 'utf8')).version;
  await symlink(shippedNodeModules, path.join(installed.repo, 'node_modules'), 'dir');
  await writeFile(path.join(installed.repo, '.gitignore'), 'node_modules\n');
  await writeFile(path.join(installed.repo, 'coherence.config.json'), '{}\n');
  await writeFile(path.join(installed.repo, 'package.json'), `${JSON.stringify({ private: true, devDependencies: { '@danilocampos/coherence': shippedVersion } })}\n`);
  for (const host of ['claude', 'codex']) await execFileAsync(process.execPath, [runtime.cliPath ?? '', 'hooks', 'install', '--host', host], { cwd: installed.repo, encoding: 'utf8' });
  const installedTip = await commitAll(installed.repo, 'adopt Coherence');
  await git(installed.repo, 'push', '-q', 'origin', 'main');
  await git(installed.repo, 'fetch', '-q', 'origin');
  const codexHome = path.join(workRoot, 'codex-home');
  await mkdir(codexHome);
  const codexHooksPath = path.join(installed.repo, '.codex', 'hooks.json');
  const trustLines = [...codexHookHashes(codexHooksPath, await readFile(codexHooksPath, 'utf8'))].map(([hookKey, hash]) => `[hooks.state.${JSON.stringify(hookKey)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`);
  await writeFile(path.join(codexHome, 'config.toml'), trustLines.join('\n'));
  const codexConfigBefore = await readFile(path.join(codexHome, 'config.toml'), 'utf8');

  const evilMarker = path.join(workRoot, 'evil-ran.marker');
  const evil = await seedHostileProject(workRoot, 'evil', {
    'coherence.config.json': JSON.stringify({ language: './evil.js' }),
    'evil.js': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(evilMarker)}, 'ran'); export default {};\n`,
  });

  const projects = [{ id: 'installed', path: installed.repo }, { id: 'evil', path: evil.repo }];
  const gitWorkspace = createGitWorkspace();
  const readIntegrationTip = integrationTipReader(gitWorkspace, () => ({}));
  const readingsOptions = {
    seriesRoot: path.join(workRoot, 'series'),
    listProjects: () => projects,
    readSettings: () => ({ isFactoryEnabled: false, isSettingOn: true }),
    readIntegrationTip,
    fetchOrigin: gitWorkspace.fetchOrigin,
    hasNativeControlAt: runtime.hasNativeControlAt,
    broadcastControl: () => {},
    debounceMs: 0,
    log: { warn: () => {} },
  };
  const readings = createCoherenceReadings(readingsOptions);
  t.after(() => readings.stop());
  await readings.pollNow();
  const codexEnv = { ...process.env, CODEX_HOME: codexHome };
  const checkOptions: Parameters<typeof createCoherenceCheck>[0] = {
    listProjects: () => projects,
    readSettings: () => ({ isFactoryEnabled: false, isSettingOn: true }),
    readIntegrationTip,
    nativeHooks: createCoherenceNativeHooks({ runtime, codexEnv, log: { warn: () => {} } }),
    readings,
    listLiveSessions: () => [{ name: 'live-1', path: installed.repo, hasLivePty: true, coherenceHooks: { active: true } }, { name: 'dormant', path: installed.repo, hasLivePty: false, coherenceHooks: null }],
    cliPath: runtime.cliPath,
    log: { warn: () => {} },
  };
  const check = createCoherenceCheck(checkOptions);
  const statusBefore = (await git(installed.repo, 'status', '--porcelain', '--untracked-files=all')).stdout;

  const passing = await check.check({ projectId: 'installed' });
  assert.equal(ServerMessage.safeParse({ type: 'project-coherence-check-response', requestId: 'r1', ...passing }).success, true);
  assert.deepEqual(passing.stages.filter((stage) => stage.status !== 'pass'), [], JSON.stringify(passing.stages, null, 2));
  assert.equal(passing.ok, true);
  assert.match(passing.stages.find((stage) => stage.id === 'install')?.detail ?? '', new RegExp(`coherence ${shippedVersion} declared`));
  assert.match(passing.stages.find((stage) => stage.id === 'journal')?.detail ?? '', /^probe decision d-[0-9a-f]{8} read back by the feed$/);
  assert.match(passing.stages.find((stage) => stage.id === 'readings')?.detail ?? '', new RegExp(`^${installedTip.slice(0, 7)} read .* ago, .*, at the integration tip$`));
  assert.equal((await git(installed.repo, 'status', '--porcelain', '--untracked-files=all')).stdout, statusBefore);
  assert.equal((await git(installed.origin, 'rev-parse', 'refs/heads/main')).stdout.trim(), installedTip);
  assert.equal(await readFile(path.join(codexHome, 'config.toml'), 'utf8'), codexConfigBefore);

  const failingCliPath = path.join(workRoot, 'failing-cli.mjs');
  await writeFile(failingCliPath, 'process.exit(2);\n');
  const unreadableReadings = createCoherenceReadings({ ...readingsOptions, seriesRoot: path.join(workRoot, 'unreadable-series'), cliPath: failingCliPath });
  t.after(() => unreadableReadings.stop());
  await unreadableReadings.pollNow();
  const unreadable = await createCoherenceCheck({ ...checkOptions, readings: unreadableReadings }).check({ projectId: 'installed' });
  const unreadableStage = unreadable.stages.find((stage) => stage.id === 'readings');
  assert.equal(unreadableStage?.status, 'fail', JSON.stringify(unreadableStage));
  assert.match(unreadableStage?.detail ?? '', /redundancy unavailable: the reading failed; mass unavailable: the reading failed$/);

  const refused = await check.check({ projectId: 'evil' });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.stages.map(({ id, status }) => `${status} ${id}`), [
    'pass setting', 'fail install', 'skip hooks-claude', 'skip hooks-codex', 'skip session-start', 'skip journal', 'skip next-action', 'skip readings', 'skip live-sessions',
  ]);
  assert.equal(refused.stages[1]?.detail, 'coherence.config.json names a language module instead of a built-in language');
  await assert.rejects(stat(evilMarker), { code: 'ENOENT' });

  await git(installed.repo, 'reset', '-q', '--hard', installed.tip);
  const lagging = await check.check({ projectId: 'installed' });
  const laggingHooks = lagging.stages.filter((stage) => stage.id === 'hooks-claude' || stage.id === 'hooks-codex');
  assert.deepEqual(laggingHooks.map(({ id, status }) => `${status} ${id}`), ['pass hooks-claude', 'pass hooks-codex'], JSON.stringify(lagging.stages, null, 2));
  assert.match(laggingHooks[1]?.detail ?? '', /trust is per session worktree; see live sessions$/);
});
