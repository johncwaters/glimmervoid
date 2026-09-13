import test from 'node:test';
import assert from 'node:assert/strict';

import { diffProjects } from '../server/core/session-registry-core.ts';
import type { RegistryDependencies, RegistryProject, RegistrySession } from '../server/core/session-registry-core.ts';

function liveSession(overrides: Partial<RegistrySession> = {}): RegistrySession {
  return {
    name: 'repo',
    path: '/repo',
    agentId: 'opencode',
    dangerouslySkipPermissions: true,
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
