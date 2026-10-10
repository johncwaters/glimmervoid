import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createFactoryPoller } from '../server/factory-poller.ts';
import type { FactoryPollerDeps } from '../server/factory-poller.ts';
import type { FactoryState } from '../shared/contracts/factory.ts';

async function createHarness(overrides: Partial<FactoryPollerDeps> = {}) {
  const orient = await readFile(new URL('./fixtures/coherence/0.37.1/orient-dispatch.json', import.meta.url), 'utf8');
  const work = await readFile(new URL('./fixtures/coherence/0.37.1/work-dispatch.json', import.meta.url), 'utf8');
  const messages: FactoryState[] = [];
  const commands: string[][] = [];
  const checkouts: string[] = [];
  const releasedProjectIds: string[] = [];
  const probedConfigShas: string[] = [];
  const controls = {
    sha: 'a'.repeat(40), hasConfig: true, output: null as string | null, failure: null as Error | null,
    projects: [{ id: 'project-1', name: 'Factory', path: '/repo' }],
  };
  const poller = createFactoryPoller({
    now: () => 100,
    listFactoryProjects: () => controls.projects,
    resolveIntegrationBranch: async () => 'main',
    readBranchSha: async () => controls.sha,
    hasCoherenceConfigAt: async (_projectPath, sha) => { probedConfigShas.push(sha); return controls.hasConfig; },
    ensureControlCheckout: async ({ sha }) => { checkouts.push(sha); return '/control'; },
    releaseControlCheckout: async (projectId) => { releasedProjectIds.push(projectId); },
    runCoherence: async ({ args }) => {
      commands.push(args);
      if (controls.failure) throw controls.failure;
      if (controls.output !== null) return controls.output;
      return args[0] === 'orient' ? orient : work;
    },
    broadcast: (message) => messages.push(message),
    ...overrides,
  });
  return { poller, messages, commands, checkouts, releasedProjectIds, probedConfigShas, controls };
}

test('an unchanged SHA reuses the state without coherence calls or a broadcast', async () => {
  const { poller, messages, commands, checkouts } = await createHarness();
  assert.equal(poller.getState(), null);
  await poller.tick();
  await poller.tick();
  assert.deepEqual(commands, [['orient', '--json'], ['work', 'inspect', '--json']]);
  assert.equal(checkouts.length, 1);
  assert.equal(messages.length, 1);
  assert.deepEqual(poller.getState(), messages[0]);
  await poller.stop();
});

test('a moved SHA refreshes both reports and broadcasts the new head', async () => {
  const { poller, messages, commands, controls } = await createHarness();
  await poller.tick();
  controls.sha = 'b'.repeat(40);
  await poller.tick();
  assert.equal(commands.length, 4);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].projects[0].headSha, controls.sha);
  await poller.stop();
});

test('an active verifier holds its checkout at the reviewed tip until it finishes', async () => {
  let isVerifying = false;
  let tickCount = 0;
  const { poller, messages, commands, checkouts, controls } = await createHarness({
    shouldHoldCheckout: () => isVerifying,
    beforeTick: () => { tickCount += 1; },
  });
  await poller.tick();
  isVerifying = true;
  controls.sha = 'b'.repeat(40);
  await poller.tick();
  assert.deepEqual(checkouts, ['a'.repeat(40)]);
  assert.equal(commands.length, 2);
  assert.equal(messages.length, 1);
  isVerifying = false;
  await poller.tick();
  assert.deepEqual(checkouts, ['a'.repeat(40), controls.sha]);
  assert.equal(commands.length, 4);
  assert.equal(messages[1].projects[0].headSha, controls.sha);
  assert.equal(tickCount, 3);
  await poller.stop();
});

for (const output of ['not json', '{}']) {
  test(`invalid coherence output ${output} becomes an error state and can recover at the same SHA`, async () => {
    const { poller, messages, controls } = await createHarness();
    controls.output = output;
    await assert.doesNotReject(poller.tick());
    assert.ok(messages[0].projects[0].error);
    assert.equal(messages[0].projects[0].heading.action, 'refuse');
    assert.deepEqual(messages[0].projects[0].orders, []);
    controls.output = null;
    await poller.tick();
    assert.equal(messages[1].projects[0].error, null);
    await poller.stop();
  });
}

