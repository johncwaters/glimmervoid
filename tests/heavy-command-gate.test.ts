import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { classifyHeavyCommand, createHeavyCommandGate } from '../server/spawn-gate.ts';
import { createVerificationWiring } from '../server/verification/verification-wiring.ts';

test('classifyHeavyCommand detects heavy local commands and skips coordination commands', () => {
  assert.equal(classifyHeavyCommand('npx tsc --noEmit'), 'typecheck');
  assert.equal(classifyHeavyCommand('npm run typecheck'), 'typecheck');
  assert.equal(classifyHeavyCommand('npm test'), 'test');
  assert.equal(classifyHeavyCommand('node --test tests/foo.test.ts'), 'test');
  assert.equal(classifyHeavyCommand('node harness/browser/harness.ts --only studio'), 'browser-test');
  assert.equal(classifyHeavyCommand('npx playwright test'), 'browser-test');
  assert.equal(classifyHeavyCommand('npm run build'), 'build');
  assert.equal(classifyHeavyCommand('npm ci'), 'install');
  assert.equal(classifyHeavyCommand('npx biome check .'), 'lint');
  assert.equal(classifyHeavyCommand('git status'), null);
  assert.equal(classifyHeavyCommand('glimmervoid spawn "run npm test"'), null);
  assert.equal(classifyHeavyCommand('npm test && glimmervoid send s1 "done"'), 'test');
  assert.equal(classifyHeavyCommand('npx tsc --noEmit && glimmervoid attention "ready"'), 'typecheck');
});

test('createHeavyCommandGate serializes acquires in FIFO order and honors timeout, abort, releaseSession, and stop', async () => {
  const gate = createHeavyCommandGate({ maxSlots: 1, defaultLeaseTtlMs: Number.POSITIVE_INFINITY });
  const first = await gate.acquire({ sessionId: 's1', toolUseId: 't1', commandClass: 'typecheck' });
  assert.equal(first.status, 'granted');
  assert.equal(gate.snapshot().active.length, 1);

  const timedOut = await gate.acquire({ sessionId: 's2', commandClass: 'test', maxWaitMs: 15 });
  assert.deepEqual(timedOut, { status: 'timeout' });

  const abortController = new AbortController();
  const abortedPromise = gate.acquire({ sessionId: 's3', commandClass: 'test', signal: abortController.signal });
  abortController.abort();
  assert.deepEqual(await abortedPromise, { status: 'aborted' });

  const sameSessionQueued = gate.acquire({ sessionId: 's1', toolUseId: 't2', commandClass: 'build' });
  const secondPromise = gate.acquire({ sessionId: 's2', toolUseId: 't3', commandClass: 'test', maxWaitMs: Number.POSITIVE_INFINITY });
  assert.equal(gate.snapshot().queuedCount, 2);

  gate.releaseSession('s1');
  assert.deepEqual(await sameSessionQueued, { status: 'aborted' });
  const second = await secondPromise;
  assert.equal(second.status, 'granted');
  assert.equal(gate.snapshot().active.length, 1);

  gate.releaseSession('s2');
  assert.equal(gate.snapshot().active.length, 0);

  gate.stop();
  assert.deepEqual(await gate.acquire({ sessionId: 's4', commandClass: 'test' }), { status: 'aborted' });
});

