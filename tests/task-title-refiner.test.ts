import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';
import { Session } from '../session/sessions.ts';
import { createTaskTitleRefiner } from '../server/task-title-refiner.ts';
import { createSessionEventWiring } from '../server/session-event-wiring.ts';
import { waitFor } from './helpers/wait-for.ts';
import type { LaneSpawn } from '../server/lane-spawn.ts';
import { STATES } from '../shared/states.ts';
import { BrowserConfig, Config, CONFIG_BLOCK_KEYS, ConfigUpdate } from '../shared/contracts/config.ts';
import { DEFAULT_CONFIG } from '../server/config-store.ts';

type LaneRequest = Parameters<LaneSpawn>[0];

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {};
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function submitPrompt(session: Session, prompt: string): void {
  session.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 1, payload: { prompt } });
}

function endTurn(session: Session, refiner: ReturnType<typeof createTaskTitleRefiner>): void {
  session.state = STATES.RUNNING;
  session.transition('task_complete');
  refiner.onTurnEnd(session);
}

function makeSession(id: string, options: { ephemeral?: boolean; customTitle?: string; agent?: string } = {}): Session {
  return new Session({ id, name: id, path: '/project', initialPrompt: 'Original task title', ...options });
}

async function writeTitle(request: LaneRequest, title: string | null): Promise<void> {
  await fs.writeFile(path.join(request.cwd, 'task-title-result.json'), JSON.stringify({ title }));
}

test('task title settings validate across all boundaries and default to enabled Haiku refinement', () => {
  assert.deepEqual(DEFAULT_CONFIG.taskTitle.refiner, { enabled: true, model: 'haiku', minIntervalSeconds: 60, timeoutSeconds: 60 });
  assert.equal(CONFIG_BLOCK_KEYS.includes('taskTitle'), true);
  const taskTitle = { refiner: { enabled: false, model: 'sonnet', minIntervalSeconds: 0, timeoutSeconds: 30 } };
  assert.equal(Config.safeParse({ projects: [], taskTitle }).success, true);
  assert.equal(BrowserConfig.safeParse({ taskTitle }).success, true);
  assert.equal(ConfigUpdate.safeParse({ taskTitle }).success, true);
  for (const refiner of [{ enabled: 'yes' }, { model: 1 }, { minIntervalSeconds: -1 }, { timeoutSeconds: 0 }, { timeoutSeconds: 2_147_484 }, { timeoutSeconds: Number.POSITIVE_INFINITY }]) {
    assert.equal(Config.safeParse({ projects: [], taskTitle: { refiner } }).success, false);
    assert.equal(ConfigUpdate.safeParse({ taskTitle: { refiner } }).success, false);
  }
});

test('the lane shows an instant title and refines with Claude, a constant bootstrap and cleaned prompt file', async () => {
  const session = makeSession('first', { agent: 'grok' });
  const launched = deferred<LaneRequest>();
  const release = deferred<void>();
  const refiner = createTaskTitleRefiner({
    getConfig: () => ({}),
    spawnLane: async (request) => {
      launched.resolve(request);
      await release.promise;
      await writeTitle(request, 'Improve dashboard titles');
    },
  });
  try {
    refiner.attachSession(session);
    submitPrompt(session, '<pasted_content id="x">Hidden instructions</pasted_content> Improve the dashboard titles');
    assert.equal(session.taskTitle, 'Improve the dashboard titles');
    endTurn(session, refiner);
    const request = await launched.promise;
    assert.equal(request.agent, 'claude-code');
    assert.equal(request.model, 'haiku');
    assert.equal(request.prompt, 'Read task-title-prompt.txt and follow its instructions');
    const prompt = await fs.readFile(path.join(request.cwd, 'task-title-prompt.txt'), 'utf8');
    assert.match(prompt, /untrusted data/);
    assert.match(prompt, /"Original task title"/);
    assert.doesNotMatch(prompt, /Hidden instructions/);
    release.resolve();
    await waitFor(() => session.taskTitle === 'Improve dashboard titles');
    assert.equal(await fs.stat(request.cwd).then(() => true, () => false), false);
  } finally {
    release.resolve();
    await refiner.stop();
    session.destroy();
  }
});

