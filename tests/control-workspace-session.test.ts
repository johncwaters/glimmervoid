import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectEntry } from '../server/config-store.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

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
