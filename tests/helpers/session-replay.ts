import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { HookRouter } from '../../detection/hook-source.ts';
import { parseRecording } from '../../detection/replay.ts';
import { hookProfileOf, resolveAdapter } from '../../session/adapters/index.ts';
import { createNotifyGate, explainNotification } from '../../session/core/notify-gate.ts';
import { Session } from '../../session/sessions.ts';
import { STATES } from '../../shared/states.ts';

const FIXTURE_DIRECTORY = path.join(import.meta.dirname, '..', 'fixtures');
const REPLAY_TOKEN = 'replay-token';
const SETTLE_AFTER_LAST_RECORD_MS = 2000;

interface SessionReplayOutcome {
  agent: string | null;
  finalState: string;
  notifications: string[];
  transitions: string[];
  postTurnChecks: number;
  taskTitleResets: number;
  hookSignals: string[];
  compactingAfterEvent: { event: string; source: unknown; isCompacting: boolean }[];
}

interface SessionReplayOptions {
  minimumGapMs?: number;
}

function replayThroughSession(fixtureFile: string, t: TestContext, { minimumGapMs = 0 }: SessionReplayOptions = {}): SessionReplayOutcome {
  const { agent, records } = parseRecording(fs.readFileSync(path.join(FIXTURE_DIRECTORY, fixtureFile), 'utf8'));
  const adapter = resolveAdapter(agent);
  const hookProfile = adapter ? hookProfileOf(adapter) : null;
  if (!hookProfile) throw new Error(`${fixtureFile}: agent ${agent} declares no hooks to replay`);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const session = new Session({ id: fixtureFile, name: fixtureFile, path: process.cwd(), agent: agent ?? undefined, statusConflictMs: 20, statusDedupMs: 10 });
  t.after(() => session.destroy());
  session.state = STATES.IDLE;
  const router = new HookRouter();
  const hookSignals: string[] = [];
  router.register(session.id, {
    token: REPLAY_TOKEN,
    onSignal: (signal) => {
      if (signal.signal) hookSignals.push(signal.signal);
      session.ingestHookSignal(signal);
    },
    hooks: hookProfile,
  });
  const gate = createNotifyGate();
  const notifications: string[] = [];
  const transitions: string[] = [];
  const compactingAfterEvent: SessionReplayOutcome['compactingAfterEvent'] = [];
  let postTurnChecks = 0;
  let taskTitleResets = 0;
  session.on('task-title-reset', () => taskTitleResets++);
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
    t.mock.timers.tick(Math.max(timestamp - previousTimestamp, minimumGapMs));
    previousTimestamp = timestamp;
    if (record.type === 'data' && record.data) session._titleSource.feed(record.data);
    if (record.type !== 'hook' || !record.event) continue;
    router.handle({ glimmervoidId: session.id, event: record.event, token: REPLAY_TOKEN, payload: record.payload ?? {} });
    compactingAfterEvent.push({ event: record.event, source: record.payload?.source, isCompacting });
  }
  t.mock.timers.tick(SETTLE_AFTER_LAST_RECORD_MS);
  return { agent, finalState: session.state, notifications, transitions, postTurnChecks, taskTitleResets, hookSignals, compactingAfterEvent };
}

export { replayThroughSession };
export type { SessionReplayOutcome };