test('a single global flight queues only the latest request for each session', async () => {
  const first = makeSession('first');
  const second = makeSession('second');
  const third = makeSession('third');
  const release = deferred<void>();
  const requests: LaneRequest[] = [];
  const prompts: string[] = [];
  let flightCount = 0;
  let maxFlightCount = 0;
  const refiner = createTaskTitleRefiner({
    getConfig: () => ({ taskTitle: { refiner: { minIntervalSeconds: 0 } } }),
    spawnLane: async (request) => {
      flightCount++;
      maxFlightCount = Math.max(maxFlightCount, flightCount);
      requests.push(request);
      prompts.push(await fs.readFile(path.join(request.cwd, 'task-title-prompt.txt'), 'utf8'));
      if (requests.length === 1) await release.promise;
      await writeTitle(request, 'Latest refined task');
      flightCount--;
    },
  });
  try {
    for (const session of [first, second, third]) refiner.attachSession(session);
    submitPrompt(first, 'Start the first task');
    endTurn(first, refiner);
    await waitFor(() => requests.length === 1);
    submitPrompt(second, 'Obsolete queued task prompt');
    endTurn(second, refiner);
    submitPrompt(third, 'Start the third task');
    endTurn(third, refiner);
    submitPrompt(second, 'Latest queued task prompt');
    endTurn(second, refiner);
    assert.equal(requests.length, 1);
    release.resolve();
    await waitFor(() => third.taskTitle === 'Latest refined task');
    assert.equal(requests.length, 3);
    assert.equal(maxFlightCount, 1);
    assert.match(prompts[1], /Latest queued task prompt/);
    const recentPromptsLine = prompts[1].split('\n').find((line) => line.startsWith('["'));
    assert.ok(recentPromptsLine);
    const queuedPrompts: unknown = JSON.parse(recentPromptsLine);
    assert.deepEqual(queuedPrompts, ['Obsolete queued task prompt', 'Latest queued task prompt']);
  } finally {
    release.resolve();
    await refiner.stop();
    for (const session of [first, second, third]) session.destroy();
  }
});

test('ephemeral sessions, custom titles and disabled configuration never set pending or spawn', async () => {
  const sessions = [makeSession('ephemeral', { ephemeral: true }), makeSession('custom', { customTitle: 'Custom' }), makeSession('disabled')];
  let spawns = 0;
  const refiner = createTaskTitleRefiner({
    getConfig: () => ({ taskTitle: { refiner: { enabled: false } } }),
    spawnLane: async () => { spawns++; },
  });
  const enabledRefiner = createTaskTitleRefiner({ getConfig: () => ({}), spawnLane: async () => { spawns++; } });
  try {
    enabledRefiner.attachSession(sessions[0]);
    enabledRefiner.attachSession(sessions[1]);
    refiner.attachSession(sessions[2]);
    for (const session of sessions) {
      submitPrompt(session, 'Implement a new task');
      endTurn(session, refiner);
    }
    await nextTick();
    assert.equal(spawns, 0);
    assert.deepEqual(sessions.map((session) => session.taskTitle), ['Original task title', 'Custom', 'Original task title']);
    assert.ok(sessions.every((session) => !session._taskTitleSources.pendingPromptTitle));
  } finally {
    await refiner.stop();
    await enabledRefiner.stop();
    for (const session of sessions) session.destroy();
  }
});

test('a timeout aborts the lane, clears pending and removes its work directory', async () => {
  const session = makeSession('timeout');
  const launched = deferred<LaneRequest>();
  const refiner = createTaskTitleRefiner({
    getConfig: () => ({ taskTitle: { refiner: { timeoutSeconds: 0.05 } } }),
    spawnLane: async (request) => {
      assert.ok(request.signal);
      const aborted = once(request.signal, 'abort');
      launched.resolve(request);
      await aborted;
    },
  });
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    refiner.attachSession(session);
    submitPrompt(session, 'Implement the timeout task');
    endTurn(session, refiner);
    const request = await launched.promise;
    const changed = once(session, 'task-title-change');
    await changed;
    assert.equal(request.signal?.aborted, true);
    assert.equal(session.taskTitle, 'Original task title');
    assert.equal(await fs.stat(request.cwd).then(() => true, () => false), false);
  } finally {
    clearTimeout(keepAlive);
    await refiner.stop();
    session.destroy();
  }
});

