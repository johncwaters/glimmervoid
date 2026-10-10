import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GlimmervoidConfig, ProjectEntry } from '../server/config-store.ts';
import type { PrGh } from '../server/pr-gh.ts';
import type { ServerMessage } from '../shared/contracts/control-messages.ts';
import { issuesStatus } from '../server/core/issues-core.ts';
import { createIssuesWiring } from '../server/issues-wiring.ts';
import type { Session } from '../session/sessions.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';
import { plainSession } from './helpers/fake-session.ts';

const issuesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'control-issue-links-'));
let harnessCount = 0;
test.after(() => fs.rmSync(issuesHome, { recursive: true, force: true }));

const ISSUE_ROW = {
  number: 42,
  title: 'Reconnect drops queued writes',
  labels: [{ name: 'bug', color: 'ff0000' }],
  url: 'https://github.com/acme/socket/issues/42',
  updatedAt: '2026-09-13T10:00:00Z',
};

const ISSUE_DETAIL = { ...ISSUE_ROW, body: 'UNPERSISTED_BODY_TOKEN' };

interface GithubIssuesFrame {
  type: string;
  requestId?: string | null;
  projectId?: string;
  issues?: unknown[];
  ok?: boolean;
  error?: string | null;
  sessionId?: string;
  sessionName?: string;
  pending?: boolean;
  existing?: boolean;
  body?: string | null;
}

function harness({ projects = [{ id: 'p1', name: 'socket', path: '/repo/socket', agent: 'codex' as const }], projectRepos = ['acme/socket'], existingSessionName = '', githubFailure = '', skipPermissionsByDefault }: { projects?: ProjectEntry[]; projectRepos?: string[]; existingSessionName?: string; githubFailure?: string; skipPermissionsByDefault?: boolean } = {}) {
  const config: GlimmervoidConfig = { projects, skipPermissionsByDefault };
  const sessions = new Map<string, Session>();
  const pastesById = new Map<string, string[]>();
  const githubPaths: string[] = [];
  const viewedRepos: (string | undefined)[] = [];
  const savedConfigs: string[] = [];
  let nextId = 0;
  let isPasteFailing = false;

  function addSession(project: ProjectEntry): void {
    const session = plainSession(project.id, project.name);
    const pastes: string[] = [];
    session.pasteTextWhenReady = (text: string) => {
      if (isPasteFailing) return { ok: false, reason: 'destroyed' };
      pastes.push(text);
      return { ok: true, deferred: false };
    };
    pastesById.set(project.id, pastes);
    sessions.set(project.id, session);
  }

  for (const project of projects) addSession(project);
  if (existingSessionName) addSession({ id: 'collision', name: existingSessionName, path: '/repo/other' });
  harnessCount += 1;
  const issues = createIssuesWiring({
    config, homeDir: path.join(issuesHome, String(harnessCount)), hasSession: (id) => sessions.has(id),
    broadcast: () => {}, gitWorkspace: { originUrl: async () => null },
  });

  const configStore = testConfigStore(config, { onSave: () => {} });
  const originalSave = configStore.save.bind(configStore);
  configStore.save = (mutate) => {
    const saved = originalSave(mutate);
    if (saved) savedConfigs.push(JSON.stringify(saved));
    return saved;
  };

  const createGithubClient = (cwd: string): Pick<PrGh, 'viewIssue'> => {
    githubPaths.push(cwd);
    return {
      viewIssue: async (_issueNumber, repo) => {
        viewedRepos.push(repo);
        return githubFailure
          ? { ok: false, issue: null, error: githubFailure }
          : { ok: true, issue: ISSUE_DETAIL, error: '' };
      },
    };
  };
  const server = createControlServer(controlDeps(config, {
    sessions,
    configStore,
    createGithubClient,
    issues,
    issueProjectRepos: async (projectId) => (projectId === 'p1' ? projectRepos : []),
    generateProjectId: () => {
      nextId += 1;
      return `issue-session-${nextId}`;
    },
    applyConfigReload: (freshConfig) => {
      for (const project of freshConfig.projects) {
        if (sessions.has(project.id)) continue;
        addSession(project);
      }
    },
  }));
  const connection = connectControl<GithubIssuesFrame>(server);
  connection.sent.length = 0;
  return {
    ...connection,
    config,
    githubPaths,
    viewedRepos,
    savedConfigs,
    sessions,
    issues,
    failPastes: () => { isPasteFailing = true; },
    pastes: (id: string) => pastesById.get(id) ?? [],
  };
}

test('open-issue-session refuses an unknown project without calling GitHub', async () => {
  const h = harness();

  await h.send({ type: 'open-issue-session', requestId: 'r1', projectId: 'missing', repo: 'acme/socket', issueNumber: 42 });

  assert.equal(h.sent[0].type, 'open-issue-session-result');
  assert.equal(h.sent[0].ok, false);
  assert.equal(h.sent[0].error, 'Project not found');
  assert.deepEqual(h.githubPaths, []);
});

