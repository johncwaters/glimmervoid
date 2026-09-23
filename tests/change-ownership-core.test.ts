import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANGE_MAP_LIST_CAP, CollisionFact, SubsystemFact } from '../shared/contracts/change-map.ts';
import { computeCollisions, computeSubsystems, readAgentsTitle } from '../server/core/change-ownership-core.ts';

test('readAgentsTitle extracts the first H1 after other lines', () => {
  assert.equal(readAgentsTitle('<!-- note -->\n## Not the title\n#  Actual title  \n# Later'), 'Actual title');
  assert.equal(readAgentsTitle('## Subtitle\ntext'), '');
  assert.equal(readAgentsTitle('text only'), '');
});

test('computeSubsystems assigns files to the nearest AGENTS.md and falls back to root', () => {
  const subsystems = computeSubsystems({
    repoName: 'glimmervoid',
    changedPaths: ['session/adapters/claude.ts', 'session/sessions.ts', 'server/core/a.ts'],
    agentsDocs: [
      { path: 'AGENTS.md', title: 'Repo' },
      { path: 'session/AGENTS.md', title: 'Sessions' },
      { path: 'session/adapters/AGENTS.md', title: 'Adapters' },
    ],
  });
  assert.deepEqual(subsystems.map(({ agentsPath, paths }) => [agentsPath, paths]), [
    ['AGENTS.md', ['server/core/a.ts']],
    ['session/adapters/AGENTS.md', ['session/adapters/claude.ts']],
    ['session/AGENTS.md', ['session/sessions.ts']],
  ]);
  assert.deepEqual(subsystems.map(({ title }) => title), ['Repo', 'Adapters', 'Sessions']);
  assert.deepEqual(subsystems.map(({ factId }) => factId), [
    'subsystem:glimmervoid:AGENTS.md',
    'subsystem:glimmervoid:session/adapters/AGENTS.md',
    'subsystem:glimmervoid:session/AGENTS.md',
  ]);
});

test('computeSubsystems skips paths without an owner when root AGENTS.md is absent', () => {
  assert.deepEqual(computeSubsystems({
    repoName: 'repo',
    changedPaths: ['server/a.ts', 'session/a.ts'],
    agentsDocs: [{ path: 'session/AGENTS.md', title: '' }],
  }), [{
    factId: 'subsystem:repo:session/AGENTS.md',
    agentsPath: 'session/AGENTS.md',
    title: 'session',
    paths: ['session/a.ts'],
  }]);
});

test('computeSubsystems sorts groups by size and paths within groups', () => {
  const subsystems = computeSubsystems({
    repoName: 'repo',
    changedPaths: ['b/z.ts', 'a/z.ts', 'b/a.ts', 'a/a.ts', 'root.ts'],
    agentsDocs: [
      { path: 'AGENTS.md', title: '' },
      { path: 'a/AGENTS.md', title: '' },
      { path: 'b/AGENTS.md', title: '' },
    ],
  });
  assert.deepEqual(subsystems.map(({ agentsPath, paths }) => [agentsPath, paths]), [
    ['a/AGENTS.md', ['a/a.ts', 'a/z.ts']],
    ['b/AGENTS.md', ['b/a.ts', 'b/z.ts']],
    ['AGENTS.md', ['root.ts']],
  ]);
  assert.equal(subsystems[2].title, 'repo');
});

test('computeCollisions emits one fact for each overlapping path and session', () => {
  const collisions = computeCollisions({
    repoName: 'repo',
    changedPaths: ['b.ts', 'a.ts'],
    otherSessions: [
      { id: 'second', name: 'Zed', changedPaths: ['a.ts', 'b.ts', 'b.ts', 'other.ts'] },
      { id: 'first', name: 'Amy', changedPaths: ['a.ts'] },
    ],
  });
  assert.deepEqual(collisions.map(({ factId, path, otherSessionName }) => [factId, path, otherSessionName]), [
    ['collision:repo:a.ts:first', 'a.ts', 'Amy'],
    ['collision:repo:a.ts:second', 'a.ts', 'Zed'],
    ['collision:repo:b.ts:second', 'b.ts', 'Zed'],
  ]);
});

test('computeCollisions caps the sorted fact list', () => {
  const changedPaths = Array.from({ length: CHANGE_MAP_LIST_CAP + 2 }, (_, index) => `file-${String(index).padStart(2, '0')}.ts`);
  const collisions = computeCollisions({
    repoName: 'repo',
    changedPaths: [...changedPaths].reverse(),
    otherSessions: [{ id: 'other', name: 'Other', changedPaths: [...changedPaths].reverse() }],
  });
  assert.equal(collisions.length, CHANGE_MAP_LIST_CAP);
  assert.equal(collisions[0].path, changedPaths[0]);
  assert.equal(collisions.at(-1)?.path, changedPaths[CHANGE_MAP_LIST_CAP - 1]);
});

test('ownership and collision facts parse through their contract schemas', () => {
  const subsystems = computeSubsystems({ repoName: 'repo', changedPaths: ['a.ts'], agentsDocs: [{ path: 'AGENTS.md', title: '' }] });
  const collisions = computeCollisions({ repoName: 'repo', changedPaths: ['a.ts'], otherSessions: [{ id: 'other', name: 'Other', changedPaths: ['a.ts'] }] });
  assert.equal(SubsystemFact.safeParse(subsystems[0]).success, true);
  assert.equal(CollisionFact.safeParse(collisions[0]).success, true);
});