test('failures and invalid or keep results restore the settled title without escaping the event loop', async () => {
  for (const outcome of ['failure', 'invalid', 'keep'] as const) {
    const session = makeSession(outcome);
    const warnings: string[] = [];
    const refiner = createTaskTitleRefiner({
      getConfig: () => ({}), logger: { warn: (message: string) => warnings.push(message) },
      spawnLane: async (request) => {
        if (outcome === 'failure') throw new Error('Lane failed');
        if (outcome === 'keep') await writeTitle(request, null);
        if (outcome === 'invalid') await fs.writeFile(path.join(request.cwd, 'task-title-result.json'), '{broken');
      },
    });
    try {
      refiner.attachSession(session);
      submitPrompt(session, 'Implement the next task');
      endTurn(session, refiner);
      await waitFor(() => session.taskTitle === 'Original task title');
      assert.equal(warnings.length, outcome === 'keep' ? 0 : 1);
    } finally {
      await refiner.stop();
      session.destroy();
    }
  }
});

test('new prompts and resets prevent old results from overwriting a newer conversation', async () => {
  for (const action of ['prompt', 'clear', 'fresh'] as const) {
    const session = makeSession(action);
    const launched = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const refiner = createTaskTitleRefiner({
      getConfig: () => ({ taskTitle: { refiner: { minIntervalSeconds: 0 } } }),
      spawnLane: async (request) => {
        calls++;
        if (calls === 1) {
          launched.resolve();
          await release.promise;
          await writeTitle(request, 'Obsolete refinement title');
          return;
        }
        await writeTitle(request, 'Latest conversation title');
      },
    });
    try {
      refiner.attachSession(session);
      submitPrompt(session, 'Implement the old task');
      endTurn(session, refiner);
      await launched.promise;
      if (action === 'clear') session._resetAutomaticTaskTitle();
      if (action === 'fresh') session._prepareRestart({ fresh: true });
      submitPrompt(session, 'Implement the new task');
      endTurn(session, refiner);
      release.resolve();
      await waitFor(() => session.taskTitle === 'Latest conversation title');
      assert.equal(calls, 2);
    } finally {
      release.resolve();
      await refiner.stop();
      session.destroy();
    }
  }
});

test('cooldown retains the latest prompt title until a later turn permits refinement', async () => {
  const session = makeSession('cooldown');
  let now = 0;
  let calls = 0;
  const refiner = createTaskTitleRefiner({
    getConfig: () => ({}), nowFn: () => now,
    spawnLane: async (request) => { calls++; await writeTitle(request, 'Refined task title'); },
  });
  try {
    refiner.attachSession(session);
    submitPrompt(session, 'Implement the first task');
    endTurn(session, refiner);
    await waitFor(() => session.taskTitle === 'Refined task title');
    now = 59999;
    submitPrompt(session, 'Implement the next task');
    endTurn(session, refiner);
    assert.equal(calls, 1);
    assert.equal(session.taskTitle, 'Implement the next task');
    now = 60000;
    endTurn(session, refiner);
    await waitFor(() => calls === 2);
  } finally {
    await refiner.stop();
    session.destroy();
  }
});

