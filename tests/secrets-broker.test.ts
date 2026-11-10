import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend/backend.ts';
import { git, hasGit } from './helpers/git-fixture.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';
import { waitFor } from './helpers/wait-for.ts';

const SESSION_ID = 'secrets-restart-session';
const APPROVED_VALUE = 'kept-from-before-the-restart';
const UNAPPROVED_VALUE = 'the-project-own-setting';

test('a session wired after a restart masks the approved values already in the env file of its worktree', { skip: !hasGit() }, async () => {
  const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-secrets-restart-'));
  const projectDir = path.join(tmpDir, 'project');
  const worktreeDir = path.join(tmpDir, 'worktree');
  fs.mkdirSync(projectDir);
  git(['init', '-q'], projectDir);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'], projectDir);
  git(['worktree', 'add', '-q', worktreeDir, '-b', `glimmervoid/session/${SESSION_ID}`], projectDir);
  fs.writeFileSync(path.join(worktreeDir, '.env.local'), `APPROVED_KEY='${APPROVED_VALUE}'\nOWN_SETTING='${UNAPPROVED_VALUE}'\n`, 'utf8');
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: 'secrets restart', path: projectDir }],
    repoRoots: [],
    autoResume: false,
    secrets: { byProject: { [projectDir]: { APPROVED_KEY: { reference: 'op://vault/item/field', isAllowed: true } } } },
  }, null, 2), 'utf8');
  process.env.GLIMMERVOID_CONFIG = configPath;
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);
  try {
    const session = backend.getSession(SESSION_ID);
    assert.ok(session, 'the boot loop created the configured session');
    await waitFor(() => session.effectiveCwd() === worktreeDir, 'the session took its worktree back', 10_000);
    session.transition('user_start');
    await waitFor(() => session.deliveredSecretValues().length > 0, 'the session masks were seeded from the env file in its worktree', 10_000);
    assert.deepEqual([...session.deliveredSecretValues()], [APPROVED_VALUE], 'only the approved name is masked');
  } finally {
    await settleBackendShutdown(backend);
    server.closeAllConnections();
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousConfigPath === undefined) delete process.env.GLIMMERVOID_CONFIG;
    if (previousConfigPath !== undefined) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
  }
});