test('open-issue-session creates one entry and pastes once without persisting the prompt', async () => {
  const h = harness();

  await h.send({ type: 'open-issue-session', requestId: 'r1', projectId: 'p1', repo: 'acme/socket', issueNumber: 42 });

  assert.equal(h.sent[0].ok, true);
  assert.equal(h.sent[0].sessionId, 'issue-session-1');
  assert.equal(h.sent[0].sessionName, 'issue-42-reconnect-drops-queued-writes');
  assert.equal(h.sent[0].pending, false);
  assert.equal(h.config.projects.length, 2);
  assert.deepEqual(h.config.projects[1], {
    id: 'issue-session-1',
    name: 'issue-42-reconnect-drops-queued-writes',
    path: '/repo/socket',
    agent: 'codex',
  });
  assert.equal(h.pastes('issue-session-1').length, 1);
  assert.match(h.pastes('issue-session-1')[0], /UNPERSISTED_BODY_TOKEN/);
  assert.equal(h.savedConfigs.length, 1);
  assert.equal(h.savedConfigs[0].includes('UNPERSISTED_BODY_TOKEN'), false);
});

test('opening an issue twice returns its linked live session without saving, fetching or pasting again', async () => {
  const h = harness();
  await h.send({ type: 'open-issue-session', requestId: 'first', projectId: 'p1', repo: 'acme/socket', issueNumber: 42 });
  await h.send({ type: 'open-issue-session', requestId: 'second', projectId: 'p1', repo: 'Acme/Socket', issueNumber: 42 });
  assert.deepEqual(h.sent[1], {
    type: 'open-issue-session-result', requestId: 'second', ok: true, error: null,
    sessionId: 'issue-session-1', sessionName: 'issue-42-reconnect-drops-queued-writes', existing: true,
  });
  assert.equal(h.config.projects.length, 2);
  assert.equal(h.sessions.size, 2);
  assert.equal(h.savedConfigs.length, 1);
  assert.equal(h.viewedRepos.length, 1);
  assert.equal(h.pastes('issue-session-1').length, 1);
});

test('a failed issue prompt paste leaves the issue unlinked', async () => {
  const h = harness();
  h.failPastes();
  await h.send({ type: 'open-issue-session', requestId: 'r1', projectId: 'p1', repo: 'acme/socket', issueNumber: 42 });
  assert.equal(h.sent[0].ok, false);
  assert.match(String(h.sent[0].error), /Could not write to/);
  assert.equal(await h.issues.getLinkedSessionId('acme/socket#42'), null);
});

test('simultaneous issue opens serialize through the persisted link and create one session', async () => {
  const h = harness();
  await Promise.all([
    h.send({ type: 'open-issue-session', requestId: 'first', projectId: 'p1', repo: 'acme/socket', issueNumber: 42 }),
    h.send({ type: 'open-issue-session', requestId: 'second', projectId: 'p1', repo: 'acme/socket', issueNumber: 42 }),
  ]);
  assert.deepEqual(h.sent.map((frame) => [frame.ok, frame.sessionId, frame.existing === true]), [
    [true, 'issue-session-1', false], [true, 'issue-session-1', true],
  ]);
  assert.equal(h.savedConfigs.length, 1);
  assert.equal(h.pastes('issue-session-1').length, 1);
});

test('open-issue-session reads a workspace member repo issue and names that repo in the prompt', async () => {
  const h = harness({ projectRepos: ['acme/socket', 'acme/docs'] });

  await h.send({ type: 'open-issue-session', requestId: 'r1', projectId: 'p1', repo: 'acme/docs', issueNumber: 42 });

  assert.equal(h.sent[0].ok, true);
  assert.deepEqual(h.viewedRepos, ['acme/docs']);
  assert.match(h.pastes('issue-session-1')[0], /repository: acme\/docs/);
});

test('open-issue-session refuses a repo outside the project without calling GitHub', async () => {
  const h = harness({ projectRepos: ['acme/socket', 'acme/docs'] });

  await h.send({ type: 'open-issue-session', requestId: 'r1', projectId: 'p1', repo: 'evil/socket', issueNumber: 42 });

  assert.equal(h.sent[0].ok, false);
  assert.equal(h.sent[0].error, 'Repository evil/socket does not belong to project "socket"');
  assert.deepEqual(h.githubPaths, []);
  assert.equal(h.config.projects.length, 1);
});

