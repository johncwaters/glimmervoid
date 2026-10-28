import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectEntry } from '../server/config-store.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { Session } from '../session/sessions.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { git, hasGit } from './helpers/git-fixture.ts';
import { waitFor } from './helpers/wait-for.ts';

test('add-session persists the workspace folder and chosen repositories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-control-workspace-'));
  try {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    const config: { projects: ProjectEntry[]; worktreeRoot: string } = { projects: [], worktreeRoot: path.join(root, 'worktrees') };
    const server = createControlServer(controlDeps(config, { generateProjectId: () => '12345678-session' }));
    const connection = connectControl<{ type: string; message?: string }>(server);
    connection.send({ type: 'add-session', name: 'Team Work', path: first, repos: [first, second] });
    assert.deepEqual(config.projects, [{
      id: '12345678-session',
      name: 'Team Work',
      path: path.join(config.worktreeRoot, 'ws-Team-Work-12345678'),
      repos: [first, second],
      dangerouslySkipPermissions: false,
    }]);
    assert.equal(fs.existsSync(config.projects[0].path), false);
    assert.equal(connection.sent.some((frame) => frame.type === 'error'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('add-session under a name a live session already holds adds it under the next free name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-control-add-taken-'));
  try {
    const existing: ProjectEntry = { id: 'aaaaaaaa-existing', name: 'general-projects', path: root };
    const config: { projects: ProjectEntry[] } = { projects: [existing] };
    const existingSession = new Session({ id: existing.id, name: existing.name, path: root, ptySpawn: () => fakePty() });
    const server = createControlServer(controlDeps(config, { sessions: new Map([[existing.id, existingSession]]), generateProjectId: () => 'bbbbbbbb-added' }));
    const connection = connectControl<{ type: string; requestId?: string; ok?: boolean; error?: string | null; sessionId?: string }>(server);
    connection.send({ type: 'add-session', requestId: 'a1', name: 'general-projects', path: root });
    assert.deepEqual(connection.sent.find((frame) => frame.requestId === 'a1'), { type: 'add-session-result', requestId: 'a1', ok: true, error: null, sessionId: 'bbbbbbbb-added' });
    assert.equal(config.projects[1]?.name, 'general-projects (2)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('add-session for a shell with no folder runs it in the home folder', () => {
  const config: { projects: ProjectEntry[] } = { projects: [] };
  const server = createControlServer(controlDeps(config, { generateProjectId: () => 'cccccccc-shell' }));
  const connection = connectControl<{ type: string; requestId?: string; ok?: boolean }>(server);
  connection.send({ type: 'add-session', requestId: 's1', name: 'shell', path: '', agent: 'shell' });
  assert.equal(connection.sent.find((frame) => frame.requestId === 's1')?.ok, true);
  assert.equal(config.projects[0]?.path, os.homedir());
  assert.equal(config.projects[0]?.agent, 'shell');
});

test('quick-session copies a workspace session under the next free name, guarded once its guardrails were released, without its conversation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-control-workspace-'));
  try {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    const worktreeRoot = path.join(root, 'worktrees');
    const source: ProjectEntry = {
      id: 'aaaaaaaa-source',
      name: 'Team Work (2)',
      customTitle: 'Fix the login page',
      path: path.join(worktreeRoot, 'ws-Team-Work-2-aaaaaaaa'),
      repos: [first, second],
      baseBranch: 'staging',
      dangerouslySkipPermissions: true,
      unguarded: true,
      resumeSessionId: 'conversation-of-the-source',
      wasWorking: true,
    };
    const config: { projects: ProjectEntry[]; worktreeRoot: string } = { projects: [source], worktreeRoot };
    const sourceSession = new Session({ id: source.id, name: source.name, path: source.path, workspaceRepos: source.repos, dangerouslySkipPermissions: true, isMarkedUnguarded: true, isGuardrailsReleased: true, ptySpawn: () => fakePty() });
    const server = createControlServer(controlDeps(config, { sessions: new Map([[source.id, sourceSession]]), generateProjectId: () => 'bbbbbbbb-copy' }));
    const connection = connectControl<{ type: string; requestId?: string; ok?: boolean; sessionId?: string }>(server);
    connection.send({ type: 'quick-session', id: source.id, requestId: 'q1' });
    assert.deepEqual(config.projects[1], {
      baseBranch: 'staging',
      id: 'bbbbbbbb-copy',
      name: 'Team Work',
      path: path.join(worktreeRoot, 'ws-Team-Work-bbbbbbbb'),
      repos: [first, second],
      dangerouslySkipPermissions: true,
    });
    assert.deepEqual(connection.sent.find((frame) => frame.requestId === 'q1'), { type: 'add-session-result', requestId: 'q1', ok: true, error: null, sessionId: 'bbbbbbbb-copy' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('remove-session refuses a worktree with uncommitted work its badge has not seen, even on a discard nobody confirmed, then removes it once clean', { skip: !hasGit() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-control-remove-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-b', 'main'], repo);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Remove Test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial'], repo);
    const worktreeDir = path.join(root, 'worktree');
    git(['worktree', 'add', '-b', 'session-branch', worktreeDir, 'main'], repo);
    const session = new Session({ id: 'remove-probe-session', name: 'Remove Probe', path: repo, gitWorkspace: createGitWorkspace() });
    session.adoptWorktree({ worktreeDir, branch: 'session-branch', base: 'main', hasUnmergedWork: false, watch: false, emit: false });
    fs.writeFileSync(path.join(worktreeDir, 'unsaved.txt'), 'unsaved');
    const config = { projects: [{ id: 'remove-probe-session', name: 'Remove Probe', path: repo }] };
    const control = connectControl<{ type: string; requestId?: string; ok?: boolean; error?: string | null; canDiscardWork?: boolean }>(createControlServer(controlDeps(config, { sessions: new Map([['remove-probe-session', session]]) })));
    const replyTo = (requestId: string) => control.sent.find((frame) => frame.requestId === requestId);

    assert.equal(session.mergeStatus, 'none');
    control.send({ type: 'remove-session', id: 'remove-probe-session', requestId: 'unseen-discard', discardWork: true });
    await waitFor(() => replyTo('unseen-discard') !== undefined, 'unseen discard replied', 10000);
    assert.equal(replyTo('unseen-discard')?.ok, false);
    assert.deepEqual(config.projects.map((project) => project.id), ['remove-probe-session']);

    control.send({ type: 'remove-session', id: 'remove-probe-session', requestId: 'dirty' });
    await waitFor(() => replyTo('dirty') !== undefined, 'dirty removal replied', 10000);
    assert.deepEqual(replyTo('dirty'), { type: 'remove-session-result', requestId: 'dirty', ok: false, error: '"Remove Probe" has uncommitted changes or commits not merged into its base branch. Removing it deletes them.', canDiscardWork: true });
    assert.deepEqual(config.projects.map((project) => project.id), ['remove-probe-session']);

    fs.rmSync(path.join(worktreeDir, 'unsaved.txt'));
    control.send({ type: 'remove-session', id: 'remove-probe-session', requestId: 'clean' });
    await waitFor(() => replyTo('clean') !== undefined, 'clean removal replied', 10000);
    assert.equal(replyTo('clean')?.ok, true);
    assert.deepEqual(config.projects, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
