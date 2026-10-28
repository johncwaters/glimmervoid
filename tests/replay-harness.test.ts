import { createNotifyGate, explainNotification } from '../session/core/notify-gate.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseRecording, replayDetection, summarize } from '../detection/replay.ts';
import claudeCode from '../session/adapters/claude-code.ts';
import kimi from '../session/adapters/kimi.ts';
import { setCustomAgents } from '../session/adapters/index.ts';
import { CustomAgentDeclaration } from '../shared/contracts/index.ts';
import { parseExitPlanModeHookPayload } from '../shared/contracts/plan-review.ts';
import { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';

const FIX = path.join(import.meta.dirname, 'fixtures');
const FAST = { stabilizationMs: 40, conflictWindowMs: 20, dedupWindowMs: 10 };

function load(file: string) {
  return parseRecording(fs.readFileSync(path.join(FIX, file), 'utf8'));
}

test('v2 fixture (complete via Stop): emits working + ready, never awaiting-input', async () => {
  const { version, records } = load('v2-complete-stop.jsonl');
  assert.equal(version, 2);
  const { signals } = await replayDetection(records, FAST);
  const c = summarize(signals);
  assert.ok(c.working >= 1, 'expected working');
  assert.ok(c.ready >= 1, 'expected ready');
  assert.equal(c['awaiting-input'] || 0, 0, 'no false WAITING');
});

test('v2 fixture (running monitor on Stop): the recorded Stop reaches COMPLETE', async (t) => {
  const { version, records } = load('v2-background-monitor-stop.jsonl');
  assert.equal(version, 2);
  const { signals } = await replayDetection(records, FAST);
  assert.ok(signals.some((signal) => signal.signal === 'ready' && signal.source === 'hook'));

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = new Session({ id: 'fixture-monitor', name: 'monitor', path: process.cwd(), statusConflictMs: 20, statusDedupMs: 10 });
  session.state = STATES.RUNNING;
  const stop = records.find((record) => record.type === 'hook' && record.event === 'Stop');
  assert.ok(stop);
  session.ingestHookSignal({ signal: 'ready', source: 'hook', ts: Date.now(), payload: stop.payload });
  t.mock.timers.tick(40);
  assert.equal(session.state, STATES.COMPLETE);
  assert.equal(session.toSnapshot().awaitingBackgroundTasks, false);
  session.destroy();
});

test('v2 fixture (SessionStart clear): the command-relayed reset signal reaches replay', async () => {
  const { records } = load('v2-sessionstart-clear.jsonl');
  const { signals } = await replayDetection(records, FAST);
  assert.deepEqual(signals.map((signal) => signal.signal), ['session-start']);
  const sessionStart = records.find((record) => record.type === 'hook');
  assert.equal(sessionStart?.payload?.source, 'clear');
});

test('v2 fixture (waiting via permission Notification): emits working + awaiting-input, never ready', async () => {
  const { records } = load('v2-waiting-permission.jsonl');
  const { signals } = await replayDetection(records, FAST);
  const c = summarize(signals);
  assert.ok(c.working >= 1, 'expected working');
  assert.ok(c['awaiting-input'] >= 1, 'expected awaiting-input');
  assert.equal(c.ready || 0, 0, 'no false COMPLETE');
});

test('v2 fixture (ExitPlanMode request): awaiting-input reaches the card as a plan prompt', async () => {
  const { records } = load('v2-waiting-plan.jsonl');
  const { signals } = await replayDetection(records, FAST);
  const counts = summarize(signals);
  assert.ok(counts.working >= 1, 'expected working');
  assert.ok(counts['awaiting-input'] >= 1, 'the plan request must reach the card');
  assert.equal(counts.ready || 0, 0, 'a plan request is never a completion');

  const request = records.find((record) => record.type === 'hook');
  assert.equal(claudeCode.hooks.mapSignal(String(request?.event), request?.payload), 'awaiting-input');
  assert.equal(claudeCode.hooks.mapPromptKind(String(request?.event), request?.payload), 'plan');
  assert.ok(parseExitPlanModeHookPayload(request?.payload), 'the recorded payload survives the fail-closed parse');
});

test('v2 fixture (AskUserQuestion answered while the title sits idle): the PostToolUse hook ends WAITING', (t) => {
  const { records } = load('v2-question-answered.jsonl');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = new Session({ id: 'fixture-question', name: 'question', path: process.cwd(), statusConflictMs: 20, statusDedupMs: 10 });
  t.after(() => session.destroy());
  session.state = STATES.RUNNING;
  const transitions: string[] = [];
  session.on('state-change', ({ to }: { to: string }) => transitions.push(to));
  let previousTimestamp = 0;
  for (const record of records) {
    const timestamp = record.ts ?? previousTimestamp;
    t.mock.timers.tick(timestamp - previousTimestamp);
    previousTimestamp = timestamp;
    if (record.type === 'data' && record.data) session._titleSource.feed(record.data);
    if (record.type !== 'hook' || !record.event) continue;
    const signal = claudeCode.hooks.mapSignal(record.event, record.payload);
    if (!signal) continue;
    const promptKind = signal === 'awaiting-input' ? claudeCode.hooks.mapPromptKind(record.event, record.payload) : null;
    const promptToolName = promptKind ? claudeCode.hooks.mapPromptToolName?.(record.event, record.payload) ?? null : null;
    session.ingestHookSignal({ signal, source: 'hook', event: record.event, payload: record.payload, ts: Date.now(), ...(promptKind ? { promptKind } : {}), ...(promptToolName ? { promptToolName } : {}) });
  }
  t.mock.timers.tick(2000);
  assert.deepEqual(transitions, [STATES.WAITING, STATES.RUNNING]);
  assert.equal(session.state, STATES.RUNNING);
});

test('v2 fixture (conflict Stop+permission): awaiting-input dominates, no ready', async () => {
  const { records } = load('v2-conflict-stop-then-notify.jsonl');
  const { signals } = await replayDetection(records, FAST);
  const c = summarize(signals);
  assert.ok(c['awaiting-input'] >= 1, 'expected awaiting-input');
  assert.equal(c.ready || 0, 0, 'ready must be suppressed by conflict rule');
});

test('codex fixture (approval turn): the recorded sequence replays through the codex adapter', async () => {
  const { version, agent, records } = load('v2-codex-approval-turn.jsonl');
  assert.equal(version, 2);
  assert.equal(agent, 'codex');

  const { signals } = await replayDetection(records, { ...FAST, agent, titleContext: { cwdBasename: 'project' } });
  const order = signals.map((s) => s.signal);
  assert.ok(order.includes('resume'), 'UserPromptSubmit opens the work cycle');
  const awaitingAt = order.indexOf('awaiting-input');
  const readyAt = order.lastIndexOf('ready');
  assert.ok(awaitingAt >= 0, 'the approval must reach the card');
  assert.ok(readyAt > awaitingAt, 'the turn completes only AFTER the approval, never before');
  assert.equal(signals[awaitingAt].source, 'hook', 'PermissionRequest wins the race against the title');
});

test('the same codex recording read with the Claude title glyphs loses the title tier, which is why replay is adapter-aware', async () => {
  const { records } = load('v2-codex-approval-turn.jsonl');

  const titlesOnly = records.filter((r) => r.type === 'data');
  const titleContext = { cwdBasename: 'project' };
  const asCodex = await replayDetection(titlesOnly, { ...FAST, agent: 'codex', titleContext });
  const asClaude = await replayDetection(titlesOnly, { ...FAST, agent: 'claude-code', titleContext });
  const kinds = (r: Awaited<ReturnType<typeof replayDetection>>) => new Set(r.signals.map((s) => s.signal));

  assert.deepEqual([...kinds(asCodex)].sort(), ['awaiting-input', 'ready', 'working']);
  assert.deepEqual([...kinds(asClaude)], ['working']);
});

test('grok fixture replays the live approval race from title WAITING to hook COMPLETE', async () => {
  const { version, agent, records } = load('v2-grok-approval-turn.jsonl');
  assert.equal(version, 2);
  assert.equal(agent, 'grok');
  const { signals } = await replayDetection(records, { ...FAST, agent });
  const order = signals.map((signal) => signal.signal);
  assert.ok(order.includes('resume'), 'UserPromptSubmit opens the work cycle');
  const awaitingAt = order.indexOf('awaiting-input');
  const readyAt = order.lastIndexOf('ready');
  assert.ok(awaitingAt >= 0, 'the approval reaches the card');
  assert.ok(readyAt > awaitingAt, 'Stop(end_turn) completes after approval');
  assert.equal(signals[awaitingAt].source, 'title');
  const authoritativeAwaiting = signals.find((signal, index) =>
    index > awaitingAt && signal.signal === 'awaiting-input' && signal.source === 'hook');
  assert.ok(authoritativeAwaiting, 'the hook supersedes the duplicate title signal');
  assert.equal(authoritativeAwaiting.confidence, 'high');
  assert.equal(signals[readyAt].source, 'hook');
});

test('a config-declared custom agent replays title-only: working, then ready, never awaiting-input', async () => {
  const { version, agent, records } = load('v2-custom-title-only.jsonl');
  assert.equal(version, 2);
  assert.equal(agent, 'opencode');
  setCustomAgents([CustomAgentDeclaration.parse({ id: 'opencode', label: 'OpenCode', command: 'opencode' })]);
  try {
    const { signals } = await replayDetection(records, { ...FAST, agent, titleContext: { cwdBasename: 'project' } });
    const counts = summarize(signals);
    assert.ok(counts.working >= 1, 'the spinner titles reach the card');
    assert.ok(counts.ready >= 1, 'the settled cwd-basename title completes the turn');
    assert.equal(counts['awaiting-input'] || 0, 0, 'a title-only adapter never claims awaiting-input');

    const order = signals.map((signal) => signal.signal);
    assert.ok(order.indexOf('ready') > order.indexOf('working'), 'the boot title never fires ready before the first spinner');
    assert.equal(signals.every((signal) => signal.source === 'title'), true, 'a hookless adapter has only the title tier');
  } finally {
    setCustomAgents([]);
  }
});

test('real v1 recordings replay cleanly and never emit awaiting-input (title honest contract)', async () => {
  const v1files = fs.readdirSync(FIX).filter((f) => f.startsWith('v1-') && f.endsWith('.jsonl'));
  assert.ok(v1files.length >= 1, 'expected at least one v1 fixture');
  for (const f of v1files) {
    const { version, records } = load(f);
    assert.equal(version, 1, `${f} should be v1`);
    const { signals } = await replayDetection(records, FAST);
    const c = summarize(signals);
    assert.equal(c['awaiting-input'] || 0, 0, `${f}: title source must never emit awaiting-input`);
  }
});

for (const [fixture, expectedState, expectedNotifications] of [
  ['v2-idle-compaction.jsonl', STATES.COMPLETE, ['complete']],
  ['v2-mid-turn-compaction.jsonl', STATES.RUNNING, []],
] as const) {
  test(`${fixture} replays through the Session without an extra completion cycle`, async (t) => {
    const { records } = load(fixture);
    const { signals } = await replayDetection(records, FAST);
    assert.ok(signals.some((signal) => signal.signal === 'compaction-start'));
    assert.ok(signals.some((signal) => signal.signal === 'compaction-end'));
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const session = new Session({ id: fixture, name: fixture, path: process.cwd(), statusConflictMs: 20, statusDedupMs: 10 });
    t.after(() => session.destroy());
    session.state = STATES.IDLE;
    const gate = createNotifyGate();
    const notifications: string[] = [];
    const transitions: string[] = [];
    let postTurnChecks = 0;
    let isCompacting = false;
    session.on('prompt-kind-change', (detail: { isCompacting: boolean }) => { isCompacting = detail.isCompacting; });
    session.on('user-prompt', () => gate.reset());
    session.on('post-turn-check', () => postTurnChecks++);
    session.on('state-change', ({ to, event, detail }) => {
      transitions.push(to);
      const category = explainNotification(to, gate, event, { signal: detail?.signal, hookSeen: session.hookSeen }).category;
      if (category) notifications.push(category);
    });
    let previousTimestamp = 0;
    for (const record of records) {
      const timestamp = record.ts ?? previousTimestamp;
      t.mock.timers.tick(timestamp - previousTimestamp);
      previousTimestamp = timestamp;
      if (record.type === 'data' && record.data) session._titleSource.feed(record.data);
      if (record.type !== 'hook' || !record.event) continue;
      const signal = claudeCode.hooks.mapSignal(record.event, record.payload);
      if (!signal) continue;
      session.ingestHookSignal({ signal, source: 'hook', event: record.event, payload: record.payload, ts: Date.now() });
      if (record.event === 'PreCompact') assert.equal(isCompacting, true);
      if (record.event === 'PostCompact' || record.payload?.source === 'compact') assert.equal(isCompacting, false);
    }
    t.mock.timers.tick(2000);
    assert.equal(session.state, expectedState);
    assert.deepEqual(notifications, expectedNotifications);
    assert.equal(postTurnChecks, expectedNotifications.length);
    if (expectedState === STATES.COMPLETE) assert.deepEqual(transitions, [STATES.RUNNING, STATES.COMPLETE, STATES.RUNNING, STATES.COMPLETE]);
  });
}

for (const fixture of ['v2-kimi-approval-turn.jsonl', 'v2-kimi-ask-question.jsonl']) {
  test(`kimi fixture ${fixture}: the prompt reaches the card as awaiting-input before the Stop completes the turn`, async () => {
    const { version, agent, records } = load(fixture);
    assert.equal(version, 2);
    assert.equal(agent, 'kimi');
    const { signals } = await replayDetection(records, { ...FAST, agent });
    const order = signals.map((signal) => signal.signal);
    const awaitingAt = order.indexOf('awaiting-input');
    assert.ok(awaitingAt >= 0, 'the prompt reaches the card');
    assert.ok(order.lastIndexOf('ready') > awaitingAt, 'the Stop completes after the prompt is answered');
  });
}

test('kimi subagent fixture: the subagent Stop inside the open Agent call is dropped and only the main Stop completes the card', (t) => {
  const { agent, records } = load('v2-kimi-subagent.jsonl');
  assert.equal(agent, 'kimi');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = new Session({ id: 'fixture-kimi-subagent', name: 'kimi', path: process.cwd(), agent: 'kimi', statusConflictMs: 20, statusDedupMs: 10 });
  t.after(() => session.destroy());
  session.state = STATES.IDLE;
  const hookStops = records.filter((record) => record.type === 'hook' && record.event === 'stop');
  assert.equal(hookStops.length, 2, 'the recording holds the subagent Stop and the main Stop');
  const completedAfterStop: number[] = [];
  let stopsSeen = 0;
  session.on('state-change', ({ to }) => { if (to === STATES.COMPLETE) completedAfterStop.push(stopsSeen); });
  for (const record of records) {
    if (record.type !== 'hook' || !record.event) continue;
    const payload = kimi.mapHookPayload(record.event, record.payload ?? {});
    const signal = kimi.hooks.mapSignal(record.event, payload);
    if (record.event === 'stop') stopsSeen++;
    if (!signal) continue;
    session.ingestHookSignal({ signal, source: 'hook', event: record.event, payload, ts: Date.now() });
    t.mock.timers.tick(15000);
  }
  assert.deepEqual(completedAfterStop, [2]);
});

for (const endingEvent of ['Interrupt', 'StopFailure']) {
  test(`kimi ${endingEvent} under an open Agent call still completes the card`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const session = new Session({ id: `kimi-${endingEvent}`, name: 'kimi', path: process.cwd(), agent: 'kimi', statusConflictMs: 20, statusDedupMs: 10 });
    t.after(() => session.destroy());
    session.state = STATES.IDLE;
    const agentCall = { tool_name: 'Agent', tool_call_id: 'tool_1' };
    for (const [event, payload] of [['UserPromptSubmit', {}], ['PreToolUse', agentCall], [endingEvent, {}], ['PostToolUse', agentCall]] as const) {
      const mappedPayload = kimi.mapHookPayload(event, { ...payload });
      const signal = kimi.hooks.mapSignal(event, mappedPayload);
      if (signal) session.ingestHookSignal({ signal, source: 'hook', event, payload: mappedPayload, ts: Date.now() });
      t.mock.timers.tick(15000);
    }
    assert.equal(session.state, STATES.COMPLETE);
  });
}
