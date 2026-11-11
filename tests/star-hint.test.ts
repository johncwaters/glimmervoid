import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStarHintWiring } from '../server/star-hint-wiring.ts';
import { STAR_HINT_PROMPT_THRESHOLD } from '../shared/contracts/star-hint.ts';

interface HookedSession extends EventEmitter {
  readonly id: string;
  readonly ephemeral: boolean;
  submitPrompt: (prompt: string) => void;
}

function hookedSession(id: string, { ephemeral = false }: { ephemeral?: boolean } = {}): HookedSession {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    id,
    ephemeral,
    submitPrompt: (prompt: string) => { emitter.emit('hook-event', { event: 'userpromptsubmit', payload: { prompt } }); },
  });
}

function startStarHint(statePath: string, dashboards = { count: 1 }) {
  const starHintBroadcasts: { type: 'star-hint' }[] = [];
  const starHint = createStarHintWiring({
    statePath, log: { warn: () => {} }, controlClientCount: () => dashboards.count,
    broadcast: (message) => { starHintBroadcasts.push(message); },
  });
  test.after(() => starHint.stop());
  return { starHint, starHintBroadcasts };
}

function pendingStarHintCount(starHint: ReturnType<typeof createStarHintWiring>): number {
  return starHint.pendingHintMessages().length;
}

function attachedSession(starHint: { attachSession: (session: HookedSession) => void }, id: string, options: { ephemeral?: boolean } = {}): HookedSession {
  const session = hookedSession(id, options);
  starHint.attachSession(session);
  return session;
}

function tempStatePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'star-hint-')), 'feature-hints.json');
}

test('the fifth operator prompt sends the star hint once ever, across restarts, and lane prompts never count', async () => {
  const statePath = tempStatePath();
  const firstRun = startStarHint(statePath);
  const operatorSession = attachedSession(firstRun.starHint, 'session-a');
  const laneSession = attachedSession(firstRun.starHint, 'lane', { ephemeral: true });

  for (const prompt of ['one', 'two', 'three', 'four']) operatorSession.submitPrompt(prompt);
  for (const prompt of ['lane one', 'lane two', 'lane three']) laneSession.submitPrompt(prompt);
  operatorSession.submitPrompt('   ');
  await firstRun.starHint.idle();
  assert.equal(firstRun.starHintBroadcasts.length, 0);

  operatorSession.submitPrompt('five');
  operatorSession.submitPrompt('six');
  await firstRun.starHint.idle();
  assert.equal(firstRun.starHintBroadcasts.length, 1);
  assert.equal(pendingStarHintCount(firstRun.starHint), 0);
  await firstRun.starHint.stop();

  const restarted = startStarHint(statePath);
  attachedSession(restarted.starHint, 'session-b').submitPrompt('seven');
  await restarted.starHint.idle();
  assert.equal(pendingStarHintCount(restarted.starHint), 0);
  assert.equal(restarted.starHintBroadcasts.length, 0);
});

test('a star hint raised with no dashboard connected waits for the next connect and is then sent once', async () => {
  const dashboards = { count: 0 };
  const { starHint, starHintBroadcasts } = startStarHint(tempStatePath(), dashboards);
  const session = attachedSession(starHint, 'session-a');

  for (let promptIndex = 0; promptIndex < STAR_HINT_PROMPT_THRESHOLD; promptIndex += 1) session.submitPrompt(`prompt ${promptIndex}`);
  await starHint.idle();
  assert.equal(starHintBroadcasts.length, 0);

  dashboards.count = 1;
  assert.equal(pendingStarHintCount(starHint), 1);
  assert.equal(pendingStarHintCount(starHint), 0);
});

test('a star hint left pending by an older build replays on one connect only, across restarts', async () => {
  const statePath = tempStatePath();
  const pendingStarState = { signalsByFeature: {}, settledByFeature: {}, lastShownAtByView: {}, pendingHint: null, starHintPromptCount: STAR_HINT_PROMPT_THRESHOLD, starHintOutcome: null };
  fs.writeFileSync(statePath, JSON.stringify(pendingStarState));
  const firstRun = startStarHint(statePath);
  await firstRun.starHint.idle();
  assert.equal(pendingStarHintCount(firstRun.starHint), 1);
  assert.equal(pendingStarHintCount(firstRun.starHint), 0);
  await firstRun.starHint.stop();

  const restarted = startStarHint(statePath);
  await restarted.starHint.idle();
  assert.equal(pendingStarHintCount(restarted.starHint), 0);
});
