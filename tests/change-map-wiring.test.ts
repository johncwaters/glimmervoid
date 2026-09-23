import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChangeMap } from '../shared/contracts/change-map.ts';
import type { ChangeScope } from '../session/session-worktree-lifecycle.ts';
import { createChangeMapService } from '../server/change-map-wiring.ts';
import type { ChangeMapNarrator, ChangeMapSession } from '../server/change-map-wiring.ts';
import { git, hasGit } from './helpers/git-fixture.ts';

function writeRepoFile(root: string, repoPath: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.join(root, repoPath)), { recursive: true });
  fs.writeFileSync(path.join(root, repoPath), contents);
}

function commitAll(root: string, subject: string): string {
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', subject], root);
  return git(['rev-parse', 'HEAD'], root).trim();
}

function createFixtureRepo(): { root: string; base: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-change-map-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'fixture@example.test'], root);
  git(['config', 'user.name', 'Fixture'], root);
  writeRepoFile(root, 'AGENTS.md', '# Fixture\n');
  writeRepoFile(root, 'server/AGENTS.md', '# Server\n');
  writeRepoFile(root, 'server/a.ts', 'export const a = 1;\n');
  writeRepoFile(root, 'server/b.ts', "import { a } from './a.ts';\nexport const b = a;\n");
  writeRepoFile(root, 'server/a-core.ts', 'export const core = 0;\n');
  writeRepoFile(root, 'tests/a.test.ts', "import { a } from '../server/a.ts';\nvoid a;\n");
  commitAll(root, 'feat: seed');
  for (let round = 1; round <= 3; round++) {
    writeRepoFile(root, 'server/a.ts', `export const a = ${round};\n`);
    writeRepoFile(root, 'server/a-core.ts', `export const core = ${round};\n`);
    commitAll(root, `fix: round ${round}`);
  }
  const base = git(['rev-parse', 'HEAD'], root).trim();
  writeRepoFile(root, 'server/a.ts', 'export const a = 9;\n');
  writeRepoFile(root, 'server/lonely.ts', 'export const lonely = true;\n');
  return { root, base };
}

const nul = String.fromCharCode(0);

function scopeOf(root: string, base: string): ChangeScope {
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard'], root).split(nul).filter(Boolean);
  return {
    name: 'fixture',
    root,
    base,
    committedNameStatus: git(['diff', '-z', '--name-status', '-M', `${base}..HEAD`], root),
    uncommittedNameStatus: git(['diff', '-z', '--name-status', '-M', 'HEAD'], root) + untracked.map((untrackedPath) => `?${nul}${untrackedPath}${nul}`).join(''),
  };
}

function modifiedScope(root: string, repoPath: string): ChangeScope {
  return { name: 'fixture', root, base: null, committedNameStatus: '', uncommittedNameStatus: `M${nul}${repoPath}${nul}` };
}

function fixtureSession(id: string, name: string, scopes: () => ChangeScope[]): ChangeMapSession {
  return { id, name, getChangeScopes: async () => scopes() };
}

