import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createBackend } from '../server/backend/backend.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { createOwnedPathsLedger, reconcileOwnedPaths } from '../server/owned-paths-ledger.ts';
import { planWorkspace } from '../session/core/workspace-core.ts';
import { createSessionWorkspaceMembers } from '../session/session-workspace-members.ts';
import { git, hasGit } from './helpers/git-fixture.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const UNTOUCHED_SINCE = new Date(Date.now() - 2 * DAY_MS);
const UNTOUCHED_PAST_PARK_GATE = new Date(Date.now() - 9 * DAY_MS);

function makeRepo(root: string, name: string, committedAt: Date = UNTOUCHED_SINCE): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Reconcile Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), name);
  git(['add', '.'], repo);
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: committedAt.toISOString() } });
  return repo;
}

function markUntouchedForDays(workspace: { members: { dir: string }[] }, untouchedSince: Date = UNTOUCHED_SINCE): void {
  for (const member of workspace.members) {
    if (!fs.existsSync(member.dir)) continue;
    fs.utimesSync(member.dir, untouchedSince, untouchedSince);
    const adminDir = git(['rev-parse', '--absolute-git-dir'], member.dir).trim();
    fs.utimesSync(adminDir, untouchedSince, untouchedSince);
  }
}

function restartedServer(ledgerPath: string) {
  const warnings: string[] = [];
  const log = { log: () => {}, warn: (message: string) => { warnings.push(message); } };
  const ledger = createOwnedPathsLedger({ filePath: ledgerPath, log });
  const gitWorkspace = createGitWorkspace({ ownedPaths: ledger });
  const reconcile = (configuredSessionIds: string[]) => reconcileOwnedPaths({ ledger, configuredSessionIds: new Set(configuredSessionIds), git: gitWorkspace, shareList: [], log });
  return { ledger, gitWorkspace, reconcile, warnings };
}

async function provisionWorkspace(root: string, sessionId: string, repoPaths: string[], gitWorkspace: ReturnType<typeof createGitWorkspace>) {
  const planned = planWorkspace({ worktreeRoot: root, sessionName: sessionId, sessionId, repoPaths });
  if (!planned.ok) throw new Error(planned.error);
  const members = createSessionWorkspaceMembers({ owner: `session:${sessionId}`, plan: planned.plan, sessionName: sessionId, shareList: null, gitWorkspace });
  assert.equal((await members.provision()).ok, true);
  return planned.plan;
}

