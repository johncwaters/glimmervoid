import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import type { CoherenceHooksState } from '../shared/contracts/session.ts';

interface ArgvCall {
  file: string;
  args: string[];
}

function fakePty(pid = 2147483646) {
  return {
    pid,
    onData() {},
    onExit() {},
    write() {},
    resize() {},
    kill() {},
  };
}

test('start() spawns the injected exe directly (no cmd.exe layer)', { skip: process.platform !== 'win32' }, async () => {
  const calls: ArgvCall[] = [];
  const s = new Session({
    id: 'spawn-int',
    name: 'spawn-int',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
  });
  try {
    await s.start();
    assert.equal(calls.length, 1, 'pty spawner called exactly once');
    assert.equal(calls[0].file, process.execPath, 'spawned the injected exe path');
    assert.notEqual(calls[0].file, 'cmd.exe');
    assert.ok(!calls[0].args.includes('/c'), 'no cmd /c token in args');
    assert.equal(s.state, STATES.STARTING, `expected STARTING after spawn, got ${s.state}`);
  } finally {
    s.destroy();
  }
});

test('start() routes a .cmd shim command through cmd.exe /c claude', { skip: process.platform !== 'win32' }, async () => {
  const calls: ArgvCall[] = [];
  const s = new Session({
    id: 'spawn-shim',
    name: 'spawn-shim',
    path: process.cwd(),
    spawnCommand: { path: 'C:\\nope\\claude.cmd', kind: 'shim' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
  });
  try {
    await s.start();
    assert.equal(calls.length, 1, 'pty spawner called exactly once');
    assert.equal(calls[0].file, 'cmd.exe', 'shim install routes through cmd.exe');
    assert.deepEqual(calls[0].args.slice(0, 2), ['/c', 'claude']);
  } finally {
    s.destroy();
  }
});

test('start() announces the Coherence hooks state it records, a turn end rechecks hooks so installed or stale hooks take effect mid-session, and a refresh outlived by a restart never overwrites the restart verdict', async () => {
  const announced: unknown[] = [];
  let preparedHooks: CoherenceHooksState = { active: false, reason: 'check failed with exit code 1' };
  let prepareCount = 0;
  let deferredPrepare: Promise<CoherenceHooksState> | null = null;
  let firePtyExit = () => {};
  const s = new Session({
    id: 'spawn-coherence',
    name: 'spawn-coherence',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: () => ({
      ...fakePty(),
      onExit(listener: (event: { exitCode: number }) => void) { firePtyExit = () => listener({ exitCode: 0 }); },
    }),
    prepareCoherence: async () => {
      prepareCount += 1;
      return {
        hooks: preparedHooks, version: '1.8.0',
        refreshHooks: async () => {
          prepareCount += 1;
          return deferredPrepare ?? preparedHooks;
        },
        healHooks: async () => ({ status: 'not-needed' as const }),
        readVerdictBaseline: async () => null,
        rerunTouchedVerdicts: async () => ({ head: 'HEAD', observed: {}, hasSpecProblems: null }),
        readJournal: async () => ({ branch: null, escalations: [], records: [], citedBy: {}, damaged: [] }),
      };
    },
  });
  s.on('coherence-hooks-change', (state) => announced.push(state));
  try {
    await s.start();
    assert.deepEqual(announced, [{ active: false, reason: 'check failed with exit code 1' }]);
    assert.deepEqual(s.coherenceHooks, { active: false, reason: 'check failed with exit code 1' });
    await s.refreshCoherenceHooks();
    assert.equal(announced.length, 1);
    preparedHooks = { active: true };
    await s.refreshCoherenceHooks();
    await s.refreshCoherenceHooks();
    assert.deepEqual(announced, [{ active: false, reason: 'check failed with exit code 1' }, { active: true }]);
    assert.equal(prepareCount, 4);

    preparedHooks = { active: false, reason: 'check failed with exit code 1' };
    firePtyExit();
    assert.equal(s.restart(), true);
    await s.start();
    let resolveStalePrepare: (state: CoherenceHooksState) => void = () => {};
    deferredPrepare = new Promise((resolve) => { resolveStalePrepare = resolve; });
    const staleRefresh = s.refreshCoherenceHooks();
    deferredPrepare = null;
    preparedHooks = { active: true };
    firePtyExit();
    assert.equal(s.restart(), true);
    await s.start();
    resolveStalePrepare({ active: false, reason: 'check failed with exit code 1' });
    await staleRefresh;
    assert.deepEqual(s.coherenceHooks, { active: true });
    assert.deepEqual(announced.slice(2), [{ active: false, reason: 'check failed with exit code 1' }, { active: true }]);
  } finally {
    s.destroy();
  }
});