test('live configuration disables queued and active results and selects the latest model when reenabled', async () => {
  const first = makeSession('first');
  const second = makeSession('second');
  const release = deferred<void>();
  const launched = deferred<void>();
  let enabled = true;
  let model = 'haiku';
  const models: (string | null | undefined)[] = [];
  const refiner = createTaskTitleRefiner({
    getConfig: () => ({ taskTitle: { refiner: { enabled, model, minIntervalSeconds: 0 } } }),
    spawnLane: async (request) => {
      models.push(request.model);
      if (models.length === 1) { launched.resolve(); await release.promise; }
      await writeTitle(request, 'Refined live title');
    },
  });
  try {
    for (const session of [first, second]) refiner.attachSession(session);
    submitPrompt(first, 'Implement the first task');
    endTurn(first, refiner);
    await launched.promise;
    submitPrompt(second, 'Implement the queued task');
    endTurn(second, refiner);
    enabled = false;
    release.resolve();
    await waitFor(() => second.taskTitle === 'Original task title');
    assert.equal(first.taskTitle, 'Original task title');
    assert.deepEqual(models, ['haiku']);
    enabled = true;
    model = 'sonnet';
    submitPrompt(second, 'Implement another queued task');
    endTurn(second, refiner);
    await waitFor(() => second.taskTitle === 'Refined live title');
    assert.deepEqual(models, ['haiku', 'sonnet']);
  } finally {
    release.resolve();
    await refiner.stop();
    first.destroy();
    second.destroy();
  }
});

for (const state of [STATES.IDLE, STATES.COMPLETE]) {
  test(`existing session event wiring triggers title refinement on ${state} without adding a state listener`, async () => {
    const session = makeSession(`wired-${state}`);
    let calls = 0;
    const refiner = createTaskTitleRefiner({
      getConfig: () => ({}),
      spawnLane: async (request) => { calls++; await writeTitle(request, 'Wired refined title'); },
    });
    try {
      const config = { projects: [] };
      createSessionEventWiring({
        config, configStore: { save: () => config }, taskTitleRefiner: refiner,
        recordLane: () => {}, usage: { refreshSessions: () => {}, nudgeSession: () => {} },
        broadcastControl: () => {}, telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
        notificationManager: { acknowledge: () => {}, trigger: () => {} },
        getIngestLane: () => null, tapIngestForSession: () => {}, closeSessionDataClients: () => {},
        logger: { error: () => {}, log: () => {}, warn: () => {} },
      })(session);
      assert.equal(session.listenerCount('state-change'), 1);
      submitPrompt(session, 'Implement the wiring task');
      assert.equal(session.taskTitle, 'Implement the wiring task');
      assert.equal(calls, 0);
      session.state = state;
      session.emit('state-change', { from: STATES.RUNNING, to: state, event: 'task_complete', detail: null });
      await waitFor(() => session.taskTitle === 'Wired refined title');
      assert.equal(calls, 1);
    } finally {
      await refiner.stop();
      session.destroy();
    }
  });
}

test('stopping detaches only the refiner listeners and a reset cannot revive them', async () => {
  const session = makeSession('detach');
  const events = ['task-prompt', 'task-title-reset', 'task-title-change', 'teardown'];
  const externalListener = () => {};
  for (const event of events) session.on(event, externalListener);
  const refiner = createTaskTitleRefiner({ getConfig: () => ({}), spawnLane: async () => {} });
  try {
    refiner.attachSession(session);
    refiner.attachSession(session);
    for (const event of events) assert.equal(session.listenerCount(event), 2, event);
    submitPrompt(session, 'Implement a pending task');
    await refiner.stop();
    for (const event of events) assert.deepEqual(session.listeners(event), [externalListener], event);
    session._resetAutomaticTaskTitle();
    refiner.attachSession(session);
    submitPrompt(session, 'Implement a different task');
    assert.equal(session._taskTitleSources.pendingPromptTitle ?? null, null);
    for (const event of events) assert.deepEqual(session.listeners(event), [externalListener], event);
  } finally {
    await refiner.stop();
    session.destroy();
  }
});

