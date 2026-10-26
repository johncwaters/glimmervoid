import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectEntry } from '../server/config-store.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { Session } from '../session/sessions.ts';

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

test('add-session rejects a missing workspace repository before saving', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-control-workspace-'));
  try {
    const config = { projects: [] };
    const server = createControlServer(controlDeps(config));
    const connection = connectControl<{ type: string; message?: string }>(server);
    connection.send({ type: 'add-session', name: 'Team Work', path: root, repos: [root, path.join(root, 'missing')] });
    assert.deepEqual(config.projects, []);
    assert.equal(connection.sent.some((frame) => frame.type === 'error'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