test('a rejected coherence command is isolated from the other projects', async () => {
  const { poller, messages } = await createHarness({
    listFactoryProjects: () => [
      { id: 'broken', name: 'Broken', path: '/broken' },
      { id: 'healthy', name: 'Healthy', path: '/healthy' },
    ],
    ensureControlCheckout: async ({ projectPath }) => projectPath,
    runCoherence: async ({ cwd, args }) => {
      if (cwd === '/broken') throw new Error('exit code 1');
      const fixture = args[0] === 'orient' ? 'orient-steady' : 'work-steady';
      return readFile(new URL(`./fixtures/coherence/0.37.1/${fixture}.json`, import.meta.url), 'utf8');
    },
  });
  await assert.doesNotReject(poller.tick());
  assert.equal(messages[0].projects[0].error, 'exit code 1');
  assert.equal(messages[0].projects[1].error, null);
  await poller.stop();
});

test('projects without a coherence config are skipped and cached removals are broadcast', async () => {
  const { poller, messages, commands, controls } = await createHarness();
  controls.hasConfig = false;
  await poller.tick();
  assert.deepEqual(messages[0].projects, []);
  assert.deepEqual(commands, []);
  controls.hasConfig = true;
  await poller.tick();
  controls.hasConfig = false;
  await poller.tick();
  assert.deepEqual(messages[2].projects, []);
  controls.hasConfig = true;
  await poller.tick();
  assert.equal(commands.length, 4);
  await poller.stop();
});

test('floor membership is probed at the integration tip sha', async () => {
  const { poller, probedConfigShas, controls } = await createHarness();
  await poller.tick();
  controls.sha = 'b'.repeat(40);
  await poller.tick();
  assert.deepEqual(probedConfigShas, ['a'.repeat(40), 'b'.repeat(40)]);
  await poller.stop();
});

const unresolvableTipCases: Array<{ failingStep: string; overrides: (isResolvable: () => boolean) => Partial<FactoryPollerDeps> }> = [
  {
    failingStep: 'resolving the integration branch',
    overrides: (isResolvable) => ({
      resolveIntegrationBranch: async () => { if (isResolvable()) return 'main'; throw new Error('not a git repository'); },
    }),
  },
  {
    failingStep: 'reading the integration tip sha',
    overrides: (isResolvable) => ({
      readBranchSha: async () => { if (isResolvable()) return 'a'.repeat(40); throw new Error('Could not resolve origin/main or main'); },
    }),
  },
];

for (const { failingStep, overrides } of unresolvableTipCases) {
  test(`a project failing at ${failingStep} is skipped without an error state and releases its checkout`, async () => {
    let isResolvable = true;
    const { poller, messages, commands, probedConfigShas, releasedProjectIds } = await createHarness(overrides(() => isResolvable));
    await poller.tick();
    assert.equal(messages[0].projects.length, 1);
    isResolvable = false;
    await poller.tick();
    assert.deepEqual(messages[1].projects, []);
    assert.equal(commands.length, 2);
    assert.equal(probedConfigShas.length, 1);
    assert.deepEqual(releasedProjectIds, ['project-1']);
    await poller.stop();
  });
}

test('a project removed from the list releases its control checkout once', async () => {
  const { poller, releasedProjectIds, controls } = await createHarness();
  await poller.tick();
  assert.deepEqual(releasedProjectIds, []);
  controls.projects = [];
  await poller.tick();
  await poller.tick();
  assert.deepEqual(releasedProjectIds, ['project-1']);
  await poller.stop();
});

test('a project whose coherence config disappears releases its control checkout', async () => {
  const { poller, releasedProjectIds, controls } = await createHarness();
  await poller.tick();
  controls.hasConfig = false;
  await poller.tick();
  assert.deepEqual(releasedProjectIds, ['project-1']);
  await poller.stop();
});

test('a project in an error state that is removed still releases its control checkout', async () => {
  const { poller, messages, releasedProjectIds, controls } = await createHarness();
  controls.failure = new Error('exit code 1');
  await poller.tick();
  assert.equal(messages[0].projects[0].error, 'exit code 1');
  controls.projects = [];
  await poller.tick();
  assert.deepEqual(releasedProjectIds, ['project-1']);
  await poller.stop();
});

test('a failed release is logged and the tick still broadcasts', async () => {
  const warnings: string[] = [];
  const { poller, messages, controls } = await createHarness({
    log: { warn: (message: string) => { warnings.push(message); } },
    releaseControlCheckout: async () => { throw new Error('rm failed'); },
  });
  await poller.tick();
  controls.projects = [];
  await assert.doesNotReject(poller.tick());
  assert.deepEqual(messages[1].projects, []);
  assert.ok(warnings.some((warning) => warning.includes('rm failed')));
  await poller.stop();
});

function failedCommand(stdout: string): Error {
  return Object.assign(new Error('Command failed: coherence'), { code: 2, stdout, stderr: '' });
}