test('a backend booted on a config outside its home sweeps only that config\'s ledger, never the home ledger', { skip: !hasGit() }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-foreign-config-')));
  const homeDirectory = path.join(root, 'home');
  const configDirectory = path.join(root, 'elsewhere');
  fs.mkdirSync(homeDirectory);
  fs.mkdirSync(configDirectory);
  const previousHome = process.env.GLIMMERVOID_HOME;
  const previousConfig = process.env.GLIMMERVOID_CONFIG;
  const server = http.createServer();
  let backend: ReturnType<typeof createBackend> | null = null;
  try {
    const first = makeRepo(root, 'first');
    const second = makeRepo(root, 'second');
    const homeRun = restartedServer(path.join(homeDirectory, 'owned-paths.json'));
    const operatorWorkspace = await provisionWorkspace(root, 'operator-session', [first, second], homeRun.gitWorkspace);
    await homeRun.ledger.idle();
    const configRun = restartedServer(path.join(configDirectory, 'owned-paths.json'));
    const goneWorkspace = await provisionWorkspace(root, 'gone-session', [first, second], configRun.gitWorkspace);
    await configRun.ledger.idle();
    markUntouchedForDays(operatorWorkspace);
    markUntouchedForDays(goneWorkspace);

    const configPath = path.join(configDirectory, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projects: [{ id: 'other-session', name: 'other', path: first }], repoRoots: [], autoResume: false }));
    process.env.GLIMMERVOID_HOME = homeDirectory;
    process.env.GLIMMERVOID_CONFIG = configPath;
    backend = createBackend(server, { staticDir: null });
    server.on('request', backend.app);
    await listenOnLoopback(server);

    await settleBackendShutdown(backend);
    backend = null;
    assert.equal(fs.existsSync(goneWorkspace.members[0].dir), false);
    assert.equal(fs.existsSync(operatorWorkspace.members[0].dir), true);
  } finally {
    if (backend) await settleBackendShutdown(backend);
    server.closeAllConnections();
    await closeServer(server);
    if (previousHome === undefined) delete process.env.GLIMMERVOID_HOME;
    if (previousHome !== undefined) process.env.GLIMMERVOID_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfig !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an orphaned checkout whose agent renamed its branch is swept once untouched, instead of kept as touch-probe-failed', { skip: !hasGit() }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-renamed-orphan-')));
  try {
    const first = makeRepo(root, 'first');
    const second = makeRepo(root, 'second');
    const firstRun = restartedServer(path.join(root, 'owned-paths.json'));
    const goneWorkspace = await provisionWorkspace(root, 'gone-session', [first, second], firstRun.gitWorkspace);
    await firstRun.ledger.idle();
    for (const member of goneWorkspace.members) git(['branch', '-m', 'feat/renamed-by-agent'], member.dir);
    markUntouchedForDays(goneWorkspace);

    const restarted = restartedServer(path.join(root, 'owned-paths.json'));
    await restarted.reconcile([]);
    await restarted.ledger.idle();

    assert.deepEqual(goneWorkspace.members.filter((member) => fs.existsSync(member.dir)).map((member) => member.dir), []);
    assert.deepEqual(restarted.warnings.filter((warning) => warning.includes('touch-probe-failed')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an orphaned checkout holding work is kept while fresh, then parked on a ref and deleted, and the ref expires', { skip: !hasGit() }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-parked-orphan-')));
  try {
    const first = makeRepo(root, 'first.js', UNTOUCHED_PAST_PARK_GATE);
    const second = makeRepo(root, 'second', UNTOUCHED_PAST_PARK_GATE);
    fs.appendFileSync(path.join(first, '.git', 'info', 'exclude'), '.env\nbuild-output\n');
    const firstRun = restartedServer(path.join(root, 'owned-paths.json'));
    const goneWorkspace = await provisionWorkspace(root, 'gone-session', [first, second], firstRun.gitWorkspace);
    await firstRun.ledger.idle();
    const dirtyMember = goneWorkspace.members[0].dir;
    fs.writeFileSync(path.join(dirtyMember, 'README.md'), 'tracked edit');
    fs.writeFileSync(path.join(dirtyMember, 'untracked.txt'), 'never committed');
    fs.writeFileSync(path.join(dirtyMember, '.env'), 'TOKEN=local');
    fs.writeFileSync(path.join(dirtyMember, 'build-output'), 'ignored');

    markUntouchedForDays(goneWorkspace);
    const freshRun = restartedServer(path.join(root, 'owned-paths.json'));
    await freshRun.reconcile([]);
    await freshRun.ledger.idle();
    assert.equal(fs.readFileSync(path.join(dirtyMember, 'untracked.txt'), 'utf8'), 'never committed');

    git(['update-index', '--skip-worktree', 'README.md'], dirtyMember);
    markUntouchedForDays(goneWorkspace, UNTOUCHED_PAST_PARK_GATE);
    const hiddenEditRun = restartedServer(path.join(root, 'owned-paths.json'));
    await hiddenEditRun.reconcile([]);
    await hiddenEditRun.ledger.idle();
    assert.equal(fs.readFileSync(path.join(dirtyMember, 'README.md'), 'utf8'), 'tracked edit');

    git(['update-index', '--no-skip-worktree', 'README.md'], dirtyMember);
    markUntouchedForDays(goneWorkspace, UNTOUCHED_PAST_PARK_GATE);
    const agedRun = restartedServer(path.join(root, 'owned-paths.json'));
    await agedRun.reconcile([]);
    await agedRun.ledger.idle();
    const parkedRef = 'refs/glimmervoid/parked/gone-session/first_2ejs';
    assert.equal(fs.existsSync(dirtyMember), false);
    assert.equal(git(['show', `${parkedRef}:README.md`], first), 'tracked edit');
    assert.equal(git(['show', `${parkedRef}:untracked.txt`], first), 'never committed');
    assert.equal(git(['show', `${parkedRef}:.env`], first), 'TOKEN=local');
    assert.equal(git(['ls-tree', '--name-only', parkedRef], first).includes('build-output'), false);

    assert.deepEqual(await agedRun.gitWorkspace.dropExpiredParkedWork({ projectPath: first }), []);
    const monthLater = createGitWorkspace({ removalGuard: { now: () => Date.now() + 31 * DAY_MS } });
    assert.deepEqual(await monthLater.dropExpiredParkedWork({ projectPath: first }), [parkedRef]);
    assert.equal(git(['for-each-ref', 'refs/glimmervoid/parked/'], first), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
