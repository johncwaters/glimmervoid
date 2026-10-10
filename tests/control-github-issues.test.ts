import test from 'node:test';
import assert from 'node:assert/strict';

import type { GlimmervoidConfig, ProjectEntry } from '../server/config-store.ts';
import type { PrGh } from '../server/pr-gh.ts';
import type { ServerMessage } from '../shared/contracts/control-messages.ts';
import { issuesStatus } from '../server/core/issues-core.ts';
import type { Session } from '../session/sessions.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';
import { plainSession } from './helpers/fake-session.ts';

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
}

function harness({ projects = [{ id: 'p1', name: 'socket', path: '/repo/socket', agent: 'codex' as const }], projectRepos = ['acme/socket'], existingSessionName = '', githubFailure = '', skipPermissionsByDefault }: { projects?: ProjectEntry[]; projectRepos?: string[]; existingSessionName?: string; githubFailure?: string; skipPermissionsByDefault?: boolean } = {}) {
  const config: GlimmervoidConfig = { projects, skipPermissionsByDefault };
  const sessions = new Map<string, Session>();
  const pastesById = new Map<string, string[]>();
  const githubPaths: string[] = [];
  const viewedRepos: (string | undefined)[] = [];
  const savedConfigs: string[] = [];
  let nextId = 0;

  function addSession(project: ProjectEntry): void {
    const session = plainSession(project.id, project.name);
    const pastes: string[] = [];
    session.pasteTextWhenReady = (text: string) => {
      pastes.push(text);
      return { ok: true, deferred: false };
    };
    pastesById.set(project.id, pastes);
    sessions.set(project.id, session);
  }

  for (const project of projects) addSession(project);
  if (existingSessionName) addSession({ id: 'collision', name: existingSessionName, path: '/repo/other' });

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