test('a newer prompt keeps its pending title when an older flight ends during cooldown', async () => {
  const session = makeSession('flight-cooldown');
  const nextSession = makeSession('after-flight');
  const launched = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const refiner = createTaskTitleRefiner({
    getConfig: () => ({}), nowFn: () => 0,
    spawnLane: async (request) => {
      calls++;
      launched.resolve();
      await release.promise;
      await writeTitle(request, 'Obsolete task title');
    },
  });
  try {
    refiner.attachSession(session);
    submitPrompt(session, 'Implement the first task');
    endTurn(session, refiner);
    await launched.promise;
    submitPrompt(session, 'Implement the latest task');
    endTurn(session, refiner);
    assert.equal(session.taskTitle, 'Implement the latest task');
    refiner.attachSession(nextSession);
    submitPrompt(nextSession, 'Implement a separate task');
    endTurn(nextSession, refiner);
    release.resolve();
    await waitFor(() => nextSession.taskTitle === 'Obsolete task title');
    assert.equal(session.taskTitle, 'Implement the latest task');
    assert.equal(calls, 2);
  } finally {
    release.resolve();
    await refiner.stop();
    session.destroy();
    nextSession.destroy();
  }
});

test('keep clears the pending title without pinning it over a transcript title that arrives during refinement', async () => {
  const session = makeSession('keep-snapshot');
  const launched = deferred<void>();
  const release = deferred<void>();
  const refiner = createTaskTitleRefiner({
    getConfig: () => ({}),
    spawnLane: async (request) => {
      launched.resolve();
      await release.promise;
      await writeTitle(request, null);
    },
  });
  try {
    refiner.attachSession(session);
    submitPrompt(session, 'Continue implementing the original task');
    endTurn(session, refiner);
    await launched.promise;
    session._taskTitleSources.aiTitle = 'Late transcript title';
    session._updateTaskTitle();
    release.resolve();
    await waitFor(() => !session._taskTitleSources.pendingPromptTitle);
    assert.equal(session._taskTitleSources.refinedTitle ?? null, null);
    assert.equal(session.taskTitle, 'Late transcript title');
  } finally {
    release.resolve();
    await refiner.stop();
    session.destroy();
  }
});

test('malformed refiner settings fail closed instead of enabling default refinement', async () => {
  for (const taskTitle of [false, { refiner: false }, { refiner: { model: 42 } }, { refiner: { timeoutSeconds: 0 } }]) {
    const session = makeSession('invalid-config');
    let calls = 0;
    const refiner = createTaskTitleRefiner({ getConfig: () => ({ taskTitle }), spawnLane: async () => { calls++; } });
    try {
      refiner.attachSession(session);
      submitPrompt(session, 'Implement another task title');
      endTurn(session, refiner);
      await nextTick();
      assert.equal(calls, 0);
      assert.equal(session.taskTitle, 'Original task title');
    } finally {
      await refiner.stop();
      session.destroy();
    }
  }
});

test('a keep result leaves later OSC titles visible for agents without transcript titles', async () => {
  const session = makeSession('osc-keep', { agent: 'grok' });
  const refiner = createTaskTitleRefiner({ getConfig: () => ({}), spawnLane: async (request) => { await writeTitle(request, null); } });
  try {
    refiner.attachSession(session);
    session._titleSource.feed('\x1b]0;First OSC task - grok\x07');
    submitPrompt(session, 'Implement the OSC titled task');
    endTurn(session, refiner);
    await waitFor(() => !session._taskTitleSources.pendingPromptTitle);
    assert.equal(session.taskTitle, 'First OSC task');
    session._titleSource.feed('\x1b]0;Second OSC task - grok\x07');
    assert.equal(session.taskTitle, 'Second OSC task');
  } finally {
    await refiner.stop();
    session.destroy();
  }
});

test('a pending title left by a discarded flight during cooldown is refined once the cooldown ends', async () => {
  const session = makeSession('stranded-pending');
  const launched = deferred<void>();
  const release = deferred<void>();
  let now = 0;
  let calls = 0;
  const refiner = createTaskTitleRefiner({
    getConfig: () => ({ taskTitle: { refiner: { minIntervalSeconds: 0.05 } } }), nowFn: () => now,
    spawnLane: async (request) => {
      calls++;
      if (calls === 1) {
        launched.resolve();
        await release.promise;
        await writeTitle(request, 'Obsolete task title');
        return;
      }
      await writeTitle(request, 'Recovered refined title');
    },
  });
  try {
    refiner.attachSession(session);
    submitPrompt(session, 'Implement the first task');
    endTurn(session, refiner);
    await launched.promise;
    submitPrompt(session, 'Implement the latest task');
    endTurn(session, refiner);
    release.resolve();
    await waitFor(() => calls === 1 && session.taskTitle === 'Implement the latest task');
    now = 1000;
    await waitFor(() => session.taskTitle === 'Recovered refined title');
    assert.equal(calls, 2);
  } finally {
    release.resolve();
    await refiner.stop();
    session.destroy();
  }
});

