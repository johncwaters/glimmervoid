import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { createOwnedPathsLedger, reconcileOwnedPaths } from '../server/owned-paths-ledger.ts';
import { planWorkspace } from '../session/core/workspace-core.ts';
import { createSessionWorkspaceMembers } from '../session/session-workspace-members.ts';
import { git, hasGit } from './helpers/git-fixture.ts';

function makeRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Reconcile Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), name);
  git(['add', '.'], repo);
  git(['commit', '-m', 'initial'], repo);
  return repo;
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

test('startup reconcile deletes only ledgered leftovers of removed sessions and keeps any holding work', { skip: !hasGit() }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-owned-reconcile-')));
  const ledgerPath = path.join(root, 'owned-paths.json');
  try {
    const first = makeRepo(root, 'first');
    const second = makeRepo(root, 'second');
    const firstRun = restartedServer(ledgerPath);
    const removedWorkspace = await provisionWorkspace(root, 'removed-session', [first, second], firstRun.gitWorkspace);
    const liveWorkspace = await provisionWorkspace(root, 'live-session', [first, second], firstRun.gitWorkspace);
    await firstRun.ledger.idle();
    const unledgeredFolder = path.join(root, 'ws-made-by-hand');
    fs.mkdirSync(unledgeredFolder);
    const [cleanMember, dirtyMember] = removedWorkspace.members;
    fs.writeFileSync(path.join(dirtyMember.dir, 'unsaved.txt'), 'work');

    const secondRun = restartedServer(ledgerPath);
    await secondRun.reconcile(['live-session']);
    assert.equal(fs.existsSync(cleanMember.dir), false);
    assert.equal(fs.existsSync(dirtyMember.dir), true);
    assert.equal(fs.existsSync(removedWorkspace.folder), true);
    assert.equal(fs.existsSync(liveWorkspace.members[0].dir), true);
    assert.equal(fs.existsSync(unledgeredFolder), true);
    assert.ok(secondRun.warnings.some((warning) => warning.includes(dirtyMember.dir) && warning.includes('uncommitted changes')));

    fs.rmSync(path.join(dirtyMember.dir, 'unsaved.txt'));
    const thirdRun = restartedServer(ledgerPath);
    await thirdRun.reconcile(['live-session']);
    assert.equal(fs.existsSync(dirtyMember.dir), false);
    assert.equal(fs.existsSync(removedWorkspace.folder), false);
    assert.equal(fs.existsSync(liveWorkspace.folder), true);
    await thirdRun.ledger.idle();
    const ledgeredOwners = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).entries.map((entry: { owner: string }) => entry.owner);
    assert.deepEqual([...new Set(ledgeredOwners)], ['session:live-session']);

    fs.writeFileSync(ledgerPath, '{ not a ledger');
    const malformedRun = restartedServer(ledgerPath);
    await malformedRun.reconcile([]);
    assert.equal(fs.existsSync(liveWorkspace.members[0].dir), true);
    assert.equal(fs.existsSync(liveWorkspace.folder), true);
    assert.notEqual(malformedRun.warnings.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
