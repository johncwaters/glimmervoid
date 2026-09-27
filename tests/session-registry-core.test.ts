import test from 'node:test';
import assert from 'node:assert/strict';

import { diffProjects, machineSkipsPermissionsByDefault, projectSkipsPermissions } from '../server/core/session-registry-core.ts';
import type { RegistryDependencies, RegistryProject, RegistrySession } from '../server/core/session-registry-core.ts';

function liveSession(overrides: Partial<RegistrySession> = {}): RegistrySession {
  return {
    name: 'repo',
    path: '/repo',
    agentId: 'opencode',
    dangerouslySkipPermissions: false,
    bypassHookTrust: false,
    ...overrides,
  };
}

function declaredProject(overrides: Partial<RegistryProject> = {}): RegistryProject {
  return { id: 'project-1', name: 'repo', path: '/repo', agent: 'opencode', ...overrides };
}

function dependenciesWithFingerprints(
  currentFingerprint: string | null,
  capturedFingerprint: string | null,
): RegistryDependencies {
  return {
    ensureProjectIds: () => true,
    resolveAgentId: (agent) => agent ?? 'claude-code',
    agentFingerprintOf: () => currentFingerprint,
    capturedAgentFingerprintOf: () => capturedFingerprint,
  };
}

test('an edited custom agent declaration marks its live session for recreation', () => {
  const diff = diffProjects(
    new Map([['project-1', liveSession()]]),
    [declaredProject()],
    dependenciesWithFingerprints('["opencode-next",[],null,null]', '["opencode",[],null,null]'),
  );
  assert.deepEqual(diff.modified.map((project) => project.id), ['project-1']);
  assert.deepEqual(diff.unchanged, []);
});

test('an unchanged custom agent declaration leaves its live session alone across a reload', () => {
  const fingerprint = '["opencode",["--yolo"],"idle","busy"]';
  const diff = diffProjects(
    new Map([['project-1', liveSession()]]),
    [declaredProject()],
    dependenciesWithFingerprints(fingerprint, fingerprint),
  );
  assert.deepEqual(diff.modified, []);
  assert.deepEqual(diff.unchanged, ['project-1']);
});

test('a builtin agent carries no declaration fingerprint, so a reload never recreates its session', () => {
  const diff = diffProjects(
    new Map([['project-1', liveSession({ agentId: 'claude-code' })]]),
    [declaredProject({ agent: undefined })],
    dependenciesWithFingerprints(null, null),
  );
  assert.deepEqual(diff.modified, []);
  assert.deepEqual(diff.unchanged, ['project-1']);
});

test('a renamed project whose declaration also changed is recreated rather than renamed', () => {
  const diff = diffProjects(
    new Map([['project-1', liveSession()]]),
    [declaredProject({ name: 'repo-renamed' })],
    dependenciesWithFingerprints('["opencode-next",[],null,null]', '["opencode",[],null,null]'),
  );
  assert.deepEqual(diff.renamed, []);
  assert.deepEqual(diff.modified.map((project) => project.name), ['repo-renamed']);
});

test('a project with an explicit permission choice beats the machine default in both directions', () => {
  assert.equal(projectSkipsPermissions(declaredProject({ dangerouslySkipPermissions: true }), false), true);
  assert.equal(projectSkipsPermissions(declaredProject({ dangerouslySkipPermissions: false }), true), false);
});

test('a project with no permission choice inherits the machine default', () => {
  assert.equal(projectSkipsPermissions(declaredProject(), false), false);
  assert.equal(projectSkipsPermissions(declaredProject(), true), true);
});

test('the machine default skips permissions only when skipPermissionsByDefault is exactly true', () => {
  assert.equal(machineSkipsPermissionsByDefault({}), false);
  assert.equal(machineSkipsPermissionsByDefault({ skipPermissionsByDefault: false }), false);
  assert.equal(machineSkipsPermissionsByDefault({ skipPermissionsByDefault: 'true' }), false);
  assert.equal(machineSkipsPermissionsByDefault({ skipPermissionsByDefault: true }), true);
});

test('a reload leaves an inheriting session alone while its effective permission choice is unchanged', () => {
  const diff = diffProjects(
    new Map([['project-1', liveSession({ agentId: 'claude-code', dangerouslySkipPermissions: true })]]),
    [declaredProject({ agent: undefined })],
    { ...dependenciesWithFingerprints(null, null), skipPermissionsByDefault: true },
  );
  assert.deepEqual(diff.modified, []);
  assert.deepEqual(diff.unchanged, ['project-1']);
});

test('a flipped machine default recreates inheriting sessions but not ones with an explicit choice', () => {
  const diff = diffProjects(
    new Map([
      ['project-1', liveSession({ agentId: 'claude-code', dangerouslySkipPermissions: false })],
      ['project-2', liveSession({ agentId: 'claude-code', dangerouslySkipPermissions: false })],
    ]),
    [
      declaredProject({ agent: undefined }),
      declaredProject({ id: 'project-2', agent: undefined, dangerouslySkipPermissions: false }),
    ],
    { ...dependenciesWithFingerprints(null, null), skipPermissionsByDefault: true },
  );
  assert.deepEqual(diff.modified.map((project) => project.id), ['project-1']);
  assert.deepEqual(diff.unchanged, ['project-2']);
});