test('createVerificationWiring serializes concurrent checkNow runs through heavyCommandGate', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-heavy-gate-'));
  const overlapMarker = path.join(tempRoot, 'active.txt');
  const scriptPath = path.join(tempRoot, 'check.mjs');
  fs.writeFileSync(
    scriptPath,
    `import fs from 'node:fs';
const marker = ${JSON.stringify(overlapMarker)};
if (fs.existsSync(marker)) { console.error('OVERLAP'); process.exit(2); }
fs.writeFileSync(marker, String(process.pid));
await new Promise((r) => setTimeout(r, 80));
fs.unlinkSync(marker);
console.log('OK');
`,
  );

  const gate = createHeavyCommandGate({ maxSlots: 1 });
  const wiring = createVerificationWiring({
    getVerificationConfig: () => ({
      repos: {
        [tempRoot]: {
          checks: [{ id: 'serial-check', command: `node ${scriptPath}` }],
          timeoutSeconds: 10,
          gate: { enabled: false },
        },
      },
    }),
    isSessionSandboxOn: () => false,
    broadcastControl: () => {},
    heavyCommandGate: gate,
    testConcurrency: 2,
    logger: { warn: () => {} },
  });

  const makeSession = (id: string) => Object.assign(new EventEmitter(), {
    id,
    path: tempRoot,
    ephemeral: false,
    agentDoneLines: [],
    hasOwnWorktree: true,
    worktreeDir: tempRoot,
    worktreeLifecycle: {
      computeGateTree: async () => ({ sig: `sig-${id}`, dirty: false, headSha: null }),
      snapshot: () => ({ baseSha: null, effectiveBase: null }),
      setMergeGate: () => {},
    },
  });

  wiring.attachSession(makeSession('session-a'));
  wiring.attachSession(makeSession('session-b'));

  const [runA, runB] = await Promise.all([wiring.checkNow('session-a', 5_000), wiring.checkNow('session-b', 5_000)]);
  assert.equal(runA.ok, true);
  assert.equal(runB.ok, true);
  if (runA.ok && runA.run) {
    assert.equal(runA.run.status, 'passed');
    assert.match(runA.run.checks[0]?.outputTail ?? '', /OK/);
  }
  if (runB.ok && runB.run) {
    assert.equal(runB.run.status, 'passed');
    assert.match(runB.run.checks[0]?.outputTail ?? '', /OK/);
  }

  wiring.stop();
  gate.stop();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('lightweight agent done-line checks do not block on heavyCommandGate while a heavy slot is held, whereas heavy agent done-line checks still wait', async (context) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-light-done-'));
  context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempRoot, 'marker.txt'), 'ready\n');

  const gate = createHeavyCommandGate({ maxSlots: 1, defaultLeaseTtlMs: Number.POSITIVE_INFINITY });
  const held = await gate.acquire({ sessionId: 'other-npm-test', toolUseId: 'bash-1', commandClass: 'test' });
  assert.equal(held.status, 'granted');

  const wiring = createVerificationWiring({
    getVerificationConfig: () => ({}),
    isSessionSandboxOn: () => false,
    broadcastControl: () => {},
    heavyCommandGate: gate,
    logger: { warn: () => {} },
  });
  context.after(() => {
    wiring.stop();
    gate.stop();
  });

  const makeSession = (id: string, agentDoneLines: { text: string; command: string }[]) => Object.assign(new EventEmitter(), {
    id,
    path: tempRoot,
    ephemeral: false,
    agentDoneLines,
    hasOwnWorktree: true,
    worktreeDir: tempRoot,
    worktreeLifecycle: {
      computeGateTree: async () => ({ sig: `sig-${id}`, dirty: false, headSha: null }),
      snapshot: () => ({ baseSha: null, effectiveBase: null }),
      setMergeGate: () => {},
    },
  });

  wiring.attachSession(makeSession('light-session', [
    { text: 'marker exists', command: 'test -f marker.txt' },
    { text: 'marker matches', command: 'grep -q ready marker.txt' },
  ]));
  const lightOutcome = await wiring.checkNow('light-session', 1_500);
  assert.equal(lightOutcome.ok, true);
  assert.ok(lightOutcome.ok && lightOutcome.run !== null, 'lightweight done-line checks finish without waiting for heavyCommandGate');
  assert.deepEqual(lightOutcome.run.checks.map((check) => check.status), ['pass', 'pass']);

  wiring.attachSession(makeSession('heavy-session', [
    { text: 'node test', command: 'node --test --version' },
  ]));
  const blockedOutcome = await wiring.checkNow('heavy-session', 150);
  assert.equal(blockedOutcome.ok, true);
  assert.equal(blockedOutcome.ok ? blockedOutcome.run : 'unexpected', null, 'heavy agent done-line check still queues while heavyCommandGate is held');

  gate.release(held.lease.id);
  const unblockedOutcome = await wiring.checkNow('heavy-session', 5_000);
  assert.equal(unblockedOutcome.ok, true);
  assert.ok(unblockedOutcome.ok && unblockedOutcome.run !== null, 'heavy agent done-line check finishes once heavyCommandGate is released');
});
