import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config } from '../shared/contracts/config.ts';
import { STATES } from '../shared/states.ts';
import { createCoderEnvPoller } from '../server/coder/coder-env-poller.ts';
import { createCoderEnvWiring } from '../server/coder/coder-env-wiring.ts';
import { CODER_ENV_IDLE_TICK_MS, sharingRefusal } from '../server/coder/core/coder-env-core.ts';
import type { ReconcilePlan } from '../server/coder/core/coder-env-core.ts';
import { manualTimers } from './helpers/manual-timers.ts';
import { waitFor } from './helpers/wait-for.ts';

const MAPPED_WORKSPACE = 'gv-0123456789ab';

const DAY_MS = 86_400_000;

function listing(names: string[], stoppedAtMsByName: Record<string, number> = {}): string {
  return JSON.stringify(names.map((name) => {
    const stoppedAtMs = stoppedAtMsByName[name];
    if (stoppedAtMs !== undefined) return { name, latest_build: { status: 'stopped', transition: 'stop', updated_at: new Date(stoppedAtMs).toISOString() } };
    return { name, latest_build: { status: 'running', transition: 'start', resources: [{ agents: [{ name: 'dev', lifecycle_state: 'ready' }] }] } };
  }));
}

function createHarness({ hasMapping = true, sharingStatus = '', idleState = STATES.RUNNING, createReleased = Promise.resolve(), createStderr = null }: {
  hasMapping?: boolean;
  createStderr?: string | null;
  sharingStatus?: string;
  idleState?: (typeof STATES)[keyof typeof STATES];
  createReleased?: Promise<void>;
} = {}) {
  const config: Pick<Config, 'coder' | 'projects' | 'remoteSessions'> = {
    remoteSessions: true,
    coder: { environments: [{ name: 'remote', template: 'linux', nodePath: '/usr/bin/node', checkoutRoot: '/home/coder/repos', idleStopMinutes: 1, maxLive: 2 }] },
    projects: [{ id: 'project', path: '/project', wasActive: true, ...(hasMapping ? {
      environment: { name: 'remote', workspace: MAPPED_WORKSPACE, remotePort: 40_001, branch: 'feature' },
    } : {}) }],
  };
  const timers = manualTimers();
  const commands: { args: string[]; input: string | undefined; env: NodeJS.ProcessEnv | undefined }[] = [];
  const events: string[] = [];
  const pollers: ReturnType<typeof createCoderEnvPoller>[] = [];
  const plans: ReconcilePlan[] = [];
  const warnings: string[] = [];
  const listings = { current: listing([MAPPED_WORKSPACE]) };
  let nowMs = 120_000;
  const wiring = createCoderEnvWiring({
    ...timers, setIntervalFn: timers.setTimeoutFn, clearIntervalFn: timers.clearTimeoutFn,
    config, platform: 'linux', now: () => nowMs, firstTickDelayMs: () => 0,
    env: { CODER_SESSION_TOKEN: 'coder-token-secret-0123456789abcdef' },
    sessionsForIdleCheck: () => [{ projectId: 'project', workspace: MAPPED_WORKSPACE, state: idleState, idleSinceMs: 0, idleStopMinutes: 1 }],
    persistMapping: async (projectId, mapping) => {
      const project = config.projects.find((candidate) => candidate.id === projectId);
      assert.ok(project);
      events.push(mapping ? 'persist' : 'clear');
      project.environment = mapping;
    },
    onReconciled: (plan) => { plans.push(plan); },
    runCoder: async (args, options) => {
      events.push(args[0]);
      commands.push({ args: [...args], input: options.input, env: options.env });
      if (args[0] === 'list') return { stdout: listings.current };
      if (args[0] === 'create' && createStderr !== null) throw Object.assign(new Error('Command failed: coder create'), { stderr: createStderr });
      if (args[0] === 'delete' && !listings.current.includes(args[1])) throw Object.assign(new Error('Command failed: coder delete'), { stderr: 'error: workspace not found\n' });
      if (args[0] === 'create') {
        assert.equal(config.projects[0].environment?.workspace, args[1]);
        await createReleased;
        listings.current = listing([args[1]]);
      }
      if (args[0] === 'sharing') return { stdout: sharingStatus };
      if (args[0] === 'ssh') return { stdout: 'v24.0.0\n' };
      return { stdout: '' };
    },
    createPoller: (options) => {
      const poller = createCoderEnvPoller(options);
      pollers.push(poller);
      return poller;
    },
    log: { warn: (message) => { warnings.push(message); } },
  });
  async function start(): Promise<void> {
    await wiring.start();
    await waitFor(() => plans.length === 1, 'boot reconciliation completes');
  }
  async function tick(): Promise<void> {
    nowMs += CODER_ENV_IDLE_TICK_MS;
    await pollers[0]?.tick();
  }
  async function reserveAndSave(liveCount = 0) {
    const reserved = await wiring.reserve({ projectId: 'project', environmentName: 'remote', branch: 'feature', liveCount });
    if (!reserved.ok) return reserved;
    events.push('persist');
    config.projects[0].environment = reserved.mapping;
    return reserved;
  }
  async function provisionReserved() {
    const reserved = await reserveAndSave();
    assert.ok(reserved.ok);
    return wiring.provision({ projectId: 'project', mapping: reserved.mapping, repoRemoteUrl: 'git@example.com:org/repo.git', baseBranch: 'main' });
  }
  return { wiring, start, tick, config, commands, events, plans, warnings, listings, timers, reserveAndSave, provisionReserved };
}

