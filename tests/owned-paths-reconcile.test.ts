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
import { waitFor } from './helpers/wait-for.ts';

const UNTOUCHED_SINCE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

function makeRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Reconcile Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), name);
  git(['add', '.'], repo);
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_COMMITTER_DATE: UNTOUCHED_SINCE.toISOString() } });
  return repo;
}

function markUntouchedForDays(workspace: { members: { dir: string }[] }): void {
  for (const member of workspace.members) {
    if (!fs.existsSync(member.dir)) continue;
    fs.utimesSync(member.dir, UNTOUCHED_SINCE, UNTOUCHED_SINCE);
    const adminDir = git(['rev-parse', '--absolute-git-dir'], member.dir).trim();
    fs.utimesSync(adminDir, UNTOUCHED_SINCE, UNTOUCHED_SINCE);
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

    await waitFor(() => !fs.existsSync(goneWorkspace.members[0].dir));
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