for (const { cause, failure } of [
  { cause: 'a timeout kill', failure: { code: null, killed: true, signal: 'SIGTERM' } },
  { cause: 'a maxBuffer overflow', failure: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' } },
]) {
  test(`${cause} reports the command failure instead of parsing its truncated stdout`, async () => {
    const { poller, messages, commands } = await createHarness({
      runCoherence: async ({ args }) => {
        commands.push(args);
        throw Object.assign(new Error(`coherence failed by ${cause}`), { ...failure, stdout: '{"action":"disp', stderr: '' });
      },
    });
    await poller.tick();
    const [project] = messages[0].projects;
    assert.equal(project.error, `coherence failed by ${cause}`);
    assert.equal(project.heading.action, 'refuse');
    assert.deepEqual(commands, [['orient', '--json']]);
    await poller.stop();
  });
}

test('a refusing orient that exits non-zero shows the ledger reasons without a work inspection', async () => {
  const refusal = await readFile(new URL('./fixtures/coherence/0.37.1/orient-refuse.json', import.meta.url), 'utf8');
  const { poller, messages, commands } = await createHarness({
    runCoherence: async ({ args }) => {
      commands.push(args);
      throw failedCommand(refusal);
    },
  });
  await poller.tick();
  const [project] = messages[0].projects;
  assert.equal(project.error, null);
  assert.equal(project.heading.action, 'refuse');
  assert.ok(project.heading.reasons.some((reason) => reason.includes('is malformed JSON')));
  assert.deepEqual(project.orders, []);
  assert.deepEqual(commands, [['orient', '--json']]);
  await poller.stop();
});

test('a failed work inspection printing error JSON beside a dispatch orient becomes an error state', async () => {
  const orient = await readFile(new URL('./fixtures/coherence/0.37.1/orient-dispatch.json', import.meta.url), 'utf8');
  const failedInspection = await readFile(new URL('./fixtures/coherence/0.37.1/work-refuse.json', import.meta.url), 'utf8');
  const { poller, messages } = await createHarness({
    runCoherence: async ({ args }) => {
      if (args[0] === 'orient') return orient;
      throw failedCommand(failedInspection);
    },
  });
  await poller.tick();
  const [project] = messages[0].projects;
  assert.ok(project.error);
  assert.equal(project.heading.action, 'refuse');
  assert.deepEqual(project.orders, []);
  await poller.stop();
});

test('pause changes broadcast at the same integration SHA without rereading coherence', async () => {
  let paused = false;
  const { poller, messages, commands } = await createHarness({ readPaused: async () => paused });
  await poller.tick();
  paused = true;
  await poller.refreshNow();
  assert.equal(messages[0].projects[0].paused, false);
  assert.equal(messages[1].projects[0].paused, true);
  assert.equal(commands.length, 2);
  await poller.stop();
});

test('refresh requested during a tick waits and rereads the newly landed integration tip', async () => {
  let markReportStarted: () => void = () => {};
  let releaseReport: () => void = () => {};
  const reportIsRunning = new Promise<void>((resolve) => { markReportStarted = resolve; });
  const reportCanFinish = new Promise<void>((resolve) => { releaseReport = resolve; });
  const orient = await readFile(new URL('./fixtures/coherence/0.37.1/orient-dispatch.json', import.meta.url), 'utf8');
  const work = await readFile(new URL('./fixtures/coherence/0.37.1/work-dispatch.json', import.meta.url), 'utf8');
  const { poller, messages, controls } = await createHarness({
    runCoherence: async ({ args }) => {
      if (args[0] !== 'orient') return work;
      markReportStarted();
      await reportCanFinish;
      return orient;
    },
  });
  const firstTick = poller.tick();
  await reportIsRunning;
  controls.sha = 'b'.repeat(40);
  const refresh = poller.refreshNow();
  releaseReport();
  await Promise.all([firstTick, refresh]);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].projects[0].headSha, controls.sha);
  await poller.stop();
});

test('each poller tick processes cached state for live orchestrator changes and releases removed sessions', async () => {
  let processedCount = 0;
  const released: string[] = [];
  const fixture = await createHarness({
    processProjectState: async (project) => {
      processedCount += 1;
      return { ...project, orchestrator: { sessionId: 'factory-orch-project-1', intentId: project.orders[0].id, state: processedCount === 1 ? 'RUNNING' : 'IDLE' } };
    },
    releaseOrchestrator: (projectId) => { released.push(projectId); },
  });
  await fixture.poller.tick();
  await fixture.poller.tick();
  assert.equal(processedCount, 2);
  assert.equal(fixture.commands.length, 2);
  assert.equal(fixture.messages.length, 2);
  assert.equal(fixture.messages[1].projects[0].orchestrator?.state, 'IDLE');
  fixture.controls.projects = [];
  await fixture.poller.tick();
  assert.deepEqual(released, ['project-1']);
  await fixture.poller.stop();
});