test('change map joins git facts for a real repo into one contract-valid map', { skip: !hasGit() }, async () => {
  const { root, base } = createFixtureRepo();
  try {
    const self = fixtureSession('self', 'Self', () => [scopeOf(root, base)]);
    const sibling = fixtureSession('sibling', 'Sibling', () => [{ ...scopeOf(root, base), uncommittedNameStatus: `M${nul}server/a.ts${nul}` }]);
    const sessions = new Map<string, ChangeMapSession>([[self.id, self], [sibling.id, sibling]]);
    const map = await createChangeMapService({ sessions }).build(self);
    assert.equal(ChangeMap.safeParse(map).success, true);
    const [repo] = map.repos;
    assert.deepEqual(repo.files.map((file) => [file.path, file.status]), [['server/a.ts', 'modified'], ['server/lonely.ts', 'untracked']]);
    assert.deepEqual(repo.subsystems.map((subsystem) => [subsystem.agentsPath, subsystem.title, subsystem.paths.length]), [['server/AGENTS.md', 'Server', 2]]);
    assert.deepEqual(repo.coChangeGaps.map((gap) => [gap.path, gap.partner]), [['server/a.ts', 'server/a-core.ts']]);
    const blast = repo.blastRadius.find((fact) => fact.path === 'server/a.ts');
    assert.deepEqual(blast?.directDependents, ['server/b.ts', 'tests/a.test.ts']);
    assert.deepEqual(blast?.dependentTests, ['tests/a.test.ts']);
    assert.deepEqual(repo.untestedFiles.map((fact) => fact.path), ['server/lonely.ts']);
    assert.deepEqual(repo.collisions.map((fact) => [fact.path, fact.otherSessionName]), [['server/a.ts', 'Sibling']]);
    assert.equal(map.narratorState, 'disabled');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a session with no changes gets an empty repo map without reading history', { skip: !hasGit() }, async () => {
  const { root, base } = createFixtureRepo();
  try {
    const gitCalls: string[][] = [];
    const clean = fixtureSession('clean', 'Clean', () => [{ name: 'fixture', root, base, committedNameStatus: '', uncommittedNameStatus: '' }]);
    const service = createChangeMapService({
      sessions: new Map([[clean.id, clean]]),
      runGit: async (args) => { gitCalls.push(args); return ''; },
    });
    const map = await service.build(clean);
    assert.deepEqual(map.repos[0].files, []);
    assert.deepEqual(gitCalls, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('narration state rides the map and settling re-announces the session', async () => {
  const settledSessionIds: string[] = [];
  const narrator: ChangeMapNarrator = {
    narrationFor: (_map, onSettled) => {
      onSettled();
      return { narrative: null, narratorState: 'pending' };
    },
  };
  const empty = fixtureSession('empty', 'Empty', () => []);
  const service = createChangeMapService({
    sessions: new Map([[empty.id, empty]]),
    narrator,
    onNarrationSettled: (sessionId) => settledSessionIds.push(sessionId),
  });
  const map = await service.build(empty);
  assert.equal(map.narratorState, 'pending');
  assert.deepEqual(settledSessionIds, ['empty']);
});

test('builds requested during an assembly coalesce into one follow-up that reads fresh state', async () => {
  let scopeReads = 0;
  let repoName = 'before';
  const session = fixtureSession('shared', 'Shared', () => {
    scopeReads++;
    return [{ name: repoName, root: '/nonexistent-change-map-root', base: null, committedNameStatus: '', uncommittedNameStatus: '' }];
  });
  const service = createChangeMapService({ sessions: new Map([[session.id, session]]) });
  const first = service.build(session);
  repoName = 'after';
  const [firstMap, secondMap, thirdMap] = await Promise.all([first, service.build(session), service.build(session)]);
  assert.equal(scopeReads, 2);
  assert.equal(firstMap.repos[0].name, 'before');
  assert.equal(secondMap.repos[0].name, 'after');
  assert.equal(thirdMap, secondMap);
  await service.build(session);
  assert.equal(scopeReads, 3);
});

test('a settle-triggered build asks the narrator not to start a narration', async () => {
  const requestedStarts: (boolean | undefined)[] = [];
  const narrator: ChangeMapNarrator = {
    narrationFor: (_map, _onSettled, options) => {
      requestedStarts.push(options?.mayStart);
      return { narrative: null, narratorState: 'disabled' };
    },
  };
  const empty = fixtureSession('empty', 'Empty', () => []);
  const service = createChangeMapService({ sessions: new Map([[empty.id, empty]]), narrator });
  await service.build(empty);
  await service.build(empty, { mayStartNarration: false });
  assert.deepEqual(requestedStarts, [true, false]);
});

test('queued builds may start a narration when any coalesced request allows it', async () => {
  const requestedStarts: (boolean | undefined)[] = [];
  const narrator: ChangeMapNarrator = {
    narrationFor: (_map, _onSettled, options) => {
      requestedStarts.push(options?.mayStart);
      return { narrative: null, narratorState: 'disabled' };
    },
  };
  const empty = fixtureSession('empty', 'Empty', () => []);
  const service = createChangeMapService({ sessions: new Map([[empty.id, empty]]), narrator });
  await Promise.all([
    service.build(empty, { mayStartNarration: false }),
    service.build(empty, { mayStartNarration: false }),
    service.build(empty),
  ]);
  assert.deepEqual(requestedStarts, [false, true]);
});

test('ended sibling sessions are forgotten so a returning id reports its current scopes', async () => {
  const root = '/nonexistent-change-map-root';
  let siblingPath = 'server/old.ts';
  const self = fixtureSession('self', 'Self', () => [modifiedScope(root, 'server/old.ts'), modifiedScope(`${root}-2`, 'server/new.ts')]);
  const sibling = fixtureSession('sibling', 'Sibling', () => [modifiedScope(root, siblingPath)]);
  const sessions = new Map<string, ChangeMapSession>([[self.id, self], [sibling.id, sibling]]);
  const service = createChangeMapService({ sessions, runGit: async () => '' });
  const before = await service.build(self);
  assert.deepEqual(before.repos[0].collisions.map((fact) => fact.path), ['server/old.ts']);
  sessions.delete(sibling.id);
  await service.build(self);
  siblingPath = 'server/new.ts';
  sessions.set(sibling.id, fixtureSession('sibling', 'Sibling', () => [modifiedScope(`${root}-2`, siblingPath)]));
  const after = await service.build(self);
  assert.deepEqual(after.repos[0].collisions, []);
  assert.deepEqual(after.repos[1].collisions.map((fact) => fact.path), ['server/new.ts']);
});

test('an edit that leaves the name-status unchanged still refreshes the memoized import graph', { skip: !hasGit() }, async () => {
  const { root, base } = createFixtureRepo();
  try {
    const self = fixtureSession('self', 'Self', () => [scopeOf(root, base)]);
    const service = createChangeMapService({ sessions: new Map([[self.id, self]]) });
    const before = await service.build(self);
    assert.equal(before.repos[0].blastRadius.find((fact) => fact.path === 'server/a.ts')?.directDependents.includes('server/lonely.ts'), false);
    writeRepoFile(root, 'server/lonely.ts', "import { a } from './a.ts';\nexport const lonely = a;\n");
    const after = await service.build(self);
    assert.equal(after.repos[0].blastRadius.find((fact) => fact.path === 'server/a.ts')?.directDependents.includes('server/lonely.ts'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('non-ASCII paths arrive unquoted from committed and untracked changes', { skip: !hasGit() }, async () => {
  const { root, base } = createFixtureRepo();
  try {
    const committedPath = `server/caf${String.fromCharCode(0xe9)}.ts`;
    const untrackedPath = `server/${String.fromCharCode(0xfc)}ber.ts`;
    writeRepoFile(root, committedPath, "import { a } from './a.ts';\nexport const cafe = a;\n");
    commitAll(root, 'feat: accented');
    writeRepoFile(root, untrackedPath, 'export const uber = 1;\n');
    const self = fixtureSession('self', 'Self', () => [scopeOf(root, base)]);
    const map = await createChangeMapService({ sessions: new Map([[self.id, self]]) }).build(self);
    const [repo] = map.repos;
    assert.deepEqual(repo.files.filter((file) => file.path !== 'server/a.ts' && file.path !== 'server/lonely.ts').map((file) => [file.path, file.status]), [
      [committedPath, 'added'], [untrackedPath, 'untracked'],
    ].sort((left, right) => left[0].localeCompare(right[0])));
    assert.equal(repo.blastRadius.find((fact) => fact.path === 'server/a.ts')?.directDependents.includes(committedPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