test('stopping the refiner cancels a pending cooldown recheck', async () => {
  const session = makeSession('recheck-stop');
  let calls = 0;
  const refiner = createTaskTitleRefiner({
    getConfig: () => ({ taskTitle: { refiner: { minIntervalSeconds: 0.02 } } }), nowFn: () => 0,
    spawnLane: async (request) => { calls++; await writeTitle(request, 'Refined task title'); },
  });
  try {
    refiner.attachSession(session);
    submitPrompt(session, 'Implement the first task');
    endTurn(session, refiner);
    await waitFor(() => session.taskTitle === 'Refined task title');
    submitPrompt(session, 'Implement the next task');
    endTurn(session, refiner);
    await refiner.stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(calls, 1);
  } finally {
    await refiner.stop();
    session.destroy();
  }
});

test('an invalid result logs a warning and keeps the prompt eligible for the next turn end', async () => {
  const session = makeSession('invalid-retry');
  const warnings: string[] = [];
  let calls = 0;
  const refiner = createTaskTitleRefiner({
    getConfig: () => ({ taskTitle: { refiner: { minIntervalSeconds: 0 } } }), logger: { warn: (message: string) => warnings.push(message) },
    spawnLane: async (request) => {
      calls++;
      if (calls === 2) await writeTitle(request, 'Retried refined title');
    },
  });
  try {
    refiner.attachSession(session);
    submitPrompt(session, 'Implement the retried task');
    endTurn(session, refiner);
    await waitFor(() => calls === 1 && !session._taskTitleSources.pendingPromptTitle);
    assert.equal(warnings.length, 1);
    endTurn(session, refiner);
    await waitFor(() => session.taskTitle === 'Retried refined title');
    assert.equal(calls, 2);
  } finally {
    await refiner.stop();
    session.destroy();
  }
});

test('a restart in the middle of a turn restores the refined title instead of pinning the pending prompt', async () => {
  const firstSession = makeSession('mid-turn-restart');
  const firstRefiner = createTaskTitleRefiner({
    getConfig: () => ({ taskTitle: { refiner: { minIntervalSeconds: 0 } } }),
    spawnLane: async (request) => writeTitle(request, 'Refined task title'),
  });
  let restoredSession: Session | null = null;
  const restoredRefiner = createTaskTitleRefiner({ getConfig: () => ({}), spawnLane: async () => {} });
  try {
    firstRefiner.attachSession(firstSession);
    submitPrompt(firstSession, 'Implement the first task');
    endTurn(firstSession, firstRefiner);
    await waitFor(() => firstSession.taskTitle === 'Refined task title');
    firstSession.state = STATES.RUNNING;
    submitPrompt(firstSession, 'Implement the interrupted follow up task');
    assert.equal(firstSession.taskTitle, 'Implement the interrupted follow up task');
    const taskTitleState = firstSession.persistedTaskTitle;
    firstSession.destroy();
    restoredSession = new Session({ id: 'mid-turn-restart', name: 'mid-turn-restart', path: '/project', taskTitleState, resumeSessionId: 'conversation' });
    restoredRefiner.attachSession(restoredSession);
    assert.equal(restoredSession.taskTitle, 'Refined task title');
    endTurn(restoredSession, restoredRefiner);
    assert.equal(restoredSession.taskTitle, 'Refined task title');
  } finally {
    await firstRefiner.stop();
    await restoredRefiner.stop();
    firstSession.destroy();
    restoredSession?.destroy();
  }
});