test('boot reconcile deletes only an unmapped gv workspace stopped past deleteAfterStoppedDays and leaves live or recent ones alone', async (context) => {
  const harness = createHarness();
  context.after(harness.wiring.stop);
  harness.listings.current = listing([MAPPED_WORKSPACE, 'gv-aaaaaaaaaaaa', 'gv-bbbbbbbbbbbb', 'gv-cccccccccccc', 'devbox-main'], {
    'gv-bbbbbbbbbbbb': 120_000 - 4 * DAY_MS,
    'gv-cccccccccccc': 120_000 - DAY_MS,
  });
  await harness.start();
  const mutations = harness.commands.filter(({ args }) => args[0] === 'delete' || args[0] === 'stop').map(({ args }) => args);
  assert.deepEqual(mutations, [['delete', 'gv-bbbbbbbbbbbb', '--yes']]);
  assert.deepEqual(harness.plans[0].keptUnmapped, ['gv-aaaaaaaaaaaa', 'gv-cccccccccccc']);
  assert.equal(harness.config.projects[0].environment?.workspace, MAPPED_WORKSPACE);
  assert.deepEqual(harness.plans[0].resume.map((mapping) => mapping.workspace), [MAPPED_WORKSPACE]);
});

test('boot reconcile keeps the mapping of a project whose workspace no longer exists', async (context) => {
  const harness = createHarness();
  context.after(harness.wiring.stop);
  harness.listings.current = listing([]);
  await harness.start();
  assert.equal(harness.config.projects[0].environment?.workspace, MAPPED_WORKSPACE);
  assert.ok(!harness.events.includes('clear'));
  assert.deepEqual(await harness.wiring.resume({ projectId: 'project' }), { ok: false, reason: `Coder workspace ${MAPPED_WORKSPACE} no longer exists; close this session and start a new one` });
});

test('a shared provision deletes its workspace and keeps its mapping after persisting before create without token argv', async (context) => {
  const sharingStatus = 'other@example.com member';
  const harness = createHarness({ hasMapping: false, sharingStatus });
  context.after(harness.wiring.stop);
  const provision = await harness.provisionReserved();
  const createdWorkspace = harness.commands.find(({ args }) => args[0] === 'create')?.args[1];
  assert.deepEqual(provision, { ok: false, reason: sharingRefusal(sharingStatus) });
  assert.ok(createdWorkspace && harness.events.indexOf('persist') < harness.events.indexOf('create'));
  assert.deepEqual(harness.commands.at(-1)?.args, ['delete', createdWorkspace, '--yes']);
  assert.equal(harness.config.projects[0].environment?.workspace, createdWorkspace);
  assert.ok(!harness.events.includes('clear'));
  assert.ok(harness.commands.every(({ args, input, env }) => input === '' && env?.CODER_SESSION_TOKEN === 'coder-token-secret-0123456789abcdef' && args.every((argument) => !argument.includes('coder-token-secret-0123456789abcdef'))));
});

