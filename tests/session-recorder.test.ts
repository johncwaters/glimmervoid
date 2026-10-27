import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRecorder, createRecorder } from '../session/session-recorder.ts';
import { Session } from '../session/sessions.ts';
import { replayDetection } from '../detection/replay.ts';
import { parseRecording } from '../detection/replay.ts';
import { projectHookPayload } from '../session/core/hook-payload-projection.ts';
import { STATES } from '../shared/states.ts';
function makeBaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-recorder-'));
}

function readLines(filepath: string): Record<string, unknown>[] {
  const raw = fs.readFileSync(filepath, 'utf8');
  return raw.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function findRecordingFile(baseDir: string, name: string) {
  const entries = fs.readdirSync(baseDir).filter((f) => f.startsWith(`${name}-`) && f.endsWith('.jsonl'));
  assert.equal(entries.length, 1, 'exactly one recording file expected');
  return path.join(baseDir, entries[0]);
}

function closeAndFlush(recorder: SessionRecorder) {
  const stream = recorder._stream;
  if (!stream) {
    recorder.close();
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    stream.once('finish', () => resolve());
    recorder.close();
  });
}

test('round-trips header, data, hook, state, input, resize, footer in write order', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'roundtrip-session', baseDir, recordData: true });
    recorder.open();

    recorder.writeHeader({ cols: 100, rows: 30, foo: 'bar' });
    recorder.writeData('hello world');
    recorder.writeHook('Stop', { reason: 'turn-end' });
    recorder.writeState('RUNNING', 'COMPLETE', 'task_complete', { via: 'hook' });
    recorder.writeDecision({ ts: 1234, kind: 'gate', decision: 'release', active: 0, quietMs: 10500 });
    recorder.writeInput('ls -la\n');
    recorder.writeResize(120, 40);
    recorder.writeFooter('exit', 0);
    await closeAndFlush(recorder);

    const filepath = findRecordingFile(baseDir, 'roundtrip-session');
    const records = readLines(filepath);

    assert.equal(records.length, 8);
    assert.deepEqual(
      records.map((r) => r.type),
      ['header', 'data', 'hook', 'state', 'decision', 'input', 'resize', 'footer'],
    );

    const [header, data, hook, state, decision, input, resize, footer] = records;

    assert.equal(header.version, 2);
    assert.equal(header.session, 'roundtrip-session');
    assert.equal(header.cols, 100);
    assert.equal(header.rows, 30);
    assert.deepEqual(header.config, { cols: 100, rows: 30, foo: 'bar' });
    assert.equal(typeof header.startedAt, 'number');

    assert.equal(data.data, 'hello world');
    assert.equal(data.len, 'hello world'.length);
    assert.equal(typeof data.ts, 'number');

    assert.equal(hook.event, 'Stop');
    assert.deepEqual(hook.payload, { reason: 'turn-end' });

    assert.equal(state.from, 'RUNNING');
    assert.equal(state.to, 'COMPLETE');
    assert.equal(state.event, 'task_complete');
    assert.deepEqual(state.detail, { via: 'hook' });

    assert.equal(decision.kind, 'gate');
    assert.equal(decision.decision, 'release');
    assert.equal(decision.quietMs, 10500);
    assert.equal(decision.ts, 1234, 'the entry keeps the timestamp the decision was made at');

    assert.equal(input.data, 'ls -la\n');

    assert.equal(resize.cols, 120);
    assert.equal(resize.rows, 40);

    assert.equal(footer.reason, 'exit');
    assert.equal(footer.exitCode, 0);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('signals mode records hooks and state transitions but no PTY bytes, input or resizes', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'signals-only', baseDir });
    recorder.open();
    recorder.writeHeader({ cols: 80, rows: 24 });
    recorder.writeData('lots and lots of raw pty bytes');
    recorder.writeInput('secret typing');
    recorder.writeResize(120, 40);
    recorder.writeHook('Stop', { session_id: 'abc', background_tasks: [{ id: 't1', type: 'teammate', status: 'running' }] });
    recorder.writeDecision({ ts: 7, kind: 'signal', signal: 'ready', source: 'hook', active: 1, action: 'gate-held' });
    recorder.writeState('RUNNING', 'COMPLETE', 'task_complete', { source: 'hook', signal: 'ready', deferred: true });
    recorder.writeFooter('pty_exit', 0);
    await closeAndFlush(recorder);

    const records = readLines(findRecordingFile(baseDir, 'signals-only'));
    assert.deepEqual(records.map((r) => r.type), ['header', 'hook', 'decision', 'state', 'footer']);
    assert.equal(records[0].records, 'signals', 'the header declares the verbosity level');
    assert.deepEqual(
      (records[1].payload as Record<string, unknown>).background_tasks,
      [{ id: 't1', type: 'teammate', status: 'running' }],
      'background task state needed for the completion gate remains recorded',
    );
    assert.equal(records[2].action, 'gate-held', 'decisions ride the default signals mode');
    assert.equal((records[3].detail as Record<string, unknown>).deferred, true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('a projected recording replays with the same state transitions as its full payload recording', async () => {
  const baseDir = makeBaseDir();
  try {
    const fullPayload = {
      notification_type: 'permission_prompt',
      tool_name: 'Read',
      background_tasks: [{ id: 'task-1', type: 'teammate', status: 'running', detail: 'unread' }],
      last_assistant_message: 'unused response',
      unused: 'unused field',
    };
    const fullRecording = [
      JSON.stringify({ type: 'header', version: 2, agent: 'claude-code' }),
      JSON.stringify({ type: 'hook', ts: 1, event: 'Notification', payload: fullPayload }),
    ].join('\n');
    const expected = await replayDetection(parseRecording(fullRecording).records, {
      stabilizationMs: 1,
      conflictWindowMs: 1,
      dedupWindowMs: 1,
    });
    const recorder = new SessionRecorder({ name: 'projected-replay', baseDir });
    recorder.open();
    recorder.writeHeader({ agent: 'claude-code' });
    recorder.writeHook('Notification', fullPayload);
    await closeAndFlush(recorder);

    const projectedRecording = parseRecording(fs.readFileSync(findRecordingFile(baseDir, 'projected-replay'), 'utf8'));
    const actual = await replayDetection(projectedRecording.records, {
      stabilizationMs: 1,
      conflictWindowMs: 1,
      dedupWindowMs: 1,
      agent: projectedRecording.agent,
    });
    assert.deepEqual(actual.signals.map((signal) => signal.signal), expected.signals.map((signal) => signal.signal));
    assert.deepEqual(projectHookPayload(fullPayload), projectedRecording.records[0]?.payload);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('createRecorder honors a config-provided baseDir', async () => {
  const baseDir = makeBaseDir();
  try {
    const recorder = createRecorder('configured-dir', { baseDir }, true);
    assert.ok(recorder, 'a configured recorder is created');
    recorder.writeHeader({});
    await closeAndFlush(recorder);
    assert.equal(fs.readdirSync(baseDir).filter((f) => f.endsWith('.jsonl')).length, 1);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('a live session records its hook payloads and transitions in signals mode', async (t) => {
  const baseDir = makeBaseDir();

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const recorder = new SessionRecorder({ name: 'live-session', baseDir });
    const s = new Session({ id: 'rec-id', name: 'live-session', path: process.cwd(), statusConflictMs: 5 });
    s.setRecorder(recorder);
    s.state = STATES.RUNNING;
    s.ingestHookSignal({
      signal: 'ready',
      source: 'hook',
      ts: Date.now(),
      event: 'Stop',
      payload: { session_id: 'abcd1234-0000-0000-0000-abcdabcdabcd', background_tasks: [] },
    });
    t.mock.timers.tick(20);
    assert.equal(s.state, STATES.COMPLETE);
    t.mock.timers.reset();
    await closeAndFlush(recorder);
    s.destroy();

    const records = readLines(findRecordingFile(baseDir, 'live-session'));
    const hook = records.find((r) => r.type === 'hook');
    assert.equal(hook?.event, 'Stop');
    assert.equal((hook?.payload as Record<string, unknown> | undefined)?.session_id, 'abcd1234-0000-0000-0000-abcdabcdabcd');
    const state = records.find((r) => r.type === 'state');
    assert.equal(state?.to, STATES.COMPLETE, 'the transition the hook caused is recorded alongside it');
    assert.equal((state?.detail as Record<string, unknown> | undefined)?.signal, 'ready');
    const decision = records.find((r) => r.type === 'decision');
    assert.equal(decision?.kind, 'signal');
    assert.equal(decision?.action, 'transition', 'the decision behind the transition is recorded too');
    assert.equal(decision.active, 0, 'with the evidence it was made on: no background work declared');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

function whenStreamFinished(recorder: SessionRecorder): Promise<void> {
  const stream = recorder._stream;
  if (!stream) return Promise.resolve();
  return new Promise<void>((resolve) => {
    stream.once('finish', () => resolve());
  });
}

test('a session respawned after its process exits records into a fresh file and releases the first', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T10:00:00.000Z') });
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'respawned-session', baseDir });
    const s = new Session({ id: 'respawn-id', name: 'respawned-session', path: process.cwd() });
    s.setRecorder(recorder);
    s.state = STATES.RUNNING;
    recorder.writeHeader({ agent: 'claude' });
    const firstRunPath = recorder._filepath as string;
    const firstRunFinished = whenStreamFinished(recorder);
    await s._handlePtyExit(0, 9);
    await firstRunFinished;
    assert.equal(recorder._stream, null, 'the exit finishes the first run stream');

    t.mock.timers.setTime(Date.parse('2026-10-08T10:05:00.000Z'));
    recorder.writeHeader({ agent: 'claude' });
    recorder.writeHook('PermissionRequest', { session_id: 'after-respawn' });
    const secondRunPath = recorder._filepath as string;
    await closeAndFlush(recorder);
    s.destroy();

    assert.notEqual(secondRunPath, firstRunPath);
    const firstRunRecords = readLines(firstRunPath);
    assert.equal(firstRunRecords.at(-1)?.type, 'footer', 'the first run file ends with the exit footer');
    assert.equal(firstRunRecords.at(-1)?.reason, 'pty_exit');
    const secondRunRecords = readLines(secondRunPath);
    assert.equal(secondRunRecords[0]?.type, 'header', 'the respawn opens its own file with a header');
    const hook = secondRunRecords.find((r) => r.type === 'hook');
    assert.equal((hook?.payload as Record<string, unknown> | undefined)?.session_id, 'after-respawn');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('a run started while the previous exit is still settling its worktree records only into its own file', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T10:00:00.000Z') });
  const baseDir = makeBaseDir();
  try {
    const recorder = new SessionRecorder({ name: 'settling-session', baseDir });
    const s = new Session({ id: 'settling-id', name: 'settling-session', path: process.cwd() });
    s.setRecorder(recorder);
    s.state = STATES.RUNNING;
    let finishWorktreeSettle = () => {};
    s._settleWorktreeOnExit = () => new Promise<void>((resolve) => { finishWorktreeSettle = resolve; });
    recorder.writeHeader({ agent: 'claude', run: 'first' });
    const firstRunPath = recorder._filepath as string;
    const firstRunFinished = whenStreamFinished(recorder);
    const exitHandled = s._handlePtyExit(0, 9);

    t.mock.timers.setTime(Date.parse('2026-10-08T10:05:00.000Z'));
    recorder.writeHeader({ agent: 'claude', run: 'second' });
    recorder.writeHook('PermissionRequest', { session_id: 'second-run' });
    const secondRunPath = recorder._filepath as string;
    finishWorktreeSettle();
    await exitHandled;
    await firstRunFinished;
    recorder.writeHook('Stop', { session_id: 'second-run' });
    await closeAndFlush(recorder);
    s.destroy();

    assert.notEqual(secondRunPath, firstRunPath);
    const firstRunRecords = readLines(firstRunPath);
    assert.equal(firstRunRecords.at(-1)?.type, 'footer', 'the first run file ends with its exit footer');
    assert.equal(firstRunRecords.some((r) => r.type === 'hook'), false, 'no second-run record lands in the first file');
    const secondRunRecords = readLines(secondRunPath);
    assert.equal(secondRunRecords[0]?.type, 'header');
    assert.equal(secondRunRecords.filter((r) => r.type === 'hook').length, 2, 'every second-run hook stays in its own file');
    assert.equal(secondRunRecords.some((r) => r.type === 'footer' && r.reason === 'pty_exit'), false, 'the stale exit writes no footer into the second file');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('a finished recording file is no longer held open, so the byte budget can evict it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T10:00:00.000Z') });
  const baseDir = makeBaseDir();
  const recorder = new SessionRecorder({ name: 'finished', baseDir, retainDays: 0, retainFiles: 0, retainBytes: 50 });
  try {
    recorder.writeHeader({ padding: 'a'.repeat(200) });
    await recorder.retentionDone;
    const finishedPath = recorder._filepath as string;
    const finishedStream = whenStreamFinished(recorder);
    recorder.finishRecordingFile();
    await finishedStream;
    fs.utimesSync(finishedPath, new Date('2026-01-01'), new Date('2026-01-01'));

    t.mock.timers.setTime(Date.parse('2026-10-08T10:05:00.000Z'));
    recorder.writeHeader({});
    await recorder.retentionDone;
    await whenStreamOpen(recorder);

    assert.equal(fs.existsSync(finishedPath), false, 'the finished over-budget file is evicted');
    assert.equal(fs.existsSync(recorder._filepath as string), true, 'the fresh file survives');
  } finally {
    await closeAndFlush(recorder);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('records written after a finished run are dropped until the next run header opens a fresh file', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T10:00:00.000Z') });
  const baseDir = makeBaseDir();
  const recorder = new SessionRecorder({ name: 'exited', baseDir, retainDays: 0, retainFiles: 0, retainBytes: 0 });
  try {
    recorder.writeHeader({ agent: 'claude' });
    const finishedPath = recorder._filepath as string;
    const finishedStream = whenStreamFinished(recorder);
    recorder.finishRecordingFile();
    await finishedStream;

    t.mock.timers.setTime(Date.parse('2026-10-08T10:05:00.000Z'));
    recorder.writeDecision({ ts: Date.now(), kind: 'phone-escalation' });
    recorder.writeState(STATES.DONE, STATES.FAILED, 'late', null);
    assert.equal(recorder._stream, null, 'a late decision or state opens no stream');
    assert.deepEqual(fs.readdirSync(baseDir), [path.basename(finishedPath)], 'a late decision or state creates no file');

    recorder.writeHeader({ agent: 'claude' });
    recorder.writeDecision({ ts: Date.now(), kind: 'after-respawn' });
    const freshPath = recorder._filepath as string;
    await closeAndFlush(recorder);

    assert.notEqual(freshPath, finishedPath);
    const freshRecords = readLines(freshPath);
    assert.equal(freshRecords[0]?.type, 'header', 'the next run file starts with its header');
    assert.deepEqual(freshRecords.filter((r) => r.type === 'decision').map((r) => r.kind), ['after-respawn']);
    assert.equal(readLines(finishedPath).some((r) => r.type === 'decision' || r.type === 'state'), false);
  } finally {
    await closeAndFlush(recorder);
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

function whenStreamOpen(recorder: SessionRecorder): Promise<void> {
  const stream = recorder._stream;
  if (!stream || !stream.pending) return Promise.resolve();
  return new Promise<void>((resolve) => {
    stream.once('open', () => resolve());
  });
}