test('open-issue-session keeps the source project permission prompts on the derived entry', async () => {
  const h = harness({ projects: [{ id: 'p1', name: 'socket', path: '/repo/socket', dangerouslySkipPermissions: false }] });

  await h.send({ type: 'open-issue-session', requestId: 'r1', projectId: 'p1', repo: 'acme/socket', issueNumber: 42 });

  assert.equal(h.sent[0].ok, true);
  assert.equal(h.config.projects[1].dangerouslySkipPermissions, false);
});

test('open-issue-session leaves an inheriting source project inheriting the machine default', async () => {
  const h = harness({ projects: [{ id: 'p1', name: 'socket', path: '/repo/socket' }], skipPermissionsByDefault: true });

  await h.send({ type: 'open-issue-session', requestId: 'r1', projectId: 'p1', repo: 'acme/socket', issueNumber: 42 });

  assert.equal(h.sent[0].ok, true);
  assert.equal('dangerouslySkipPermissions' in h.config.projects[1], false);
});

test('open-issue-session reports the gh failure instead of a missing issue', async () => {
  const h = harness({ githubFailure: 'gh: not authenticated' });

  await h.send({ type: 'open-issue-session', requestId: 'r1', projectId: 'p1', repo: 'acme/socket', issueNumber: 42 });

  assert.equal(h.sent[0].ok, false);
  assert.equal(h.sent[0].error, 'Could not read GitHub issue #42: gh: not authenticated');
  assert.equal(h.config.projects.length, 1);
});

test('open-issue-session refuses a derived-name collision without saving or pasting', async () => {
  const h = harness({ existingSessionName: 'issue-42-reconnect-drops-queued-writes' });

  await h.send({ type: 'open-issue-session', requestId: 'r1', projectId: 'p1', repo: 'acme/socket', issueNumber: 42 });

  assert.equal(h.sent[0].ok, false);
  assert.match(String(h.sent[0].error), /already exists/);
  assert.equal(h.config.projects.length, 1);
  assert.deepEqual(h.savedConfigs, []);
  assert.equal(h.pastes('collision').length, 0);
});


test('new control sockets receive the issues snapshot without fetching or creating sessions', () => {
  const status = issuesStatus({ ts: 1, configured: false, reason: 'Sign in with gh.' });
  const sessions = new Map<string, Session>();
  const server = createControlServer(controlDeps({ projects: [] }, { getIssuesStatus: () => status, sessions }));
  const connection = connectControl<ServerMessage>(server);
  assert.deepEqual(connection.sent.filter((frame) => frame.type === 'issues-status'), [status]);
  assert.equal(sessions.size, 0);
});

test('issue-detail reads an explicit repo without project membership or session creation', async () => {
  const controlHarness = harness({ projects: [] });
  await controlHarness.send({ type: 'issue-detail', requestId: 'detail-1', repo: 'other/repo', issueNumber: 42 });
  assert.deepEqual(controlHarness.sent, [{ type: 'issue-detail-result', requestId: 'detail-1', ok: true, body: ISSUE_DETAIL.body, error: null }]);
  assert.deepEqual(controlHarness.viewedRepos, ['other/repo']);
  assert.equal(controlHarness.githubPaths.length, 1);
  assert.equal(controlHarness.sessions.size, 0);
  assert.deepEqual(controlHarness.savedConfigs, []);
});

test('issue-detail returns correlated failures and rejects unsafe repo slugs before GitHub', async () => {
  const controlHarness = harness({ githubFailure: 'rate limit exceeded' });
  await controlHarness.send({ type: 'issue-detail', requestId: 'detail-failed', repo: 'acme/socket', issueNumber: 42 });
  assert.deepEqual(controlHarness.sent[0], { type: 'issue-detail-result', requestId: 'detail-failed', ok: false, body: null, error: 'rate limit exceeded' });
  await controlHarness.send({ type: 'issue-detail', requestId: 'detail-invalid', repo: '--repo=acme/socket', issueNumber: 42 });
  assert.equal(controlHarness.sent[1].requestId, 'detail-invalid');
  assert.equal(controlHarness.sent[1].ok, false);
  assert.equal(controlHarness.sent[1].body, null);
  assert.equal(controlHarness.viewedRepos.length, 1);
  assert.deepEqual(controlHarness.savedConfigs, []);
});

test('issue-detail converts thrown GitHub failures into a reply', async () => {
  const server = createControlServer(controlDeps({ projects: [] }, { createGithubClient: () => ({ viewIssue: async () => { throw new Error('GitHub unavailable'); } }) }));
  const connection = connectControl<ServerMessage>(server);
  connection.sent.length = 0;
  await connection.send({ type: 'issue-detail', requestId: 'detail-thrown', repo: 'acme/app', issueNumber: 42 });
  assert.deepEqual(connection.sent, [{ type: 'issue-detail-result', requestId: 'detail-thrown', ok: false, body: null, error: 'GitHub unavailable' }]);
});
