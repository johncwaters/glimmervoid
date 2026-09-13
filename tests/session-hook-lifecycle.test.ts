import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HookRouter } from '../detection/hook-source.ts';
import { listAgentIds, getAdapter } from '../session/adapters/index.ts';
import { Session } from '../session/sessions.ts';
import { buildAgentEnv } from '../session/core/spawn-env.ts';
import { HOOK_URL_ENV } from '../session/core/hook-relay-core.ts';
import { AGENT_URL_ENV } from '../shared/contracts/session.ts';
import { fakePty } from './helpers/fake-pty.ts';
import type { SpawnCall } from './helpers/fake-pty.ts';

const PORT = 41234;

function sessionFor(agentId: string, baseDir: string, agentApi = true) {
  const calls: SpawnCall[] = [];
  const session = new Session({
    id: `session-${agentId}`,
    name: agentId,
    path: baseDir,
    agent: agentId,
    agentApi,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    hookRouter: new HookRouter(),
    getHookPort: () => PORT,
    hooksBaseDir: baseDir,
    ptySpawn: (file, args, opts) => {
      calls.push({ file, args, opts: opts as SpawnCall['opts'] });
      return fakePty();
    },
  });
  return { session, calls };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-hooklifecycle-'));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('every agent spawns with an agent API url on the loopback listener', async () => {
  for (const agentId of listAgentIds()) {
    await withTempDir(async (dir) => {
      const { session, calls } = sessionFor(agentId, dir);
      try {
        await session.start();
        const url = String(calls[0]?.opts.env[AGENT_URL_ENV]);
        assert.ok(url.startsWith(`http://127.0.0.1:${PORT}/agent/session-${agentId}?t=`), `${agentId}: ${url}`);
        assert.equal(new URL(url).searchParams.get('t'), session.agentToken, `${agentId} carries its own token`);
      } finally {
        session.destroy();
      }
    });
  }
});

test('a session spawned with the agent API off is handed no agent url at all', async () => {
  await withTempDir(async (dir) => {
    const { session, calls } = sessionFor('claude-code', dir, false);
    try {
      await session.start();
      assert.equal(AGENT_URL_ENV in calls[0].opts.env, false, 'the default config leaks no agent url');
    } finally {
      session.destroy();
    }
  });
});

test('the agent token is a second token, never the hook token', async () => {
  await withTempDir(async (dir) => {
    const { session } = sessionFor('claude-code', dir);
    try {
      await session.start();
      const hookToken = session._hooks.token();
      const agentToken = session.agentToken;
      assert.ok(hookToken, 'the settings-file kind mints a hook token');
      assert.ok(agentToken, 'the session mints an agent token');
      assert.notEqual(agentToken, hookToken);
      const settingsPath = path.join(dir, 'session-claude-code', 'settings.json');
      assert.equal(fs.readFileSync(settingsPath, 'utf8').includes(String(agentToken)), false,
        'the agent token never lands in the hook settings file');
    } finally {
      session.destroy();
    }
  });
});

test('a restart keeps the one agent token the session was minted with', async () => {
  await withTempDir(async (dir) => {
    const { session } = sessionFor('claude-code', dir);
    try {
      await session.start();
      const first = session.agentToken;
      await session.start();
      assert.equal(session.agentToken, first, 'a second injection never rotates the credential');
    } finally {
      session.destroy();
    }
  });
});

test('destroying a session drops the agent token so a dead session authenticates nothing', async () => {
  await withTempDir(async (dir) => {
    const { session } = sessionFor('claude-code', dir);
    await session.start();
    assert.ok(session.agentToken);
    session.destroy();
    assert.equal(session.agentToken, null);
  });
});

test('a grandchild inherits neither the hook url nor the agent url', () => {
  const adapter = getAdapter('claude-code');
  assert.ok(adapter);
  const inherited = {
    PATH: '/usr/bin',
    [HOOK_URL_ENV]: `http://127.0.0.1:${PORT}/hook/session-1?t=hook-token`,
    [AGENT_URL_ENV]: `http://127.0.0.1:${PORT}/agent/session-1?t=agent-token`,
  };
  const env = buildAgentEnv(inherited, null, adapter.envProfile);
  assert.equal(HOOK_URL_ENV in env, false);
  assert.equal(AGENT_URL_ENV in env, false);
  assert.equal(env.PATH, '/usr/bin');
});

test('a freshly injected hook url survives the scrub that removes an inherited one', () => {
  const adapter = getAdapter('codex');
  assert.ok(adapter);
  const fresh = `http://127.0.0.1:${PORT}/hook/session-2?t=fresh`;
  const env = buildAgentEnv(
    { PATH: '/usr/bin', [HOOK_URL_ENV]: 'http://127.0.0.1:1/hook/stale?t=stale' },
    { [HOOK_URL_ENV]: fresh, [AGENT_URL_ENV]: 'http://127.0.0.1:1/agent/session-2?t=fresh' },
    adapter.envProfile,
  );
  assert.equal(env[HOOK_URL_ENV], fresh);
  assert.equal(env[AGENT_URL_ENV], 'http://127.0.0.1:1/agent/session-2?t=fresh');
});
