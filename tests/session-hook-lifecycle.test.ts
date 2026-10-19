import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HookRouter } from '../detection/hook-source.ts';
import { listAgentIds, getAdapter } from '../session/adapters/index.ts';
import { GUARDRAILS_UNAPPLIED_ERROR, Session } from '../session/sessions.ts';
import type { SessionGuardrailsFacts } from '../session/sessions.ts';
import { buildAgentEnv } from '../session/core/spawn-env.ts';
import { HOOK_URL_ENV } from '../session/core/hook-relay-core.ts';
import { AGENT_URL_ENV } from '../shared/contracts/session.ts';
import grok from '../session/adapters/grok.ts';
import { renderGrokHooksFile } from '../session/core/grok-hooks-file-core.ts';
import { saneYoloHomeDir } from '../server/hook-tools.ts';
import { createSessionFactory } from '../server/session/session-factory.ts';
import { installFakeCoherence } from './helpers/coherence-cli.ts';
import { codexHookHashes } from '../server/coherence/core/coherence-codex-trust-core.ts';
import type { HooksBlock } from '../session/core/user-hooks-core.ts';
import { fakePty } from './helpers/fake-pty.ts';
import type { SpawnCall } from './helpers/fake-pty.ts';

const PORT = 41234;

function sessionFor(agentId: string, baseDir: string, settingsGuardrails: Record<string, unknown> | null = null) {
  const calls: SpawnCall[] = [];
  const session = new Session({
    settingsGuardrails,
    id: `session-${agentId}`,
    name: agentId,
    path: baseDir,
    agent: agentId,
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

test('extra hooks reach settings when no project hook callback is configured', async () => {
  await withTempDir(async (directory) => {
    const session = new Session({
      id: 'extra-hooks', name: 'Extra hooks', path: directory,
      hookRouter: new HookRouter(), getHookPort: () => PORT, hooksBaseDir: directory,
      spawnCommand: { path: process.execPath, kind: 'exe' }, ptySpawn: () => fakePty(),
      extraUserHooks: [{ id: 'extra-stop', name: 'Extra stop', event: 'Stop', type: 'command', command: 'extra-stop', enabled: true }],
    });
    try {
      await session.start();
      const settings = JSON.parse(fs.readFileSync(path.join(directory, 'extra-hooks', 'settings.json'), 'utf8')) as { hooks: HooksBlock };
      assert.deepEqual(settings.hooks.Stop.at(-1), { hooks: [{ type: 'command', command: 'extra-stop' }] });
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

test('settings guardrails reach the hook settings file verbatim as the Claude Code sandbox key, and no sandbox key is written without them', async () => {
  await withTempDir(async (dir) => {
    const guardrails = { enabled: true, failIfUnavailable: true, filesystem: { denyRead: ['~/.ssh'] } };
    const guarded = sessionFor('claude-code', dir, guardrails);
    const plain = sessionFor('claude-code', path.join(dir, 'plain'));
    try {
      await guarded.session.start();
      await plain.session.start();
      const readSettings = (base: string) => JSON.parse(fs.readFileSync(path.join(base, 'session-claude-code', 'settings.json'), 'utf8'));
      assert.deepEqual(readSettings(dir).sandbox, guardrails);
      assert.equal('sandbox' in readSettings(path.join(dir, 'plain')), false);
      assert.equal(guarded.calls[0].args.filter((arg) => arg === '--settings').length, 1, 'the Claude Code sandbox block rides the one hooks settings file');
    } finally {
      guarded.session.destroy();
      plain.session.destroy();
    }
  });
});

async function startRefused(overrides: Partial<ConstructorParameters<typeof Session>[0]>): Promise<{ spawned: number; errors: string[] }> {
  let spawned = 0;
  const errors: string[] = [];
  const session = new Session({
    id: 'session-guarded',
    name: 'guarded',
    path: os.tmpdir(),
    agent: 'claude-code',
    spawnCommand: { path: process.execPath, kind: 'exe' },
    settingsGuardrails: { enabled: true, failIfUnavailable: true },
    hookRouter: new HookRouter(),
    getHookPort: () => PORT,
    ptySpawn: () => {
      spawned += 1;
      return fakePty();
    },
    ...overrides,
  });
  session.on('error', (error: Error) => { errors.push(error.message); });
  try {
    await session.start();
  } finally {
    session.destroy();
  }
  return { spawned, errors };
}

test('a session that requests guardrails refuses to spawn when no hook router can carry the settings file', async () => {
  assert.deepEqual(await startRefused({ hookRouter: null }), { spawned: 0, errors: [GUARDRAILS_UNAPPLIED_ERROR] });
});

test('a session that requests guardrails refuses to spawn when the hook listener port is unavailable', async () => {
  assert.deepEqual(await startRefused({ getHookPort: () => null }), { spawned: 0, errors: [GUARDRAILS_UNAPPLIED_ERROR] });
  assert.deepEqual(await startRefused({ getHookPort: () => { throw new Error('no listener'); } }), { spawned: 0, errors: [GUARDRAILS_UNAPPLIED_ERROR] });
});

test('a session that requests guardrails refuses to spawn when the settings file cannot be written', async () => {
  await withTempDir(async (dir) => {
    const occupiedBaseDir = path.join(dir, 'occupied');
    fs.writeFileSync(occupiedBaseDir, 'not a directory');
    assert.deepEqual(await startRefused({ hooksBaseDir: occupiedBaseDir }), { spawned: 0, errors: [GUARDRAILS_UNAPPLIED_ERROR] });
  });
});

test('a session with outer guardrails spawns only the wrapped command with the agent sandbox off, and never spawns when the guardrails refuse or its settings file is missing', async () => {
  await withTempDir(async (dir) => {
    const calls: SpawnCall[] = [];
    let disposals = 0;
    const rtkBinPath = path.join(dir, 'rtk');
    const rtkDataDir = path.join(dir, 'rtk-data');
    const session = new Session({
      id: 'session-wrapped',
      name: 'wrapped',
      path: dir,
      agent: 'claude-code',
      spawnCommand: { path: process.execPath, kind: 'exe' },
      settingsGuardrails: { enabled: true, failIfUnavailable: true },
      hookRouter: new HookRouter(),
      getHookPort: () => PORT,
      hooksBaseDir: dir,
      hookTools: [{ id: 'rtk', binPath: rtkBinPath, dataDir: rtkDataDir }],
      prepareGuardrails: async (facts) => ({
        ok: true,
        launch: {
          wrap: async (file, args) => ({ file: 'sandbox-runtime', args: ['--', file, ...args] }),
          env: { PROBED_FACTS: JSON.stringify(facts) },
          dispose: async () => { disposals += 1; },
        },
      }),
      ptySpawn: (file, args, opts) => {
        calls.push({ file, args, opts: opts as SpawnCall['opts'] });
        return fakePty();
      },
    });
    try {
      await session.start();
      const settingsDir = path.join(dir, 'session-wrapped');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].file, 'sandbox-runtime');
      assert.equal(calls[0].args[0], '--');
      assert.ok(calls[0].args.includes('--settings'), 'the agent command rides behind the wrap');
      const { launchId, agentSessionId, ...factsBesideIds } = JSON.parse(String(calls[0].opts.env.PROBED_FACTS)) as SessionGuardrailsFacts;
      assert.match(launchId, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      assert.equal(calls[0].args[calls[0].args.indexOf('--session-id') + 1], agentSessionId, 'the guardrails are told the session id the agent is started with');
      assert.deepEqual(factsBesideIds, { cwd: dir, hookPort: PORT, readablePaths: [settingsDir, rtkBinPath], writablePaths: [rtkDataDir] });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8')).sandbox, { enabled: false });
    } finally {
      session.destroy();
    }
    assert.equal(disposals, 1, 'the launch is disposed with the session');
    const wrappedWithoutSettingsGuardrails = {
      settingsGuardrails: null,
      prepareGuardrails: async () => ({
        ok: true as const,
        launch: { wrap: async (file: string, args: readonly string[]) => ({ file, args: [...args] }), env: {}, dispose: async () => {} },
      }),
    };
    const refusedUnapplied = { spawned: 0, errors: [GUARDRAILS_UNAPPLIED_ERROR] };
    const occupiedBaseDir = path.join(dir, 'occupied');
    fs.writeFileSync(occupiedBaseDir, 'not a directory');
    assert.deepEqual(await startRefused({ ...wrappedWithoutSettingsGuardrails, hookRouter: null }), refusedUnapplied);
    assert.deepEqual(await startRefused({ ...wrappedWithoutSettingsGuardrails, getHookPort: () => null }), refusedUnapplied);
    assert.deepEqual(await startRefused({ ...wrappedWithoutSettingsGuardrails, hooksBaseDir: occupiedBaseDir }), refusedUnapplied);
  });
  const refusedMessage = 'session not started, the guardrails refused: bwrap is not on PATH';
  assert.deepEqual(await startRefused({ prepareGuardrails: async () => ({ ok: false, reason: 'bwrap is not on PATH' }) }), { spawned: 0, errors: [refusedMessage] });
  assert.deepEqual(await startRefused({ prepareGuardrails: async () => { throw new Error('bwrap is not on PATH'); } }), { spawned: 0, errors: [refusedMessage] });
});

test('a session without guardrails still spawns on the OSC title fallback when hooks cannot be injected', async () => {
  assert.deepEqual(await startRefused({ settingsGuardrails: null, hookRouter: null }), { spawned: 1, errors: [] });
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

test('each harness inherits Sane YOLO policy and bin env through its hook injection', async () => {
  for (const agentId of ['claude-code', 'codex', 'grok']) {
    await withTempDir(async (directory) => {
      const priorGrokHome = process.env.GROK_HOME;
      process.env.GROK_HOME = path.join(directory, 'grok');
      const grokInjection = grok.hooks.injection;
      assert.equal(grokInjection.kind, 'home-hooks-file');
      if (grokInjection.kind !== 'home-hooks-file') throw new Error('Grok requires home hook injection');
      const hooksPath = grokInjection.filePath(process.env);
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      const expectedContents = grokInjection.expectedContents();
      assert.ok(expectedContents);
      fs.writeFileSync(hooksPath, expectedContents);
      const calls: SpawnCall[] = [];
      const session = new Session({
        id: `guard-${agentId}`, name: `guard-${agentId}`, path: directory, agent: agentId,
        hookTools: [{ id: 'saneYolo', binPath: '/g/guard.js' }],
        bypassHookTrust: agentId === 'codex',
        hookRouter: new HookRouter(), getHookPort: () => PORT, hooksBaseDir: directory,
        spawnCommand: { path: process.execPath, kind: 'exe' },
        ptySpawn: (file, args, opts) => { calls.push({ file, args, opts: opts as SpawnCall['opts'] }); return fakePty(); },
      });
      try {
        await session.start();
        const env = calls[0].opts.env;
        assert.equal(env.GLIMMERVOID_SANE_YOLO_PATH, '/g/guard.js', agentId);
        assert.equal(env.CC_SAFETY_NET_HOME, saneYoloHomeDir(), agentId);
        assert.equal(env.CC_SAFETY_NET_AUDIT_HOME, env.CC_SAFETY_NET_HOME, agentId);
        assert.equal(env.CC_SAFETY_NET_AUDIT_SCOPE, 'blocked', agentId);
        assert.equal(env.CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY, '1', agentId);
      } finally {
        session.destroy();
        if (priorGrokHome === undefined) delete process.env.GROK_HOME;
        if (priorGrokHome !== undefined) process.env.GROK_HOME = priorGrokHome;
      }
    });
  }
});

async function grokSaneYoloWarnings(
  hooksContents: string | null,
  hookTools: { id: 'saneYolo' | 'rtk'; binPath: string }[],
  warn: (message: string) => void,
): Promise<number> {
  let spawnCount = 0;
  await withTempDir(async (directory) => {
    const priorGrokHome = process.env.GROK_HOME;
    process.env.GROK_HOME = path.join(directory, 'grok');
    const hooksPath = grok.hooksFilePath(process.env);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    assert.ok(hooksContents);
    fs.writeFileSync(hooksPath, hooksContents);
    const session = new Session({
      id: 'grok-sane-yolo-warning', name: 'grok-sane-yolo-warning', path: directory, agent: 'grok',
      hookTools,
      hookRouter: new HookRouter(), getHookPort: () => PORT, hooksBaseDir: directory,
      spawnCommand: { path: process.execPath, kind: 'exe' },
      ptySpawn: () => { spawnCount += 1; return fakePty(); },
    });
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      await session.start();
      await session.start();
    } finally {
      console.warn = originalWarn;
      session.destroy();
      if (priorGrokHome === undefined) delete process.env.GROK_HOME;
      if (priorGrokHome !== undefined) process.env.GROK_HOME = priorGrokHome;
    }
  });
  return spawnCount;
}

test('a Grok Sane YOLO session on a pre-Sane-YOLO hooks file warns once per session naming the setup command', async () => {
  const saneYoloTool = { id: 'saneYolo' as const, binPath: '/g/guard.js' };
  const preSaneYoloContents = renderGrokHooksFile({ relayPath: grok.RELAY_PATH, events: grok.HOOK_EVENTS });
  const currentContents = grok.hooks.injection.kind === 'home-hooks-file' ? grok.hooks.injection.expectedContents() : null;
  const cases = [
    { contents: preSaneYoloContents, hookTools: [saneYoloTool], expectedWarnings: 1 },
    { contents: currentContents, hookTools: [saneYoloTool], expectedWarnings: 0 },
    { contents: preSaneYoloContents, hookTools: [], expectedWarnings: 0 },
  ];
  for (const { contents, hookTools, expectedWarnings } of cases) {
    const warnings: string[] = [];
    const spawnCount = await grokSaneYoloWarnings(contents, hookTools, (message) => { warnings.push(message); });
    const saneYoloWarnings = warnings.filter((message) => message.includes('Sane YOLO'));
    assert.equal(spawnCount, 2);
    assert.equal(saneYoloWarnings.length, expectedWarnings, warnings.join('\n'));
    for (const message of saneYoloWarnings) assert.match(message, /glimmervoid agent setup grok/);
  }
});

interface SaneYoloSpawnCase {
  agentId: string;
  grokHooksContents?: string | null;
  bypassHookTrust?: boolean;
  hasCodexHooksFile?: boolean;
  hookRouter?: HookRouter | null;
  isHooksBaseDirBlocked?: boolean;
  hookTools?: { id: 'saneYolo' | 'rtk'; binPath: string }[];
}

interface SaneYoloSpawnOutcome {
  beforeStart: boolean;
  afterStart: boolean;
  spawnEnv: Record<string, string | undefined> | null;
}

async function saneYoloFlagsAroundStart(spawnCase: SaneYoloSpawnCase): Promise<SaneYoloSpawnOutcome> {
  let flags: SaneYoloSpawnOutcome = { beforeStart: true, afterStart: true, spawnEnv: null };
  const calls: SpawnCall[] = [];
  await withTempDir(async (directory) => {
    const priorGrokHome = process.env.GROK_HOME;
    process.env.GROK_HOME = path.join(directory, 'grok');
    const hooksPath = grok.hooksFilePath(process.env);
    if (typeof spawnCase.grokHooksContents === 'string') {
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, spawnCase.grokHooksContents);
    }
    const sessionDir = path.join(directory, 'project');
    fs.mkdirSync(sessionDir);
    if (spawnCase.hasCodexHooksFile) {
      fs.mkdirSync(path.join(sessionDir, '.codex'));
      fs.writeFileSync(path.join(sessionDir, '.codex', 'hooks.json'), '{}');
    }
    const hooksBaseDir = path.join(directory, 'hooks');
    if (spawnCase.isHooksBaseDirBlocked) fs.writeFileSync(hooksBaseDir, 'not a directory');
    const session = new Session({
      id: `sane-yolo-${spawnCase.agentId}`, name: `sane-yolo-${spawnCase.agentId}`, path: sessionDir, agent: spawnCase.agentId,
      hookTools: spawnCase.hookTools ?? [{ id: 'saneYolo', binPath: '/g/guard.js' }],
      bypassHookTrust: spawnCase.bypassHookTrust === true,
      hookRouter: spawnCase.hookRouter === undefined ? new HookRouter() : spawnCase.hookRouter,
      getHookPort: () => PORT, hooksBaseDir,
      spawnCommand: { path: process.execPath, kind: 'exe' },
      ptySpawn: (file, args, opts) => { calls.push({ file, args, opts: opts as SpawnCall['opts'] }); return fakePty(); },
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const beforeStart = session.saneYolo;
      await session.start();
      flags = { beforeStart, afterStart: session.saneYolo, spawnEnv: calls[0]?.opts.env ?? null };
    } finally {
      console.warn = originalWarn;
      session.destroy();
      if (priorGrokHome === undefined) delete process.env.GROK_HOME;
      if (priorGrokHome !== undefined) process.env.GROK_HOME = priorGrokHome;
    }
  });
  return flags;
}

test('Sane YOLO reads active only after a spawn that actually placed the guard hook', async () => {
  const currentGrokContents = grok.hooks.injection.kind === 'home-hooks-file' ? grok.hooks.injection.expectedContents() : null;
  const preSaneYoloGrokContents = renderGrokHooksFile({ relayPath: grok.RELAY_PATH, events: grok.HOOK_EVENTS });
  const cases: { label: string; spawnCase: SaneYoloSpawnCase; isActive: boolean }[] = [
    { label: 'claude settings written', spawnCase: { agentId: 'claude-code' }, isActive: true },
    { label: 'claude settings write failed', spawnCase: { agentId: 'claude-code', isHooksBaseDirBlocked: true }, isActive: false },
    { label: 'claude without a hook router', spawnCase: { agentId: 'claude-code', hookRouter: null }, isActive: false },
    { label: 'claude with the guard off', spawnCase: { agentId: 'claude-code', hookTools: [] }, isActive: false },
    { label: 'codex with the trust bypass applied', spawnCase: { agentId: 'codex', bypassHookTrust: true }, isActive: true },
    { label: 'codex without the trust bypass', spawnCase: { agentId: 'codex' }, isActive: false },
    { label: 'codex with the trust bypass refused', spawnCase: { agentId: 'codex', bypassHookTrust: true, hasCodexHooksFile: true }, isActive: false },
    { label: 'grok with a current hooks file', spawnCase: { agentId: 'grok', grokHooksContents: currentGrokContents }, isActive: true },
    { label: 'grok with a pre-Sane-YOLO hooks file', spawnCase: { agentId: 'grok', grokHooksContents: preSaneYoloGrokContents }, isActive: false },
    { label: 'grok with no hooks file', spawnCase: { agentId: 'grok', grokHooksContents: null }, isActive: false },
  ];
  for (const { label, spawnCase, isActive } of cases) {
    const flags = await saneYoloFlagsAroundStart(spawnCase);
    assert.equal(flags.beforeStart, false, `${label}: before start`);
    assert.equal(flags.afterStart, isActive, `${label}: after start`);
    assert.ok(flags.spawnEnv, `${label}: spawned`);
    assert.equal(flags.spawnEnv.GLIMMERVOID_SANE_YOLO_PATH !== undefined, isActive, `${label}: Sane YOLO bin env`);
    const expectedSafetyNetHome = isActive ? saneYoloHomeDir() : process.env.CC_SAFETY_NET_HOME;
    assert.equal(flags.spawnEnv.CC_SAFETY_NET_HOME, expectedSafetyNetHome, `${label}: Sane YOLO policy env`);
  }
});

test('an unguarded Codex spawn keeps the inherited cc-safety-net env untouched', async () => {
  const inheritedSafetyNetEnv = { CC_SAFETY_NET_HOME: '/operator/safety-net', CC_SAFETY_NET_PARANOID: '1' };
  const priorSafetyNetEnv = { CC_SAFETY_NET_HOME: process.env.CC_SAFETY_NET_HOME, CC_SAFETY_NET_PARANOID: process.env.CC_SAFETY_NET_PARANOID };
  Object.assign(process.env, inheritedSafetyNetEnv);
  try {
    const flags = await saneYoloFlagsAroundStart({ agentId: 'codex' });
    assert.equal(flags.afterStart, false);
    assert.ok(flags.spawnEnv);
    assert.equal(flags.spawnEnv.CC_SAFETY_NET_HOME, inheritedSafetyNetEnv.CC_SAFETY_NET_HOME);
    assert.equal(flags.spawnEnv.CC_SAFETY_NET_PARANOID, inheritedSafetyNetEnv.CC_SAFETY_NET_PARANOID);
  } finally {
    for (const [key, value] of Object.entries(priorSafetyNetEnv)) {
      if (value === undefined) delete process.env[key];
      if (value !== undefined) process.env[key] = value;
    }
  }
});


test('operator Claude and Codex sessions resolve optional repository Coherence without blocking spawn', async () => {
  await withTempDir(async (directory) => {
    const priorCodexHome = process.env.CODEX_HOME;
    const codexHome = path.join(directory, 'codex-home');
    fs.mkdirSync(codexHome);
    process.env.CODEX_HOME = codexHome;
    const config = { projects: [], recordSignals: false, coherence: { enabled: true } };
    const makeSession = createSessionFactory({
      configStore: { configPath: path.join(directory, 'config.json') }, getConfig: () => config,
      hookRouter: new HookRouter(), getHookPort: () => PORT,
      getGitWorkspace: () => null, getPlanReviewPort: () => null,
      resolveHookTools: () => [], getUserHooks: () => [],
    });
    try {
      for (const agent of ['claude-code', 'codex']) {
        for (const installation of ['supported', 'absent', 'unsupported', 'unreadable', 'hooks-missing', 'setting-off', 'lane', 'symlink']) {
          const id = `${agent}-${installation}`;
          const worktree = path.join(directory, id);
          fs.mkdirSync(worktree);
          if (installation !== 'absent') await installFakeCoherence(worktree, { version: installation === 'unsupported' ? '0.37.1' : installation === 'unreadable' ? 'unknown' : '1.8.0', hooksExitCode: installation === 'hooks-missing' ? 1 : 0 });
          if (installation === 'symlink') {
            const sharedModules = path.join(directory, `${id}-modules`);
            fs.renameSync(path.join(worktree, 'node_modules'), sharedModules);
            fs.symlinkSync(sharedModules, path.join(worktree, 'node_modules'), 'junction');
          }
          if (agent === 'codex') {
            const hooksPath = path.join(worktree, '.codex', 'hooks.json');
            fs.mkdirSync(path.dirname(hooksPath));
            const text = fs.readFileSync(new URL('./fixtures/coherence/1.8.0/codex-hooks.json', import.meta.url), 'utf8');
            fs.writeFileSync(hooksPath, text);
            fs.writeFileSync(path.join(codexHome, 'config.toml'), [...codexHookHashes(hooksPath, text)].map(([key, hash]) => `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}`).join('\n'));
          }
          config.coherence.enabled = installation !== 'setting-off';
          const session = makeSession({ id, name: id, path: worktree, agent }, config, { ephemeral: installation === 'lane' });
          const calls: SpawnCall[] = [];
          session._spawnCommand = { path: process.execPath, kind: 'exe' };
          session._ptySpawn = (file, args, opts) => { calls.push({ file, args, opts: opts as SpawnCall['opts'] }); return fakePty(); };
          try {
            await session.start();
            assert.equal(calls.length, 1, id);
            const expectedByInstall = {
              supported: { active: true }, symlink: { active: true },
              absent: { active: false, reason: 'not installed' },
              unsupported: { active: false, reason: 'unsupported version', version: '0.37.1' },
              unreadable: { active: false, reason: 'version output unreadable' },
              'hooks-missing': { active: false, reason: 'check failed with exit code 1' },
              'setting-off': null, lane: null,
            };
            assert.deepEqual(session.toSnapshot().coherenceHooks, expectedByInstall[installation as keyof typeof expectedByInstall], id);
            if (installation === 'hooks-missing' || installation === 'absent' || installation === 'unsupported') {
              await installFakeCoherence(worktree);
              await session.refreshCoherenceHooks();
              assert.deepEqual(session.coherenceHooks, { active: true }, id);
            }
            const callLog = path.join(worktree, 'coherence-calls.jsonl');
            if (fs.existsSync(callLog)) {
              const probes = fs.readFileSync(callLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
              assert.equal(probes.filter(({ args }) => args[0] === 'version').length, installation === 'unsupported' ? 2 : 1, id);
              assert.ok(probes.every(({ env }) => env.COHERENCE_NO_UPDATE_CHECK === '1' && !('CODEX_THREAD_ID' in env) && !('GLIMMERVOID_POSTHOG_API_KEY' in env)), id);
            }
            if (agent === 'claude-code') {
              const args = calls[0].args;
              const settings = fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8');
              assert.equal(settings.includes('coherence'), false, id);
            }
          } finally {
            session.destroy();
          }
        }
      }
    } finally {
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      if (priorCodexHome !== undefined) process.env.CODEX_HOME = priorCodexHome;
    }
  });
});