test('a reconcile tick during a provision between persist and create neither forgets that mapping nor deletes that workspace', async (context) => {
  let releaseCreate = () => {};
  const harness = createHarness({ hasMapping: false, createReleased: new Promise<void>((resolve) => { releaseCreate = resolve; }) });
  context.after(harness.wiring.stop);
  harness.listings.current = listing([]);
  const provision = harness.provisionReserved();
  await waitFor(() => harness.events.includes('create'), 'provision reaches create');
  const provisionedWorkspace = harness.config.projects[0].environment?.workspace;
  await harness.start();
  assert.equal(harness.config.projects[0].environment?.workspace, provisionedWorkspace);
  releaseCreate();
  const provisionResult = await provision;
  assert.equal(provisionResult.ok, true);
  assert.equal(harness.config.projects[0].environment?.workspace, provisionedWorkspace);
  assert.ok(provisionedWorkspace && harness.commands.every(({ args }) => !(args[0] === 'delete' && args[1] === provisionedWorkspace)));
  assert.ok(!harness.events.includes('clear'));
});

test('an idle remote session past its idle limit stops once during that idle period', async (context) => {
  const harness = createHarness({ idleState: STATES.IDLE });
  context.after(harness.wiring.stop);
  await harness.start();
  await harness.tick();
  await harness.tick();
  assert.deepEqual(harness.commands.filter(({ args }) => args[0] === 'stop').map(({ args }) => args), [['stop', MAPPED_WORKSPACE, '--yes']]);
  assert.equal(harness.timers.pending[0]?.ms, CODER_ENV_IDLE_TICK_MS);
});

test('maxLive and a switched-off Remote Coder sessions setting both refuse a new workspace without running a coder command', async (context) => {
  const harness = createHarness({ hasMapping: false });
  context.after(harness.wiring.stop);
  const reserved = await harness.reserveAndSave(2);
  assert.deepEqual(reserved, { ok: false, reason: 'remote already has 2 of 2 live workspaces; close one first' });
  harness.config.remoteSessions = false;
  assert.deepEqual(await harness.reserveAndSave(0), { ok: false, reason: 'Remote Coder sessions are off. Turn on Remote Coder sessions (experimental) in Settings.' });
  assert.equal(harness.wiring.availableEnvironments(), null);
  assert.deepEqual(harness.commands, []);
  assert.equal(harness.config.projects[0].environment, undefined);
});

test('a resume during or after a failed provision returns that provision\'s failure reason', async (context) => {
  let releaseCreate = () => {};
  const sharingStatus = 'other@example.com member';
  const harness = createHarness({ hasMapping: false, sharingStatus, createReleased: new Promise<void>((resolve) => { releaseCreate = resolve; }) });
  context.after(harness.wiring.stop);
  const provision = harness.provisionReserved();
  await waitFor(() => harness.events.includes('create'), 'provision reaches create');
  const resume = harness.wiring.resume({ projectId: 'project' });
  releaseCreate();
  const [provisionResult, resumeResult] = await Promise.all([provision, resume]);
  assert.deepEqual(resumeResult, { ok: false, reason: sharingRefusal(sharingStatus) });
  assert.deepEqual(resumeResult, provisionResult);
  assert.deepEqual(await harness.wiring.resume({ projectId: 'project' }), provisionResult);
  assert.ok(!harness.events.includes('start'));
});

test('a create the template refuses before any workspace exists reports the coder error and no cleanup failure', async (context) => {
  const harness = createHarness({ hasMapping: false, createStderr: 'Dotfiles Branch\n> Enter a value: Encountered an error running "coder create"\nerror: prepare build: EOF\n' });
  context.after(harness.wiring.stop);
  const provisioned = await harness.provisionReserved();
  assert.deepEqual(provisioned, { ok: false, reason: 'Coder create failed: prepare build: EOF' });
  assert.ok(harness.commands.find(({ args }) => args[0] === 'create')?.args.includes('--use-parameter-defaults'));
});
