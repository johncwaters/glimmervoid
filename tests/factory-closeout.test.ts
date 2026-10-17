import { createFactoryVerifier } from '../server/factory/factory-verifier.ts';
import { buildFactoryProjectState, FACTORY_REVIEW_DIFF_MAX_CHARS, formatWorkerEvent, nextIntent } from '../server/factory/core/factory-core.ts';
import type { FactoryProjectState } from '../shared/contracts/factory.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { execFileAsync } from '../server/child-process-safe.ts';
import type { PrepareFactoryCheckRunner } from '../server/factory/factory-check-guardrails.ts';
import { createFactoryCloseOut } from '../server/factory/factory-closeout.ts';
import type { FactoryCloseOutDeps, FactoryCloseOutWorker } from '../server/factory/factory-closeout.ts';
import { commitAndLandFactoryLedger, hasCodeChangedBetween, readCodeDiffBetween, screenPendingLedgerWrites } from '../server/factory/factory-ledger.ts';
import { hostScratchRoot } from '../server/host-scratch.ts';
import { createSpawnGate } from '../server/spawn-gate.ts';
import type { MemoryAdmission } from '../server/spawn-gate.ts';
import type { LaneSpawn } from '../server/lanes/lane-spawn.ts';
import { createFactoryWiring } from '../server/factory/factory-wiring.ts';
import { createSessionFactory } from '../server/session/session-factory.ts';
import { HookRouter } from '../detection/hook-source.ts';
import type { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { passthroughWorkLane } from './helpers/passthrough-work-lane.ts';
import { createCoherenceLedger, initGitRepository, stubEnvironmentVariable } from './helpers/factory-fixture.ts';
import { waitFor } from './helpers/wait-for.ts';
import { FactoryLaneState, FactoryWorkerEvent } from '../shared/contracts/factory.ts';
import type { GlimmervoidConfig } from '../server/config-store.ts';

const prepareUnguardedCheckRunner: PrepareFactoryCheckRunner = async () => ({
  runCheck: (argv, options) => execFileAsync(argv[0], argv.slice(1), options),
  dispose: async () => {},
});

async function createFixture(context: TestContext, activateOrder = true, capCounters: Pick<FactoryCloseOutDeps, 'countTicketBlock' | 'checkRunGate' | 'onCheckMemoryWait' | 'log'> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-closeout-'));
  const cleanupTasks: (() => Promise<void>)[] = [];
  context.after(async () => {
    for (const cleanupTask of cleanupTasks.toReversed()) await cleanupTask();
    await rm(directory, { recursive: true, force: true });
  });
  const coherenceLedger = await createCoherenceLedger(directory);
  const { projectPath, git, gitWorkspace, ledger, runCoherence, land } = coherenceLedger;
  const createOrder = (parent: string | null, objective = 'Ship retries') => coherenceLedger.createOrder({ parent, objective });
  const intentId = await createOrder(null);
  const workId = await createOrder(intentId);
  if (activateOrder) await runCoherence({ cwd: ledger.cwd, args: ['work', 'transition', workId, 'active', '--because', 'Factory dispatch', '--session', 'glimmervoid-factory'] });
  await land('repo', projectPath, 'factory: prepare tickets');
  const workspace = await gitWorkspace.create({ projectPath, teamId: 'repo', label: 'factory-worker', baseBranch: 'integration', configuredIntegrationBranch: 'integration', worktreeBase: directory, shareList: [] });
  assert.ok(workspace.isGit);
  assert.ok(workspace.baseSha);
  const feedback: string[] = [];
  const recordedScopeNeeds: { intentId: string; files: string[] }[] = [];
  const events: FactoryWorkerEvent[] = [];
  const trustedVerifications: { projectId: string; id: string; sha: string }[] = [];
  const exceptions: string[] = [];
  const clearedExceptions: string[] = [];
  const decisionReasons: (string | null)[] = [];
  const reviewRequests: Parameters<LaneSpawn>[0][] = [];
  const reviewerCwdEntries: string[][] = [];
  let isDestroyed = false;
  let isPaused = false;
  let shouldFailTrustWrite = false;
  let shouldFailLanding = false;
  let shouldWriteVerdictFileOnly = false;
  let verdict: unknown = { pass: true, findings: [] };
  let reviewBarrier: (() => Promise<void>) | null = null;
  let mergeReason: string | null = null;
  let mergedSha: string | null = null;
  let workerBaseSha = workspace.baseSha;
  let prepareCheckRunner = prepareUnguardedCheckRunner;
  const config: FactoryCloseOutDeps['config'] = { factory: { enabled: true, checks: [`${process.execPath} --version`], reviewerModel: 'sonnet' }, worktreeShare: ['node_modules'] };
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  const worker: FactoryCloseOutWorker = {
    workId, intentId, projectId: 'repo', projectPath, baseSha: workspace.baseSha,
    objective: 'Ship retries', criteria: ['Retries pass'], writeScopes: ['src/retry.ts'],
    session: {
      worktreeDir: workspace.cwd,
      get baseSha() { return workerBaseSha; },
      get _destroyed() { return isDestroyed; },
      destroy: () => { isDestroyed = true; },
      pasteTextWhenReady: (text) => { feedback.push(text); return { ok: true, deferred: false, bracketed: true }; },
      write: () => {},
      mergeWorktree: async () => {
        if (mergeReason) return { merged: false, parked: true, reason: mergeReason };
        const merged = await gitWorkspace.mergeBack({ projectPath, workspace, targetBranch: 'integration' });
        if (merged.merged) mergedSha = await git(['rev-parse', 'integration']);
        return merged;
      },
    },
  };
  const closeOut = createFactoryCloseOut({
    ...capCounters, config, runCoherence, gitWorkspace, ensureLedger: async () => ledger,
    recordScopeNeeds: (worker, files) => { recordedScopeNeeds.push({ intentId: worker.intentId, files }); return files; },
    commitAndLand: async (...landing) => {
      if (shouldFailLanding) throw new Error('Ledger push is unavailable');
      return land(...landing);
    },
    serializeProject: coherenceLedger.serializeProject,
    readIntegrationSha: () => git(['rev-parse', 'integration']),
    recordFactoryLandedSha: async () => {},
    readPaused: async () => isPaused, baseEnv, recordDecision: async (decision) => { decisionReasons.push(decision.reason); }, prepareCheckRunner: (paths) => prepareCheckRunner(paths),
    trustVerification: async (projectId, verification) => {
      if (shouldFailTrustWrite) throw new Error('Lane state is unwritable');
      trustedVerifications.push({ projectId, ...verification });
    },
    setException: (_projectId, reason) => { exceptions.push(reason); },
    clearException: (_projectId, expectedReason) => { clearedExceptions.push(expectedReason); },
    notifyOrchestrator: (_projectId, event) => { events.push(event); },
    spawnReviewer: async (request) => {
      const promptFileIndex = request.extraArgs?.indexOf('--append-system-prompt-file') ?? -1;
      const promptFile = request.extraArgs?.[promptFileIndex + 1];
      assert.ok(promptFile);
      reviewRequests.push({ ...request, prompt: await readFile(promptFile, 'utf8') });
      reviewerCwdEntries.push(await readdir(request.cwd));
      await reviewBarrier?.();
      if (verdict === null) return;
      if (shouldWriteVerdictFileOnly) {
        const resultPath = reviewRequests.at(-1)?.prompt.match(/Glimmervoid saves it to (.+)\./)?.[1];
        assert.ok(resultPath);
        await writeFile(resultPath, JSON.stringify(verdict));
        return;
      }
      request.onOutput?.(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: verdict }));
    },
  });
  cleanupTasks.push(() => closeOut.stop());
  const commitChange = async (relativePath = 'src/retry.ts') => {
    await mkdir(path.dirname(path.join(workspace.cwd, relativePath)), { recursive: true });
    await writeFile(path.join(workspace.cwd, relativePath), 'export const retries = 1;\n');
    await git(['add', '--', relativePath], workspace.cwd);
    await git(['commit', '-m', 'fix: retries'], workspace.cwd);
  };
  return { ...coherenceLedger, config, worker, closeOut, createOrder, workspace, directory, cleanupTasks, feedback, recordedScopeNeeds, events, trustedVerifications, exceptions, clearedExceptions, decisionReasons, reviewRequests, reviewerCwdEntries, commitChange, baseEnv,
    isDestroyed: () => isDestroyed, mergedSha: () => mergedSha, setPaused: (paused: boolean) => { isPaused = paused; },
    setWorkerBaseSha: (baseSha: string) => { workerBaseSha = baseSha; },
    failTrustWrite: () => { shouldFailTrustWrite = true; },
    setLandingFails: (isFailing: boolean) => { shouldFailLanding = isFailing; },
    setVerdictFileOnly: (nextVerdict: unknown) => { verdict = nextVerdict; shouldWriteVerdictFileOnly = true; },
    setVerdict: (nextVerdict: unknown) => { verdict = nextVerdict; },
    setReviewBarrier: (barrier: () => Promise<void>) => { reviewBarrier = barrier; },
    setMergeReason: (reason: string) => { mergeReason = reason; },
    setCheckRunner: (nextPrepareCheckRunner: PrepareFactoryCheckRunner) => { prepareCheckRunner = nextPrepareCheckRunner; },
  };
}

test('passing factory worker merges and pushes, closes with merge-tip evidence, and files a trusted merge verification', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  const previousOrigin = await fixture.git(['rev-parse', 'origin/integration']);
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.deepEqual(fixture.feedback, []);
  assert.deepEqual(fixture.exceptions, []);
  assert.equal(fixture.isDestroyed(), true);
  assert.notEqual(await fixture.git(['rev-parse', 'origin/integration']), previousOrigin);
  assert.equal(await fixture.git(['rev-parse', 'integration']), await fixture.git(['rev-parse', 'origin/integration']));
  const order = (await fixture.inspect()).work.find((candidate) => candidate.work === fixture.worker.workId);
  assert.equal(order?.state, 'completed');
  const closeCommand = fixture.commands.find((command) => command[1] === 'close');
  assert.ok(closeCommand);
  assert.equal(closeCommand[closeCommand.indexOf('--evidence') + 1], fixture.mergedSha());
  assert.deepEqual(fixture.trustedVerifications, [{ projectId: fixture.worker.projectId, id: `merged-${fixture.worker.workId}`, sha: fixture.mergedSha() }]);
  const verificationCommand = fixture.commands.find((command) => command[0] === 'consequence' && command[2] === `verification:merged-${fixture.worker.workId}`);
  assert.ok(verificationCommand);
  assert.equal(verificationCommand[4], `work:${fixture.worker.workId}`);
  assert.ok(verificationCommand[verificationCommand.indexOf('--evidence') + 1].includes(fixture.mergedSha() ?? 'missing'));
  assert.equal(fixture.events.at(-1)?.event, 'merged');
  assert.equal(fixture.closeOut.reviewing.size, 0);
  assert.notEqual(fixture.reviewRequests[0].cwd, fixture.workspace.cwd);
  assert.ok(fixture.reviewRequests[0].cwd.startsWith(realpathSync(hostScratchRoot())));
  assert.deepEqual(fixture.reviewerCwdEntries[0], []);
  assert.equal(fixture.reviewRequests[0].extraArgs?.includes('--add-dir'), false);
  const reviewerSchemaArg = fixture.reviewRequests[0].extraArgs?.[fixture.reviewRequests[0].extraArgs.indexOf('--json-schema') + 1] ?? '{}';
  assert.equal(JSON.parse(reviewerSchemaArg).$schema, 'http://json-schema.org/draft-07/schema#');
  assert.ok(fixture.reviewRequests[0].prompt.includes('+export const retries = 1;'));
  assert.match(fixture.reviewRequests[0].prompt, /<<<GLIMMERVOID-FACTORY-REVIEW-DIFF/);
  assert.equal(fixture.reviewRequests[0].model, 'sonnet');
  assert.ok(fixture.reviewRequests[0].prompt.includes(fixture.worker.baseSha ?? 'missing'));
  assert.ok(fixture.reviewRequests[0].prompt.includes('Retries pass'));
  assert.equal(await readFile(path.join(fixture.worker.projectPath, 'src/retry.ts'), 'utf8'), 'export const retries = 1;\n');
});

test('a check run held for memory waits without failing or charging the ticket, and merges once admitted', async (context) => {
  const memoryWaits: [string, boolean][] = [];
  let admitCheckRun = () => {};
  const memoryAdmission: MemoryAdmission = {
    waitForHeadroom: async (kind, options) => {
      assert.equal(kind, 'checkRun');
      options?.onMemoryWait?.(true);
      await new Promise<void>((resolve) => { admitCheckRun = resolve; });
      options?.onMemoryWait?.(false);
    },
    noteStartHeld: () => {},
    gateStatus: () => ({ headroomBytes: null, headroomReadAtMs: null, heldStartCount: 0 }),
    describeShortfallNow: async () => null,
  };
  const checkRunGate = createSpawnGate({ memoryAdmission, kind: 'checkRun' });
  const fixture = await createFixture(context, true, { checkRunGate, onCheckMemoryWait: (projectId, isWaiting) => memoryWaits.push([projectId, isWaiting]) });
  await fixture.commitChange();
  const closing = fixture.closeOut.turnEnded(fixture.worker);
  await waitFor(() => memoryWaits.length === 1, 'the check run is held for memory', 10_000);
  assert.deepEqual(fixture.reviewRequests, []);
  assert.deepEqual(fixture.feedback, []);
  admitCheckRun();
  await closing;
  assert.deepEqual(memoryWaits, [['repo', true], ['repo', false]]);
  assert.deepEqual(fixture.exceptions, []);
  assert.deepEqual(fixture.feedback, []);
  assert.ok(fixture.mergedSha());
});

test('out-of-fence worker retries with the path and never runs a reviewer', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange('outside.ts');
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.match(fixture.feedback[0], /Outside write scopes: outside.ts/);
  assert.equal(fixture.reviewRequests.length, 0);
  assert.equal(fixture.isDestroyed(), false);
});

test('failing repo check retries with its failing tests and load-time crash cause even when passing output follows them, and never runs a reviewer', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  const expectedFailureBlock = `not ok 1 - the expected failure # TODO\n  ---\n  error: 'expected failure evidence'\n  ...\n`;
  const loadTimeCrashBlock = `# Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'missing.ts'\n# Subtest: tests/broken.test.ts\nnot ok 2 - tests/broken.test.ts\n  ---\n  failureType: 'testCodeFailure'\n  error: 'test failed'\n  ...\n`;
  const tapOutput = `${expectedFailureBlock}${loadTimeCrashBlock}not ok 3 - the failing case\n  ---\n  error: 'failed check evidence'\n  ...\n${'ok 4 - filler\n'.repeat(2000)}# fail 2\n`;
  await writeFile(path.join(fixture.workspace.cwd, 'src/retry.ts'), `process.stdout.write(${JSON.stringify(tapOutput)}); process.exitCode = 1;\n`);
  await fixture.git(['add', '.'], fixture.workspace.cwd);
  await fixture.git(['commit', '-m', 'test: fail check'], fixture.workspace.cwd);
  fixture.config.factory = { enabled: true, checks: [`${process.execPath} src/retry.ts`] };
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.match(fixture.feedback[0], /Cannot find module 'missing.ts'\n# Subtest: tests\/broken.test.ts\nnot ok 2 - tests\/broken.test.ts/);
  assert.match(fixture.feedback[0], /not ok 3 - the failing case\n {2}---\n {2}error: 'failed check evidence'/);
  assert.match(fixture.feedback[0], /# fail 2/);
  assert.doesNotMatch(fixture.feedback[0], /expected failure evidence/);
  assert.match(fixture.decisionReasons[0] ?? '', /failed check evidence/);
  assert.equal(fixture.reviewRequests.length, 0);
});

async function writeBaseRedLintCheck(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  const lintScriptPath = path.join(fixture.directory, 'base-red-lint.mjs');
  await writeFile(lintScriptPath, [
    "import { existsSync, readFileSync } from 'node:fs';",
    "process.stdout.write('public/style.css:9193:149 lint/suspicious/noShorthandPropertyOverrides\\n');",
    "if (existsSync('src/retry.ts') && readFileSync('src/retry.ts', 'utf8').includes('worse')) process.stdout.write('src/retry.ts:1:1 lint/style/useConst\\n');",
    'process.exitCode = 1;',
  ].join('\n'));
  fixture.config.factory = { enabled: true, checks: [`${process.execPath} ${lintScriptPath}`] };
}

test('a check already failing the same way at the ticket base is not charged to the ticket, which merges with a note', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  await writeBaseRedLintCheck(fixture);
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(fixture.feedback.length, 0);
  assert.equal(fixture.reviewRequests.length, 1);
  assert.notEqual(fixture.mergedSha(), null);
  assert.match(fixture.decisionReasons.find((reason) => reason?.startsWith('Not charged')) ?? '', /^Not charged for checks already failing at base [0-9a-f]{12}: .*base-red-lint\.mjs$/);
});

test('a ticket that adds a failure to a check already failing at its base is still charged', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  await writeFile(path.join(fixture.workspace.cwd, 'src/retry.ts'), 'export const worse = true;\n');
  await fixture.git(['commit', '-am', 'fix: worse retries'], fixture.workspace.cwd);
  await writeBaseRedLintCheck(fixture);
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.match(fixture.feedback[0], /src\/retry.ts:1:1 lint\/style\/useConst/);
  assert.equal(fixture.reviewRequests.length, 0);
  assert.equal(fixture.mergedSha(), null);
});

test('a merge after a block clears that block exception, so a factory that recovered stops reporting it', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange('outside.ts');
  for (const _attempt of [1, 2, 3]) await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(fixture.exceptions.length, 1);
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'transition', fixture.worker.workId, 'active', '--because', 'Factory reopen', '--session', 'glimmervoid-factory'] });
  await fixture.git(['rm', '-q', 'outside.ts'], fixture.workspace.cwd);
  await fixture.commitChange();
  const reopenedWorker: FactoryCloseOutWorker = { ...fixture.worker, session: { ...fixture.worker.session, _destroyed: false, destroy: () => {} } };
  await fixture.closeOut.turnEnded(reopenedWorker);
  assert.notEqual(fixture.mergedSha(), null);
  assert.deepEqual(fixture.clearedExceptions, fixture.exceptions);
});

test('a check guardrails that cannot be prepared fails the attempt and never merges or runs a reviewer', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  fixture.setCheckRunner(async () => { throw new Error('check guardrails are unavailable'); });
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.match(fixture.feedback[0], /check guardrails are unavailable/);
  assert.equal(fixture.reviewRequests.length, 0);
  assert.equal(fixture.mergedSha(), null);
});

test('third factory failure blocks the ledger ticket and raises an exception', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange('outside.ts');
  for (const attempt of [1, 2, 3]) {
    await fixture.closeOut.turnEnded(fixture.worker);
    assert.equal(fixture.feedback.length, Math.min(attempt, 2));
  }
  assert.equal(await fixture.orderState(fixture.worker.workId), 'blocked');
  assert.match(fixture.exceptions[0], /outside.ts/);
  assert.equal(fixture.isDestroyed(), true);
  assert.equal(fixture.events.at(-1)?.event, 'blocked');
});

async function commitPassingPinnedTest(git: (args: string[], cwd?: string) => Promise<string>, cwd: string): Promise<string> {
  await mkdir(path.join(cwd, 'tests'), { recursive: true });
  await writeFile(path.join(cwd, 'tests/pinned.test.ts'), "import test from 'node:test';\ntest('pinned passes', () => {});\n");
  await git(['add', '--', 'tests/pinned.test.ts'], cwd);
  await git(['commit', '-m', 'test: track the pinned test'], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

test('a test failing outside the write scopes on two attempts in a row blocks the ticket as needing write scope, without using its third attempt', async (context) => {
  for (const scenario of ['widenable', 'intent', 'unmatched', 'protected']) {
    await context.test(scenario, async (context) => {
      const fixture = await createFixture(context);
      fixture.config.projects = [{ id: 'repo', name: 'Factory', path: fixture.projectPath, factoryProfile: {
        widenableScopes: scenario === 'unmatched' || scenario === 'intent' ? ['test/'] : ['tests/'],
        protectedPaths: scenario === 'protected' ? ['tests/'] : [],
      } }];
      if (scenario === 'intent') fixture.worker.intentWriteScopes = ['src', 'tests'];
      const trackedBaseSha = await commitPassingPinnedTest(fixture.git, fixture.workspace.cwd);
      fixture.worker.baseSha = trackedBaseSha;
      fixture.setWorkerBaseSha(trackedBaseSha);
      await fixture.commitChange();
      const pinnedTestTitle = 'pinned retry budget '.repeat(100);
      const writePinnedTest = [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('tests', { recursive: true });",
        `writeFileSync('tests/pinned.test.ts', ${JSON.stringify(`import test from 'node:test';\ntest(${JSON.stringify(pinnedTestTitle)}, () => { throw new Error(${JSON.stringify("pinned\nlocation: 'server/payload.test.d:1:1'")}); });\n`)});`,
        `writeFileSync('tests/own-reporter.test.ts', ${JSON.stringify("import test from 'node:test';\ntest('own reporter passes', () => {});\n")});`,
        `writeFileSync('tests/old-node.ts', ${JSON.stringify("if ((process.env.NODE_OPTIONS ?? '').includes('--test-reporter')) { process.stderr.write('node: --test-reporter= is not allowed in NODE_OPTIONS\\n'); process.exit(9); }\n")});`,
      ].join('\n');
      await writeFile(path.join(fixture.workspace.cwd, 'src/retry.ts'), `${writePinnedTest}\n`);
      await fixture.git(['add', '.'], fixture.workspace.cwd);
      await fixture.git(['commit', '-m', 'test: fail outside scope'], fixture.workspace.cwd);
      fixture.config.factory = { enabled: true, checks: [`${process.execPath} src/retry.ts`, `${process.execPath} --test tests/pinned.test.ts`, `${process.execPath} --test --test-reporter=spec tests/own-reporter.test.ts`, `${process.execPath} tests/old-node.ts`] };
      await fixture.closeOut.turnEnded(fixture.worker);
      assert.match(fixture.feedback[0], /outside this ticket's write scopes: tests\/pinned\.test\.ts\./);
      assert.match(fixture.feedback[0], /not ok 1 - pinned retry budget/);
      assert.doesNotMatch(fixture.feedback[0], /ERR_INVALID_ARG_VALUE|own-reporter|not allowed in NODE_OPTIONS/);
      assert.equal(await fixture.orderState(fixture.worker.workId), 'active');
      await fixture.closeOut.turnEnded(fixture.worker);
      assert.equal(fixture.feedback.length, 1);
      assert.equal(await fixture.orderState(fixture.worker.workId), 'blocked');
      assert.deepEqual(fixture.recordedScopeNeeds, scenario === 'widenable' ? [{ intentId: fixture.worker.intentId, files: ['tests/pinned.test.ts'] }] : []);
      if (scenario === 'widenable' || scenario === 'intent') assert.match(fixture.exceptions[0], /^Needs write scope: tests\/pinned\.test\.ts\./);
      if (scenario === 'unmatched' || scenario === 'protected') assert.match(fixture.exceptions[0], /^Parked .* after 3 blocks\. Leave it parked\. Need: Needs write scope: tests\/pinned\.test\.ts\./);
      assert.equal(fixture.events.at(-1)?.event, 'blocked');
    });
  }
});

test('a block whose landing fails still releases the worker and raises the exception, and the next landing carries the block', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange('outside.ts');
  fixture.setLandingFails(true);
  for (const _attempt of [1, 2, 3]) await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(fixture.isDestroyed(), true);
  assert.equal(fixture.events.at(-1)?.event, 'blocked');
  assert.equal(fixture.exceptions.length, 1);
  assert.match(fixture.exceptions[0], /outside.ts/);
  assert.equal(await fixture.orderState(fixture.worker.workId), 'active');
  fixture.setLandingFails(false);
  await fixture.land('repo', fixture.projectPath, 'factory: retry landing');
  assert.equal(await fixture.orderState(fixture.worker.workId), 'blocked');
});

test('a block on a ticket already blocked skips the transition and still releases the worker', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange('outside.ts');
  await fixture.closeOut.turnEnded(fixture.worker);
  await fixture.closeOut.turnEnded(fixture.worker);
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'transition', fixture.worker.workId, 'blocked', '--because', 'Blocked earlier', '--session', 'glimmervoid-factory'] });
  const transitionsBefore = fixture.commands.filter((command) => command[1] === 'transition').length;
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(fixture.commands.filter((command) => command[1] === 'transition').length, transitionsBefore);
  assert.equal(fixture.isDestroyed(), true);
  assert.equal(fixture.events.at(-1)?.event, 'blocked');
  assert.match(fixture.exceptions[0], /outside.ts/);
});

test('a block clears the attempt count so a reopened ticket starts over at its first attempt', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange('outside.ts');
  for (const _attempt of [1, 2, 3]) await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(await fixture.orderState(fixture.worker.workId), 'blocked');
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'transition', fixture.worker.workId, 'active', '--because', 'Factory reopen', '--session', 'glimmervoid-factory'] });
  const reopenedWorker: FactoryCloseOutWorker = { ...fixture.worker, session: { ...fixture.worker.session, _destroyed: false, destroy: () => {} } };
  const feedbackBefore = fixture.feedback.length;
  await fixture.closeOut.turnEnded(reopenedWorker);
  assert.equal(fixture.feedback.length, feedbackBefore + 1);
  assert.equal(fixture.events.at(-1)?.event, 'blocked');
  assert.equal(fixture.exceptions.length, 1);
});

test('a ticket blocked a third time stays parked with its need and the orchestrator is told to leave it parked', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange('outside.ts');
  const reopenedWorker: FactoryCloseOutWorker = { ...fixture.worker, session: { ...fixture.worker.session, _destroyed: false, destroy: () => {} } };
  for (const _attempt of [1, 2, 3]) await fixture.closeOut.turnEnded(fixture.worker);
  for (const _reopen of [1, 2]) {
    assert.equal(await fixture.orderState(fixture.worker.workId), 'blocked');
    await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'transition', fixture.worker.workId, 'active', '--because', 'Factory reopen', '--session', 'glimmervoid-factory'] });
    for (const _attempt of [1, 2, 3]) await fixture.closeOut.turnEnded(reopenedWorker);
  }
  assert.equal(await fixture.orderState(fixture.worker.workId), 'blocked');
  assert.equal(fixture.commands.some((command) => command[1] === 'close' && command[3] === 'cancelled'), false);
  assert.notEqual(await fixture.orderState(fixture.worker.intentId), 'cancelled');
  assert.equal(fixture.events.at(-1)?.event, 'blocked');
  const parkedOrder = (await fixture.inspect()).work.find((order) => order.work === fixture.worker.workId);
  assert.equal(parkedOrder?.last?.reason, fixture.events[0].detail);
  assert.match(fixture.events.at(-1)?.detail ?? '', /Parked .* after 3 blocks\. Leave it parked\. Need: .*outside\.ts/s);
  assert.equal(fixture.exceptions.length, 3);
  assert.doesNotMatch(fixture.exceptions[1], /cancelled/);
  assert.match(fixture.exceptions[2], /Parked .* after 3 blocks\..*Need: .*outside\.ts/s);
});

test('parking at the block cap leaves the intent partial instead of cancelling it', async (context) => {
  const fixture = await createFixture(context, true, { countTicketBlock: async () => 3 });
  await fixture.commitChange('outside.ts');
  for (const _attempt of [1, 2, 3]) await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(await fixture.orderState(fixture.worker.workId), 'blocked');
  assert.notEqual(await fixture.orderState(fixture.worker.intentId), 'cancelled');
  const project = buildFactoryProjectState({ projectId: 'repo', projectName: 'Factory', headSha: null,
    orient: await fixture.readOrient(), work: await fixture.inspect(), error: null, ticketBlockCounts: { [fixture.worker.workId]: 3 } });
  assert.deepEqual(project.partialIntentIds, [fixture.worker.intentId]);
  assert.match(fixture.exceptions.at(-1) ?? '', /Parked .* after 3 blocks/);
});

test('parking at the block cap preserves independent live descendants, merged tickets and waiting dependents', async (context) => {
  const fixture = await createFixture(context, true, { countTicketBlock: async () => 4 });
  const activate = (workId: string) => fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'transition', workId, 'active', '--because', 'Factory dispatch', '--session', 'glimmervoid-factory'] });
  const siblingId = await fixture.createOrder(fixture.worker.intentId, 'Ship backoff');
  await activate(siblingId);
  const grandchildId = await fixture.createOrder(siblingId, 'Ship backoff jitter');
  await activate(grandchildId);
  const mergedSiblingId = await fixture.createOrder(fixture.worker.intentId, 'Ship retry metrics');
  await activate(mergedSiblingId);
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'close', mergedSiblingId, 'completed', '--because', 'merged', '--evidence', 'tip', '--session', 'glimmervoid-factory'] });
  const dependent: { work: string } = JSON.parse(await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: [
    'work', 'create', 'Ship retry docs', '--success', 'Docs pass', '--risk', 'medium', '--authority', 'user-directed', '--granted-by', 'operator',
    '--boundary', 'This repo', '--session', 'glimmervoid-factory', '--write-scope', 'src/retry.ts', '--parent', fixture.worker.intentId, '--depends-on', fixture.worker.workId, '--json',
  ] }));
  await fixture.commitChange('outside.ts');
  for (const _attempt of [1, 2, 3]) await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(await fixture.orderState(fixture.worker.workId), 'blocked');
  for (const workId of [siblingId, grandchildId]) assert.equal(await fixture.orderState(workId), 'active', workId);
  for (const workId of [dependent.work, fixture.worker.intentId]) assert.equal(await fixture.orderState(workId), 'open', workId);
  assert.equal((await fixture.inspect()).work.find((order) => order.work === dependent.work)?.readiness, 'blocked');
  assert.equal(await fixture.orderState(mergedSiblingId), 'completed');
  assert.match(fixture.exceptions.at(-1) ?? '', /Parked .* after 4 blocks/);
});

test('independent reviewer failure retries with findings', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  fixture.setVerdict({ pass: false, findings: ['Retries do not meet the criterion'] });
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.match(fixture.feedback[0], /Retries do not meet the criterion/);
  assert.equal(fixture.isDestroyed(), false);
});

for (const verdict of [{ pass: 'yes', findings: [] }, null]) {
  test(`reviewer ${verdict === null ? 'missing' : 'invalid'} verdict file fails closed`, async (context) => {
    const fixture = await createFixture(context);
    await fixture.commitChange();
    if (verdict !== null) fixture.setVerdictFileOnly(verdict);
    if (verdict === null) fixture.setVerdict(null);
    await fixture.closeOut.turnEnded(fixture.worker);
    assert.match(fixture.feedback[0], /Reviewer returned no structured verdict/);
    assert.equal(fixture.trustedVerifications.length, 0);
  });
}

test('close-out stages the changes a worker left uncommitted through the check guardrails, then commits and lands them', async (context) => {
  const fixture = await createFixture(context);
  const guardedGitRuns: { argv: string[]; writablePaths: string[]; readablePaths: string[]; cwd: string }[] = [];
  fixture.setCheckRunner(async ({ writablePaths, readablePaths = [] }) => ({
    runCheck: (argv, options) => {
      if (argv[0] === 'git') guardedGitRuns.push({ argv, writablePaths, readablePaths, cwd: options.cwd });
      return execFileAsync(argv[0], argv.slice(1), options);
    },
    dispose: async () => {},
  }));
  await mkdir(path.join(fixture.workspace.cwd, 'src'), { recursive: true });
  await writeFile(path.join(fixture.workspace.cwd, 'src/retry.ts'), 'export const retries = 5;\n');
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.deepEqual(fixture.feedback, []);
  assert.deepEqual(fixture.exceptions, []);
  assert.equal(await fixture.orderState(fixture.worker.workId), 'completed');
  const mergedSha = fixture.mergedSha();
  assert.ok(mergedSha);
  assert.equal(await fixture.git(['show', `${mergedSha}:src/retry.ts`]), 'export const retries = 5;');
  assert.equal(await fixture.git(['log', '-1', '--format=%s', mergedSha, '--', 'src/retry.ts']), 'factory: Ship retries');
  assert.deepEqual(guardedGitRuns.map(({ argv }) => argv.includes('add')), [true]);
  assert.deepEqual(guardedGitRuns[0].writablePaths.map((writablePath) => path.basename(writablePath).replace(/-.*$/, '')), ['glimmervoid', 'objects']);
  assert.notEqual(guardedGitRuns[0].cwd, fixture.workspace.cwd);
  assert.deepEqual(guardedGitRuns[0].readablePaths, [fixture.workspace.cwd]);
});

test('a worker that changed nothing fails each attempt and parks on the third', async (context) => {
  const fixture = await createFixture(context);
  for (const attempt of [1, 2, 3]) {
    await fixture.closeOut.turnEnded(fixture.worker);
    assert.equal(fixture.feedback.length, Math.min(attempt, 2));
  }
  assert.match(fixture.feedback[0], /No change was found in the worktree/);
  assert.equal(await fixture.orderState(fixture.worker.workId), 'blocked');
  assert.match(fixture.exceptions.at(-1) ?? '', /^Parked .* Leave it parked\. Need: No change was found/);
  assert.equal(fixture.isDestroyed(), true);
  assert.equal(fixture.reviewRequests.length, 0);
});

test('close-out refuses to commit a nested repository or a shared host file and leaves the worker branch where it was, and commits an edit to a shared entry the repository tracks and a new file under one the project does not ignore, leaving an empty guardrails placeholder out', async (context) => {
  const leaveNestedRepository = async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
    const nestedRepositoryPath = path.join(fixture.workspace.cwd, 'vendored');
    await mkdir(nestedRepositoryPath);
    await initGitRepository(fixture.git, 'main', nestedRepositoryPath);
    await writeFile(path.join(nestedRepositoryPath, 'payload.txt'), 'nested\n');
    await fixture.git(['add', 'payload.txt'], nestedRepositoryPath);
    await fixture.git(['commit', '-m', 'test: nested commit'], nestedRepositoryPath);
  };
  const refusedLeftovers = [
    { feedbackPattern: /Nested git repositories cannot be committed\. Remove them.*: vendored/, leave: leaveNestedRepository },
    { feedbackPattern: /Nested git repositories cannot be committed\. Remove them.*: vendored/, leave: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      await leaveNestedRepository(fixture);
      await writeFile(path.join(fixture.workspace.cwd, '.gitmodules'), '[submodule "vendored"]\n\tpath = vendored\n\turl = ./vendored\n\tignore = all\n');
    } },
    { feedbackPattern: /Shared host files cannot be committed\. Restore the ignore rule.*: \.env/, leave: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      fixture.config.worktreeShare = ['node_modules', '.env'];
      await writeFile(path.join(fixture.projectPath, '.gitignore'), '.env\n');
      await writeFile(path.join(fixture.workspace.cwd, '.env'), 'OPERATOR_VALUE=from-the-host\n');
    } },
  ];
  for (const { feedbackPattern, leave } of refusedLeftovers) {
    const fixture = await createFixture(context);
    await writeFile(path.join(fixture.workspace.cwd, 'src/retry.ts'), 'export const retries = 5;\n');
    await leave(fixture);
    const workerHeadBefore = await fixture.git(['rev-parse', 'HEAD'], fixture.workspace.cwd);
    await fixture.closeOut.turnEnded(fixture.worker);
    assert.match(fixture.feedback[0], feedbackPattern);
    assert.equal(await fixture.git(['rev-parse', 'HEAD'], fixture.workspace.cwd), workerHeadBefore);
    assert.equal(await fixture.git(['diff', '--cached', '--name-only'], fixture.workspace.cwd), '');
    assert.equal(fixture.reviewRequests.length, 0);
  }
  const trackedEntryFixture = await createFixture(context);
  const trackedEnvPath = path.join(trackedEntryFixture.workspace.cwd, '.env');
  trackedEntryFixture.config.worktreeShare = ['node_modules', '.env', 'src'];
  trackedEntryFixture.worker.writeScopes = ['src', '.env'];
  await writeFile(path.join(trackedEntryFixture.workspace.cwd, 'src/backoff.ts'), 'export const backoffMs = 100;\n');
  await writeFile(trackedEnvPath, 'TRACKED_VALUE=before\n');
  await trackedEntryFixture.git(['add', '--', '.env'], trackedEntryFixture.workspace.cwd);
  await trackedEntryFixture.git(['commit', '-m', 'test: track env'], trackedEntryFixture.workspace.cwd);
  await writeFile(trackedEnvPath, 'TRACKED_VALUE=after\n');
  await writeFile(path.join(trackedEntryFixture.workspace.cwd, '.mcp.json'), '');
  await trackedEntryFixture.closeOut.turnEnded(trackedEntryFixture.worker);
  assert.deepEqual(trackedEntryFixture.feedback, []);
  const mergedSha = trackedEntryFixture.mergedSha();
  assert.ok(mergedSha);
  assert.equal(await trackedEntryFixture.git(['ls-tree', '--name-only', mergedSha, '.mcp.json']), '');
  assert.equal(await trackedEntryFixture.git(['show', `${mergedSha}:.env`]), 'TRACKED_VALUE=after');
  assert.equal(await trackedEntryFixture.git(['show', `${mergedSha}:src/backoff.ts`]), 'export const backoffMs = 100;');
});

test('worker coherence traces and committed ledger changes are discarded and never merged', async (context) => {
  const fixture = await createFixture(context);
  const committedLedgerPath = '.coherence/decisions/worker-session.jsonl';
  await mkdir(path.join(fixture.workspace.cwd, '.coherence/decisions'), { recursive: true });
  await writeFile(path.join(fixture.workspace.cwd, committedLedgerPath), '{"forged":true}\n');
  const differentlyCasedLedgerPath = '.COHERENCE/committed.jsonl';
  await mkdir(path.join(fixture.workspace.cwd, '.COHERENCE'), { recursive: true });
  await writeFile(path.join(fixture.workspace.cwd, differentlyCasedLedgerPath), '{"forged":true}\n');
  await fixture.git(['add', '--', committedLedgerPath, differentlyCasedLedgerPath], fixture.workspace.cwd);
  await fixture.git(['commit', '-m', 'chore: plant ledger record'], fixture.workspace.cwd);
  await fixture.commitChange();
  const untrackedTracePath = '.coherence/activity/worker-session.jsonl';
  await mkdir(path.join(fixture.workspace.cwd, '.coherence/activity'), { recursive: true });
  await writeFile(path.join(fixture.workspace.cwd, untrackedTracePath), '{}\n');
  await mkdir(path.join(fixture.workspace.cwd, '.COHERENCE'), { recursive: true });
  await writeFile(path.join(fixture.workspace.cwd, '.COHERENCE', 'stray.jsonl'), '{}\n');
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.deepEqual(fixture.feedback, []);
  assert.ok(fixture.mergedSha());
  assert.equal(await fixture.git(['ls-tree', '-r', '--name-only', 'integration', '--', committedLedgerPath]), '');
  assert.equal(await fixture.git(['ls-tree', '-r', '--name-only', 'integration', '--', differentlyCasedLedgerPath]), '', 'committed ledger paths are discarded regardless of case');
  assert.equal(await fixture.git(['diff', '--name-only', `${fixture.worker.baseSha}`, 'integration', '--', '.coherence/decisions']), '');
});

test('a coherence trace the hook writes after the worker commit does not block close-out or the pre-merge recheck', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  const lateTracePath = path.join(fixture.workspace.cwd, '.coherence', 'activity', 'x.jsonl');
  fixture.setReviewBarrier(async () => {
    await mkdir(path.dirname(lateTracePath), { recursive: true });
    await writeFile(lateTracePath, '{}\n');
  });
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.deepEqual(fixture.feedback, []);
  assert.deepEqual(fixture.exceptions, []);
  assert.ok(fixture.mergedSha());
  assert.equal(fixture.events.at(-1)?.event, 'merged');
  assert.equal(await fixture.git(['ls-tree', '-r', '--name-only', 'integration', '--', '.coherence/activity']), '');
});

test('a worker lands only its own valid Coherence journals with its change, kept out of the fence and the review, while foreign, forged and work ledger edits are discarded', async (context) => {
  const claudeSessionId = crypto.randomUUID();
  const ownDecisionsPath = `.coherence/decisions/${claudeSessionId}.jsonl`;
  const ownActivityPath = `.coherence/activity/${claudeSessionId}.jsonl`;
  const journalLine = (session: string, text: string) => `${JSON.stringify({ session, text })}\n`;
  type JournalFixture = Awaited<ReturnType<typeof createFixture>>;
  const recordDecision = (fixture: JournalFixture, session: string, choice: string) =>
    fixture.runCoherence({ cwd: fixture.workspace.cwd, args: ['decide', choice, '--because', 'measured', '--session', session] });
  const readOwnDecisions = (fixture: JournalFixture) => readFile(path.join(fixture.workspace.cwd, ownDecisionsPath), 'utf8');
  const closeOutWithJournals = async (writeJournals: (fixture: JournalFixture) => Promise<void>) => {
    const warnings: string[] = [];
    const fixture = await createFixture(context, true, { log: { warn: (message: string) => { warnings.push(message); } } });
    fixture.worker.claudeSessionId = claudeSessionId;
    const workLedgerPath = (await fixture.git(['ls-tree', '-r', '--name-only', 'HEAD', '--', '.coherence/work'], fixture.workspace.cwd)).split('\n')[0];
    assert.ok(workLedgerPath);
    await writeFile(path.join(fixture.workspace.cwd, workLedgerPath), `${await readFile(path.join(fixture.workspace.cwd, workLedgerPath), 'utf8')}{"forged":"work ledger edit"}\n`);
    await writeJournals(fixture);
    await fixture.git(['add', '--', workLedgerPath, ownDecisionsPath], fixture.workspace.cwd);
    await fixture.commitChange();
    await recordDecision(fixture, claudeSessionId, 'appended after commit');
    await fixture.closeOut.turnEnded(fixture.worker);
    assert.deepEqual(fixture.feedback, []);
    assert.deepEqual(fixture.exceptions, []);
    const mergedSha = fixture.mergedSha();
    assert.ok(mergedSha);
    assert.equal(await fixture.git(['show', `${mergedSha}:src/retry.ts`]), 'export const retries = 1;');
    assert.doesNotMatch(await fixture.git(['show', `integration:${workLedgerPath}`]), /work ledger edit/);
    assert.doesNotMatch(fixture.reviewRequests[0].prompt, /\.coherence\//);
    return { fixture, mergedSha, warnings, landedJournals: (await fixture.git(['ls-tree', '-r', '--name-only', mergedSha, '--', '.coherence/decisions', '.coherence/activity'])).split('\n').filter(Boolean) };
  };
  const writeOwnActivity = (fixture: JournalFixture) => writeJournalFile(fixture, ownActivityPath, journalLine(claudeSessionId, 'PostToolUse'));
  const foreignSessionId = crypto.randomUUID();
  const foreignDecisionsPath = `.coherence/decisions/${foreignSessionId}.jsonl`;
  let ownDecisionsAtCommit = '';
  const ownJournals = await closeOutWithJournals(async (fixture) => {
    await recordDecision(fixture, claudeSessionId, 'retry backoff decided');
    ownDecisionsAtCommit = await readOwnDecisions(fixture);
    await writeOwnActivity(fixture);
    await recordDecision(fixture, foreignSessionId, 'foreign session');
  });
  assert.deepEqual(ownJournals.landedJournals.toSorted(), [ownActivityPath, ownDecisionsPath].toSorted());
  const landedOwnDecisions = await ownJournals.fixture.git(['show', `${ownJournals.mergedSha}:${ownDecisionsPath}`]);
  assert.ok(landedOwnDecisions.startsWith(ownDecisionsAtCommit));
  assert.match(landedOwnDecisions, /appended after commit/);
  assert.equal(await ownJournals.fixture.git(['ls-tree', '--name-only', ownJournals.mergedSha, '--', foreignDecisionsPath]), '');
  assert.deepEqual(ownJournals.warnings, []);
  const forgedSession = await closeOutWithJournals(async (fixture) => {
    await writeJournalFile(fixture, ownDecisionsPath, journalLine(crypto.randomUUID(), 'claims another session'));
    await writeOwnActivity(fixture);
  });
  assert.deepEqual(forgedSession.landedJournals, [ownActivityPath]);
  assert.equal(forgedSession.warnings.length, 1);
  assert.ok(forgedSession.warnings[0].includes(ownDecisionsPath));
  const operatorDecisionsPath = '.coherence/decisions/operator-session.jsonl';
  const retractedBaseDecision = await closeOutWithJournals(async (fixture) => {
    await recordDecision(fixture, 'operator-session', 'operator keeps the queue');
    await fixture.git(['add', '--', operatorDecisionsPath], fixture.workspace.cwd);
    await fixture.git(['commit', '-m', 'test: operator decision at base'], fixture.workspace.cwd);
    fixture.setWorkerBaseSha(await fixture.git(['rev-parse', 'HEAD'], fixture.workspace.cwd));
    const operatorDecisionId: unknown = JSON.parse(await readFile(path.join(fixture.workspace.cwd, operatorDecisionsPath), 'utf8')).id;
    assert.equal(typeof operatorDecisionId, 'string');
    await fixture.runCoherence({ cwd: fixture.workspace.cwd, args: ['retract', String(operatorDecisionId), '--because', 'worker disagrees', '--session', claudeSessionId] });
    await writeOwnActivity(fixture);
  });
  assert.deepEqual(retractedBaseDecision.landedJournals.toSorted(), [operatorDecisionsPath, ownActivityPath].toSorted());
  assert.equal(retractedBaseDecision.warnings.length, 1);
  assert.ok(retractedBaseDecision.warnings[0].includes(ownDecisionsPath));
});

async function writeJournalFile(fixture: Awaited<ReturnType<typeof createFixture>>, journalPath: string, journalText: string) {
  await mkdir(path.dirname(path.join(fixture.workspace.cwd, journalPath)), { recursive: true });
  await writeFile(path.join(fixture.workspace.cwd, journalPath), journalText);
}

async function ignoreInCommonGitDirectory(fixture: Awaited<ReturnType<typeof createFixture>>, patterns: string[]) {
  const commonDirectory = path.resolve(fixture.projectPath, await fixture.git(['rev-parse', '--git-common-dir']));
  await mkdir(path.join(commonDirectory, 'info'), { recursive: true });
  await writeFile(path.join(commonDirectory, 'info', 'exclude'), `${patterns.join('\n')}\n`);
}

async function commitCheckScript(fixture: Awaited<ReturnType<typeof createFixture>>, scriptLines: string[]) {
  await writeFile(path.join(fixture.workspace.cwd, 'src/retry.ts'), `${scriptLines.join('\n')}\n`);
  await fixture.git(['add', 'src/retry.ts'], fixture.workspace.cwd);
  await fixture.git(['commit', '-m', 'test: check script'], fixture.workspace.cwd);
  fixture.config.factory = { enabled: true, checks: [`${process.execPath} src/retry.ts`] };
}

async function registeredWorktreeLines(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const worktreeListing = await fixture.git(['worktree', 'list', '--porcelain']);
  return worktreeListing.split(/\r?\n/).filter((listingLine) => listingLine.startsWith('worktree '));
}

test('a check that writes ignored output still lets the next attempt reach the checks and review, and never touches the worker tree', async (context) => {
  const fixture = await createFixture(context);
  await ignoreInCommonGitDirectory(fixture, ['dist/', '*.tsbuildinfo']);
  await commitCheckScript(fixture, [
    "const fs = process.getBuiltinModule('node:fs');",
    "fs.mkdirSync('dist', { recursive: true });",
    "fs.writeFileSync('dist/out.js', 'built');",
    "fs.writeFileSync('tsconfig.tsbuildinfo', '{}');",
  ]);
  const worktreeLinesBeforeCloseOut = await registeredWorktreeLines(fixture);
  fixture.setVerdict({ pass: false, findings: ['Not yet'] });
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(fixture.reviewRequests.length, 1);
  assert.match(fixture.feedback[0], /Not yet/);
  assert.equal(await readdir(fixture.workspace.cwd).then((entries) => entries.includes('dist') || entries.includes('tsconfig.tsbuildinfo')), false);
  fixture.setVerdict({ pass: true, findings: [] });
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(fixture.reviewRequests.length, 2);
  assert.equal(fixture.feedback.length, 1);
  assert.ok(fixture.mergedSha());
  const worktreeLinesAfterCloseOut = await registeredWorktreeLines(fixture);
  assert.deepEqual(worktreeLinesAfterCloseOut.filter((worktreeLine) => !worktreeLinesBeforeCloseOut.includes(worktreeLine)), []);
});

test('a planted gitignored stub in the worker tree never reaches the checks', async (context) => {
  const fixture = await createFixture(context);
  await ignoreInCommonGitDirectory(fixture, ['build/']);
  await commitCheckScript(fixture, [
    "const fs = process.getBuiltinModule('node:fs');",
    "if (fs.existsSync('build/stub.js')) { console.log('planted stub used'); process.exitCode = 1; }",
  ]);
  await mkdir(path.join(fixture.workspace.cwd, 'build'), { recursive: true });
  await writeFile(path.join(fixture.workspace.cwd, 'build/stub.js'), 'module.exports = true;\n');
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.deepEqual(fixture.feedback, []);
  assert.equal(fixture.reviewRequests.length, 1);
  assert.ok(fixture.mergedSha());
});

test('a diff larger than the review cap fails the attempt without running the reviewer', async (context) => {
  const fixture = await createFixture(context);
  await writeFile(path.join(fixture.workspace.cwd, 'src/retry.ts'), `export const retries = '${'x'.repeat(FACTORY_REVIEW_DIFF_MAX_CHARS)}';\n`);
  await fixture.git(['add', 'src/retry.ts'], fixture.workspace.cwd);
  await fixture.git(['commit', '-m', 'feat: huge change'], fixture.workspace.cwd);
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.match(fixture.feedback[0], /change too large for review; split it into smaller tickets/);
  assert.equal(fixture.reviewRequests.length, 0);
  assert.equal(fixture.mergedSha(), null);
});

test('checks run without glimmervoid secrets and secret-bearing output lines never reach the worker', async (context) => {
  const fixture = await createFixture(context);
  fixture.baseEnv.GLIMMERVOID_POSTHOG_API_KEY = 'phc_factory_secret_value';
  fixture.baseEnv.GLIMMERVOID_TELEGRAM_BOT_TOKEN = '123:telegram-secret';
  fixture.baseEnv.GH_TOKEN = 'ghp_inherited_secret';
  fixture.baseEnv.AWS_SECRET_ACCESS_KEY = 'aws-inherited-secret';
  fixture.baseEnv.NPM_TOKEN = 'npm-inherited-secret';
  await fixture.commitChange();
  await writeFile(path.join(fixture.workspace.cwd, 'src/retry.ts'), [
    'console.log("posthog=" + (process.env.GLIMMERVOID_POSTHOG_API_KEY ?? "scrubbed"));',
    'console.log("telegram=" + (process.env.GLIMMERVOID_TELEGRAM_BOT_TOKEN ?? "scrubbed"));',
    'console.log("leaked phc_factory_secret_value from a planted read");',
    'console.log("gh=" + (process.env.GH_TOKEN ?? "scrubbed") + " aws=" + (process.env.AWS_SECRET_ACCESS_KEY ?? "scrubbed") + " npm=" + (process.env.NPM_TOKEN ?? "scrubbed") + " ci=" + process.env.CI);',
    'console.log("leaked ghp_inherited_secret from a planted read");',
    'process.exitCode = 1;',
  ].join('\n'));
  await fixture.git(['add', '.'], fixture.workspace.cwd);
  await fixture.git(['commit', '-m', 'test: print env'], fixture.workspace.cwd);
  fixture.config.factory = { enabled: true, checks: [`${process.execPath} src/retry.ts`] };
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.match(fixture.feedback[0], /posthog=scrubbed/);
  assert.match(fixture.feedback[0], /telegram=scrubbed/);
  assert.equal(fixture.feedback[0].includes('phc_factory_secret_value'), false);
  assert.equal(fixture.feedback[0].includes('leaked'), false);
  assert.match(fixture.feedback[0], /gh=scrubbed aws=scrubbed npm=scrubbed ci=1/);
  assert.equal(fixture.feedback[0].includes('ghp_inherited_secret'), false);
});

test('pause holds close-out without merging or counting an attempt and resume retries it', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  fixture.setPaused(true);
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(fixture.reviewRequests.length, 0);
  assert.equal(fixture.mergedSha(), null);
  assert.deepEqual(fixture.feedback, []);
  fixture.setPaused(false);
  await Promise.all(fixture.closeOut.resumeHeld('repo'));
  assert.ok(fixture.mergedSha());
  assert.equal(fixture.reviewRequests.length, 1);
  assert.deepEqual(fixture.closeOut.resumeHeld('repo'), []);
});

test('a pause that lands during review holds the merge, refunds the attempt, and merges after resume', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  fixture.setReviewBarrier(async () => { fixture.setPaused(true); });
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(fixture.mergedSha(), null);
  assert.deepEqual(fixture.feedback, []);
  assert.equal(fixture.isDestroyed(), false);
  fixture.setReviewBarrier(async () => {});
  fixture.setPaused(false);
  fixture.setVerdict({ pass: false, findings: ['first counted failure'] });
  await Promise.all(fixture.closeOut.resumeHeld('repo'));
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(fixture.feedback.length, 2);
  assert.equal(await fixture.orderState(fixture.worker.workId), 'active');
});

test('parked merge is a failed attempt with the merge reason', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  fixture.setMergeReason('rebase-conflict');
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.match(fixture.feedback[0], /rebase-conflict/);
  assert.equal(fixture.trustedVerifications.length, 0);
});

test('overlapping turn ends are ignored while Review is active', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  let finishReview: (() => void) | undefined;
  let reviewStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { reviewStarted = resolve; });
  const barrier = new Promise<void>((resolve) => { finishReview = resolve; });
  fixture.setReviewBarrier(async () => { reviewStarted?.(); await barrier; });
  const closing = fixture.closeOut.turnEnded(fixture.worker);
  await started;
  assert.ok(fixture.closeOut.reviewing.has(fixture.worker.workId));
  await fixture.closeOut.turnEnded(fixture.worker);
  finishReview?.();
  await closing;
  assert.equal(fixture.reviewRequests.length, 1);
});

test('disabled factory runs no close-out', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  fixture.config.factory = { enabled: false };
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(fixture.reviewRequests.length, 0);
  assert.equal(fixture.feedback.length, 0);
  assert.equal(fixture.trustedVerifications.length, 0);
});


async function startFactoryWiring(fixture: Awaited<ReturnType<typeof createFixture>>, spawnReviewer: LaneSpawn) {
  const notifications: { category: string; message: string }[] = [];
  const config: GlimmervoidConfig = {
    projects: [{ id: 'repo', name: 'Factory', path: fixture.projectPath, factoryProfile: {} }], integrationBranch: 'integration',
    factory: { enabled: true, checks: [`${process.execPath} --version`], reviewerModel: null },
    worktreeRoot: path.join(fixture.directory, 'workers'), worktreeShare: [], recordSignals: false, liveWorktreeReview: false,
    agentApi: { enabled: false },
  };
  const sessions = new Map<string, Session>();
  const makeSession = createSessionFactory({ configStore: { configPath: path.join(fixture.directory, 'config.json') },
    hookRouter: new HookRouter(), getHookPort: () => 12345, getGitWorkspace: () => fixture.gitWorkspace, getPlanReviewPort: () => null,
    resolveHookTools: () => [], getUserHooks: () => [] });
  const homeDir = path.join(fixture.directory, 'factory-home');
  const statePath = path.join(homeDir, 'factory', 'repo', 'state.json');
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ ledgerPath: fixture.ledger.cwd, ledgerBranch: fixture.ledger.branch, paused: false, trustedIntentIds: [fixture.worker.intentId] }));
  const wiring = createFactoryWiring({
    config, homeDir, readSpentTodayUsd: () => ({ status: 'known', amountUsd: 1 }), prepareCheckRunner: prepareUnguardedCheckRunner,
    notify: (_projectName, category, message) => { notifications.push({ category, message }); }, gitWorkspace: fixture.gitWorkspace, firstTickDelayMs: () => 0, broadcast: () => {},
    orchestratorOptions: {
      workLane: passthroughWorkLane(),
      config, sessions, closeSessionDataClients: () => {}, wireSessionEvents: () => {}, broadcast: () => {}, recordLane: () => {},
      spawnGate: { run: async (operation) => operation() },
      makeSession: (project, currentConfig, overrides) => {
        const session = makeSession(project, currentConfig, overrides);
        session._spawnCommand = { path: process.execPath, kind: 'exe' };
        session._ptySpawn = () => fakePty();
        return session;
      },
    },
    spawnReviewer,
  });
  fixture.cleanupTasks.push(() => wiring.stop());
  wiring.start();
  await waitFor(() => wiring.getState() != null, 'factory reads the project ledger', 30_000);
  assert.equal(wiring.getState()?.projects[0]?.error, null, JSON.stringify(wiring.getState()));
  assert.notEqual(wiring.getState()?.projects[0]?.heading.action, 'refuse', JSON.stringify(wiring.getState()));
  assert.equal(wiring.getState()?.projects[0]?.orders.find((order) => order.parent === null)?.readiness, 'ready', JSON.stringify(wiring.getState()));
  await waitFor(() => wiring.getState()?.projects[0]?.orchestrator != null, `factory starts the orchestrator: ${JSON.stringify(wiring.getState())}`, 30_000);
  return { wiring, config, sessions, statePath, notifications };
}

test('wired close-out remembers scope needs after cancellation and admits a replacement outside the intent bound', async (context) => {
  const fixture = await createFixture(context, false);
  await commitPassingPinnedTest(fixture.git, fixture.projectPath);
  await fixture.git(['push', 'origin', 'integration'], fixture.projectPath);
  const { wiring, config, sessions, statePath } = await startFactoryWiring(fixture, async () => {});
  config.factory = { ...config.factory, protectedPaths: ['tests/'],
    checks: [`${process.execPath} src/retry.ts`, `${process.execPath} --test tests/pinned.test.ts`] };
  config.projects[0].factoryProfile = { widenableScopes: ['tests/'], protectedPaths: [] };
  const reply = await wiring.dispatch('factory-orch-repo', { workId: fixture.worker.workId });
  if (!reply.ok) throw new Error(reply.reason);
  const worker = sessions.get(reply.sessionId);
  assert.ok(worker?.worktreeDir);
  await writeFile(path.join(worker.worktreeDir, 'src/retry.ts'), [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "mkdirSync('tests', { recursive: true });",
    `writeFileSync('tests/pinned.test.ts', ${JSON.stringify("import test from 'node:test';\ntest('pinned failure', () => { throw new Error('pinned'); });\n")});`,
  ].join('\n'));
  for (const attempt of [1, 2]) {
    worker.emit('hook-event', { event: 'stop', payload: {} });
    await waitFor(() => wiring.getState()?.projects[0]?.reviewing?.includes(fixture.worker.workId) === true, `close-out starts attempt ${attempt}`, 30_000);
    await waitFor(() => wiring.getState()?.projects[0]?.reviewing?.includes(fixture.worker.workId) === false, `close-out finishes attempt ${attempt}`, 30_000);
  }
  assert.equal(worker._destroyed, true);
  const blockedState = FactoryLaneState.parse(JSON.parse(await readFile(statePath, 'utf8')));
  assert.deepEqual(blockedState.intentScopeNeeds, { [fixture.worker.intentId]: ['tests/pinned.test.ts'] });
  assert.equal(blockedState.ticketBlockCounts?.[fixture.worker.workId], 1);
  assert.deepEqual(await wiring.cancel('factory-orch-repo', { workId: fixture.worker.workId }), { ok: true, workId: fixture.worker.workId, state: 'cancelled' });
  const cancelledState = FactoryLaneState.parse(JSON.parse(await readFile(statePath, 'utf8')));
  assert.deepEqual(cancelledState.intentScopeNeeds, blockedState.intentScopeNeeds);
  const replacement: { work: string } = JSON.parse(await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: [
    'work', 'create', 'Repair the pinned test', '--success', 'Retries pass', '--risk', 'medium', '--authority', 'orchestrator-delegated',
    '--granted-by', 'glimmervoid-factory', '--boundary', 'This repo', '--session', 'repair-orchestrator', '--parent', fixture.worker.intentId,
    '--write-scope', 'src/retry.ts', '--write-scope', 'tests/pinned.test.ts', '--json',
  ] }));
  const replacementReply = await wiring.dispatch('factory-orch-repo', { workId: replacement.work });
  assert.equal(replacementReply.ok, true, replacementReply.ok ? '' : replacementReply.reason);
  assert.equal(await fixture.orderState(replacement.work), 'active');
});

test('factory wiring observes worker Stop, records confirmed flakes, exposes Review and notifies once after verified completion', async (context) => {
  const fixture = await createFixture(context, false);
  const workId = fixture.worker.workId;
  let finishReview: (() => void) | undefined;
  const reviewBarrier = new Promise<void>((resolve) => { finishReview = resolve; });
  fixture.cleanupTasks.push(async () => { finishReview?.(); });
  const { wiring, config, sessions, statePath, notifications } = await startFactoryWiring(fixture, async (request) => {
    await reviewBarrier;
    request.onOutput?.(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { pass: true, findings: [] } }));
  });
  const flakeCommand = `${process.execPath} src/retry.ts`;
  if (!config.factory) throw new Error('Factory config is missing');
  config.factory.checks = [flakeCommand];
  const reply = await wiring.dispatch('factory-orch-repo', { workId });
  if (!reply.ok) throw new Error(reply.reason);
  const worker = sessions.get(reply.sessionId);
  assert.ok(worker?.worktreeDir);
  await writeFile(path.join(worker.worktreeDir, 'src/retry.ts'), [
    "import { access, writeFile } from 'node:fs/promises';",
    'export const retries = 2;',
    "try { await access('.flake-seen'); } catch { await writeFile('.flake-seen', 'seen'); throw new Error('first run failed'); }",
  ].join('\n'));
  await fixture.git(['add', 'src/retry.ts'], worker.worktreeDir);
  await fixture.git(['commit', '-m', 'fix: wired retries'], worker.worktreeDir);
  worker.emit('hook-event', { event: 'stop', payload: {} });
  await waitFor(() => wiring.getState()?.projects[0]?.reviewing?.includes(workId) === true, 'factory exposes Review during close-out', 30_000);
  finishReview?.();
  await waitFor(() => worker._destroyed && wiring.getState()?.projects[0]?.reviewing?.includes(workId) === false, 'factory completes close-out and destroys the worker', 30_000);
  const state = FactoryLaneState.parse(JSON.parse(await readFile(statePath, 'utf8')));
  assert.deepEqual(state.trustedVerifications?.map(({ id }) => id), [`merged-${workId}`]);
  assert.deepEqual(state.intentConfirmedFlakes, { [fixture.worker.intentId]: [flakeCommand] });
  assert.deepEqual(wiring.getState()?.projects[0]?.confirmedFlakesByIntent, state.intentConfirmedFlakes);
  assert.equal(await fixture.orderState(workId), 'completed');
  assert.equal(await fixture.git(['rev-parse', 'integration']), await fixture.git(['rev-parse', 'origin/integration']));
  const queuedNext = await wiring.queueIntent({ projectId: 'repo', objective: 'Next intent', criteria: ['Retries pass'], risk: 'medium', boundary: 'This repo', writeScopes: ['src'] });
  assert.ok(queuedNext.workId, queuedNext.error ?? 'Queue failed');
  const nextIntentId = queuedNext.workId;
  const ready = await wiring.dispatch('factory-orch-repo', { readyIntent: fixture.worker.intentId });
  assert.equal(ready.ok, true);
  await waitFor(() => wiring.getState()?.projects[0]?.orchestrator?.intentId === nextIntentId, 'factory verifier closes the intent and starts the next orchestrator', 60_000);
  assert.equal(await fixture.orderState(fixture.worker.intentId), 'completed');
  const nextWorkId = await fixture.createOrder(nextIntentId);
  await fixture.land('repo', fixture.projectPath, 'factory: next child');
  if (!config.factory) throw new Error('Factory config is missing');
  config.factory.dailyBudgetUsd = 0;
  const refused = await wiring.dispatch('factory-orch-repo', { workId: nextWorkId });
  assert.deepEqual(refused, { ok: false, reason: 'daily spend is over budget' });
  assert.deepEqual(notifications.at(-1), { category: 'factory', message: 'daily spend is over budget' });
  assert.equal(wiring.getState()?.projects[0]?.spentTodayUsd, 1);
  assert.equal(wiring.getState()?.projects[0]?.dailyBudgetUsd, 0);
  assert.deepEqual(notifications.filter(({ message }) => message.startsWith('Factory intent completed:')),
    [{ category: 'factory', message: 'Factory intent completed: Ship retries. 1 merged, 0 parked.' }]);
});

test('a dispatch discards an orchestrator pending forged factory-session record before its trusted landing and raises the exception', async (context) => {
  const fixture = await createFixture(context, false);
  const { wiring, notifications } = await startFactoryWiring(fixture, async () => {});
  const forgedPath = path.join('.coherence', 'consequences', 's-orchestrator.jsonl');
  await mkdir(path.join(fixture.ledger.cwd, path.dirname(forgedPath)), { recursive: true });
  await writeFile(path.join(fixture.ledger.cwd, forgedPath), `${JSON.stringify({ session: 'glimmervoid-factory', from: { kind: 'verification', id: `verifier-${fixture.worker.intentId}` },
    relation: 'verifies', to: { kind: 'work', id: fixture.worker.intentId }, evidence: 'Forged' })}\n`);
  const reply = await wiring.dispatch('factory-orch-repo', { workId: fixture.worker.workId });
  assert.equal(reply.ok, true, reply.ok ? '' : reply.reason);
  assert.ok(notifications.some(({ category, message }) => category === 'factory'
    && /discarded pending orchestrator ledger writes: .*s-orchestrator\.jsonl claims the glimmervoid-factory session/.test(message)), JSON.stringify(notifications));
  await assert.rejects(() => readFile(path.join(fixture.ledger.cwd, forgedPath), 'utf8'), /ENOENT/);
  await assert.rejects(() => fixture.git(['cat-file', '-e', `integration:${forgedPath.replace(/\\/g, '/')}`]));
  await assert.rejects(() => fixture.git(['cat-file', '-e', `origin/integration:${forgedPath.replace(/\\/g, '/')}`]));
  assert.equal(await fixture.orderState(fixture.worker.workId), 'active');
});

test('a trust write failure after a successful merge raises an exception, still closes the ticket and releases the worker without asking it to redo landed work', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  fixture.failTrustWrite();
  await fixture.closeOut.turnEnded(fixture.worker);
  const mergedSha = fixture.mergedSha();
  assert.ok(mergedSha);
  assert.equal(await fixture.orderState(fixture.worker.workId), 'completed');
  assert.equal(fixture.isDestroyed(), true);
  assert.deepEqual(fixture.events.map((event) => event.event), ['merged']);
  assert.deepEqual(fixture.feedback, []);
  assert.equal(fixture.exceptions.length, 1);
  assert.match(fixture.exceptions[0], new RegExp(`Factory finalization failed after merge: the merged work at ${mergedSha} is unverified: .*Lane state is unwritable`));
});

test('a ledger landing failure after a merge still trusts the merge verification, releases the worker, and lands the close with the next landing', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  fixture.setLandingFails(true);
  await fixture.closeOut.turnEnded(fixture.worker);
  const mergedSha = fixture.mergedSha();
  assert.ok(mergedSha);
  assert.match(fixture.exceptions[0], /Factory finalization failed after merge:.*Ledger push is unavailable/);
  assert.deepEqual(fixture.trustedVerifications.map(({ id, sha }) => [id, sha]), [[`merged-${fixture.worker.workId}`, mergedSha]]);
  assert.equal(fixture.isDestroyed(), true);
  assert.deepEqual(fixture.events.map((event) => event.event), ['merged']);
  assert.equal(await fixture.orderState(fixture.worker.workId), 'active');
  const forgedPath = path.join(fixture.ledger.cwd, '.coherence', 'consequences', 's-orchestrator.jsonl');
  await mkdir(path.dirname(forgedPath), { recursive: true });
  await writeFile(forgedPath, `${JSON.stringify({ session: 'glimmervoid-factory', relation: 'verifies', evidence: 'Forged' })}\n`);
  const refusals: string[] = [];
  await screenPendingLedgerWrites({ cwd: fixture.ledger.cwd, intentId: fixture.worker.intentId, declaredFactoryRecords: fixture.declaredFactoryRecords,
    onRefused: (reason) => { refusals.push(reason); } });
  assert.equal(refusals.length, 1);
  await assert.rejects(() => readFile(forgedPath, 'utf8'), /ENOENT/);
  fixture.setLandingFails(false);
  await fixture.land('repo', fixture.projectPath, 'factory: land pending writes');
  assert.equal(await fixture.orderState(fixture.worker.workId), 'completed');
});

test('a duplicated or forged-content record under a declared factory record id is refused by the landing and the screen, which restores the declared record', async (context) => {
  const fixture = await createFixture(context);
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'transition', fixture.worker.workId, 'open', '--because', 'Factory reopen', '--session', 'glimmervoid-factory'] });
  const declared = fixture.declaredFactoryRecords.at(-1);
  assert.ok(declared);
  const declaredPath = path.join(fixture.ledger.cwd, declared.path);
  const pendingText = await readFile(declaredPath, 'utf8');
  const forgedLine = JSON.stringify({ ...JSON.parse(declared.line), because: 'Forged under the declared id' });
  for (const tamperedText of [`${pendingText}${declared.line}\n`, pendingText.replace(`${declared.line}\n`, `${forgedLine}\n`)]) {
    await writeFile(declaredPath, tamperedText);
    await assert.rejects(() => fixture.land('repo', fixture.projectPath, 'factory: tampered'), /claims the glimmervoid-factory session without a declared factory write/);
    const refusals: string[] = [];
    await screenPendingLedgerWrites({ cwd: fixture.ledger.cwd, intentId: fixture.worker.intentId, declaredFactoryRecords: fixture.declaredFactoryRecords,
      onRefused: (reason) => { refusals.push(reason); } });
    assert.equal(refusals.length, 1);
    assert.equal(await readFile(declaredPath, 'utf8'), pendingText);
  }
  await fixture.land('repo', fixture.projectPath, 'factory: reopen');
  assert.equal(await fixture.orderState(fixture.worker.workId), 'open');
});


test('staging the clean check checkout runs no post-checkout hook an earlier worker merged under the configured core.hooksPath', { skip: process.platform === 'win32' }, async (context) => {
  const fixture = await createFixture(context);
  fixture.setVerdict({ pass: false, findings: ['Hold the merge so only staging can run the hook'] });
  const markerPath = path.join(fixture.directory, 'post-checkout-ran');
  await writeFile(path.join(fixture.projectPath, 'src', 'post-checkout'), `#!/bin/sh\necho ran > '${markerPath}'\n`, { mode: 0o755 });
  await fixture.git(['add', 'src/post-checkout']);
  await fixture.git(['commit', '-m', 'feat: merged worker hook']);
  await fixture.git(['config', 'core.hooksPath', 'src']);
  await fixture.commitChange();
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(fixture.reviewRequests.length, 1);
  assert.equal(fixture.mergedSha(), null);
  await assert.rejects(() => readFile(markerPath, 'utf8'), /ENOENT/);
});

test('a staging failure reaches the worker with inherited secret lines redacted', async (context) => {
  const fixture = await createFixture(context);
  const secret = 'staging-secret-value-123';
  fixture.baseEnv.FACTORY_STAGING_TOKEN = secret;
  fixture.gitWorkspace.stageDetachedWorktree = async () => ({ ok: false, out: '', err: `fatal: could not read token ${secret}\nfatal: worktree add failed` });
  await fixture.commitChange();
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.equal(fixture.feedback.length, 1);
  assert.match(fixture.feedback[0], /Check failed: Close-out/);
  assert.match(fixture.feedback[0], /worktree add failed/);
  assert.equal(fixture.feedback[0].includes(secret), false);
  assert.equal(fixture.reviewRequests.length, 0);
});

test('a passing verdict file without independent reviewer output cannot authorize a merge', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  fixture.setVerdictFileOnly({ pass: true, findings: [] });
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.match(fixture.feedback[0], /Reviewer returned no structured verdict/);
  assert.equal(fixture.mergedSha(), null);
});

async function prepareMergedFixture(context: TestContext) {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  await fixture.closeOut.turnEnded(fixture.worker);
  const state: FactoryLaneState = { ledgerPath: fixture.ledger.cwd, ledgerBranch: fixture.ledger.branch ?? null, paused: false,
    trustedVerifications: fixture.trustedVerifications.map(({ id, sha }) => ({ id, sha })) };
  const factoryConfig: GlimmervoidConfig = { projects: [{ id: 'repo', name: 'Factory', path: fixture.projectPath }], factory: { enabled: true, verifierModel: 'sonnet' } };
  const readProject = async (): Promise<FactoryProjectState> => buildFactoryProjectState({ projectId: 'repo', projectName: 'Factory',
    headSha: await fixture.git(['rev-parse', 'integration']), orient: await fixture.readOrient(), work: await fixture.inspect(), error: null, paused: state.paused });
  return { ...fixture, state, factoryConfig, readProject };
}

async function addUnmergedCompletedChild(fixture: Awaited<ReturnType<typeof prepareMergedFixture>>): Promise<string> {
  const childId = await fixture.createOrder(fixture.worker.intentId, 'Ship follow-up retries');
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'close', childId, 'completed',
    '--because', 'Follow-up merged', '--session', 'glimmervoid-factory', '--evidence', fixture.mergedSha() ?? 'missing'] });
  await fixture.land('repo', fixture.projectPath, 'factory: follow-up merge');
  return childId;
}

async function assertVerifierIgnoresMergeLink(fixture: Awaited<ReturnType<typeof prepareMergedFixture>>) {
  const reviewRequests: string[] = [];
  const verifier = createFactoryVerifier({ config: fixture.factoryConfig, runCoherence: fixture.runCoherence, ensureLedger: async () => fixture.ledger,
    commitAndLand: fixture.land, hasCodeChangedSince: async (projectPath, sinceSha) => hasCodeChangedBetween({ projectPath, sinceSha, tipSha: await fixture.git(['rev-parse', 'integration']) }),
    readLaneState: async () => fixture.state, writeLaneState: async () => {},
    ensureControlCheckout: async () => fixture.directory, serializeProject: async <T>(_projectId: string, operation: () => Promise<T>) => operation(),
    pause: async () => {}, setException: () => {}, notifyOrchestrator: () => {}, stopOrchestrator: () => {}, onChanged: () => {},
    spawnVerifier: async (request) => { reviewRequests.push(request.id); } });
  fixture.cleanupTasks.push(() => verifier.stop());
  verifier.ready('repo', fixture.worker.intentId);
  const project = await verifier.tick(await fixture.readProject());
  assert.deepEqual(project.verifierIntentIds ?? [], []);
  assert.deepEqual(reviewRequests, []);
}

test('a merged ticket leaves the unverified list once its trusted merge verification lands', async (context) => {
  const fixture = await prepareMergedFixture(context);
  assert.deepEqual(fixture.state.trustedVerifications, [{ id: `merged-${fixture.worker.workId}`, sha: fixture.mergedSha() }]);
  assert.equal((await fixture.readProject()).unverifiedCompletedWork.includes(fixture.worker.workId), false);
});

async function prepareVerifierFixture(context: TestContext) {
  const fixture = await prepareMergedFixture(context);
  const reviewRequests: Parameters<LaneSpawn>[0][] = [];
  const verifierCwdEntries: string[][] = [];
  let verdict = { pass: true, findings: [] as string[] };
  let hasChanged = false;
  let verifierBarrier: (() => Promise<void>) | null = null;
  const stoppedOrchestrators: string[] = [];
  let shouldFailVerifierLanding = false;
  let shouldFailVerifierPush = false;
  const failingPushWorkspace = { ...fixture.gitWorkspace, mergeKeep: async (args: Parameters<typeof fixture.gitWorkspace.mergeKeep>[0]) =>
    ({ merged: false, committed: true, branch: args.workspace?.branch ?? null, reason: 'push rejected by origin' }) };
  const intentBaseSha = await fixture.git(['rev-list', '--max-parents=0', 'integration']);
  const verifier = createFactoryVerifier({ config: fixture.factoryConfig, runCoherence: fixture.runCoherence, ensureLedger: async () => fixture.ledger,
    readIntentDiff: async ({ projectPath, tipSha }) => ({ baseSha: intentBaseSha, diffText: await readCodeDiffBetween({ projectPath, sinceSha: intentBaseSha, tipSha }) }),
    commitAndLand: async (...args) => {
      if (shouldFailVerifierLanding) throw new Error('Verifier landing unavailable');
      if (!shouldFailVerifierPush) return fixture.land(...args);
      const [, projectPath, message, options] = args;
      await commitAndLandFactoryLedger({ projectPath, ledger: fixture.ledger, targetBranch: 'integration', message, gitWorkspace: failingPushWorkspace,
        declaredFactoryRecords: fixture.declaredFactoryRecords, onCommitted: options?.onCommitted });
    }, hasCodeChangedSince: async (projectPath, sinceSha) => hasCodeChangedBetween({ projectPath, sinceSha, tipSha: await fixture.git(['rev-parse', 'integration']) }),
    readLaneState: async () => fixture.state, writeLaneState: async (_projectId, updated) => { Object.assign(fixture.state, updated); },
    ensureControlCheckout: async ({ sha }) => {
      const checkout = await fixture.gitWorkspace.stageDetachedWorktree({ projectPath: fixture.projectPath, worktreePath: path.join(fixture.directory, 'verifier-control'), sha });
      assert.equal(checkout.ok, true);
      return path.join(fixture.directory, 'verifier-control');
    },
    serializeProject: async <T>(_projectId: string, operation: () => Promise<T>) => operation(),
    pause: async () => { fixture.state.paused = true; }, setException: (_projectId, reason) => { fixture.exceptions.push(reason); },
    notifyOrchestrator: (_projectId, event) => { fixture.events.push(event); }, stopOrchestrator: (projectId) => { stoppedOrchestrators.push(projectId); },
    onChanged: () => { hasChanged = true; }, spawnVerifier: async (request) => {
      const promptIndex = request.extraArgs?.indexOf('--append-system-prompt-file') ?? -1;
      const promptPath = request.extraArgs?.[promptIndex + 1];
      assert.ok(promptPath);
      reviewRequests.push({ ...request, prompt: await readFile(promptPath, 'utf8') });
      verifierCwdEntries.push(await readdir(request.cwd));
      await verifierBarrier?.();
      request.onOutput?.(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: verdict }));
    },
  });
  fixture.cleanupTasks.push(() => verifier.stop());
  return { ...fixture, verifier, intentBaseSha, failVerifierLanding: () => { shouldFailVerifierLanding = true; }, failVerifierPush: () => { shouldFailVerifierPush = true; }, setVerifierBarrier: (barrier: () => Promise<void>) => { verifierBarrier = barrier; }, reviewRequests, verifierCwdEntries, stoppedOrchestrators, hasChanged: () => hasChanged,
    setVerifierVerdict: (next: typeof verdict) => { verdict = next; } };
}

test('independent verifier pass files its link, closes the intent with tip evidence over a replaced ticket, and advances the queue', async (context) => {
  const fixture = await prepareVerifierFixture(context);
  const replacedTicketId = await fixture.createOrder(fixture.worker.intentId, 'Ticket the orchestrator replaced');
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'close', replacedTicketId, 'cancelled', '--because', 'Replaced by an in-scope ticket', '--session', 'glimmervoid-factory'] });
  const nextIntentId = await fixture.createOrder(null, 'Next intent');
  await fixture.land('repo', fixture.projectPath, 'factory: next intent');
  const project = await fixture.readProject();
  fixture.verifier.ready('repo', fixture.worker.intentId);
  await fixture.verifier.tick(project);
  await waitFor(fixture.hasChanged, 'independent verifier closes the intent', 60_000);
  assert.deepEqual(fixture.exceptions, []);
  const completed = await fixture.readProject();
  assert.equal(completed.orders.find((order) => order.id === fixture.worker.intentId)?.state, 'completed');
  assert.equal(completed.unverifiedCompletedWork.includes(fixture.worker.intentId), false);
  assert.equal(nextIntent(completed.orders, new Set([fixture.worker.intentId, nextIntentId]))?.id, nextIntentId);
  assert.deepEqual(fixture.stoppedOrchestrators, ['repo']);
  assert.deepEqual(fixture.state.trustedVerifications?.find(({ id }) => id === `verifier-${fixture.worker.intentId}`), { id: `verifier-${fixture.worker.intentId}`, sha: project.headSha });
  assert.deepEqual(fixture.state.trustedIntentCloses, [fixture.worker.intentId]);
  assert.equal(fixture.reviewRequests[0].model, 'sonnet');
  assert.notEqual(fixture.reviewRequests[0].cwd, path.join(fixture.directory, 'verifier-control'));
  assert.ok(fixture.reviewRequests[0].cwd.startsWith(realpathSync(hostScratchRoot())));
  assert.deepEqual(fixture.verifierCwdEntries, [[]]);
  const addDirIndex = fixture.reviewRequests[0].extraArgs?.indexOf('--add-dir') ?? -1;
  assert.equal(fixture.reviewRequests[0].extraArgs?.[addDirIndex + 1], path.join(fixture.directory, 'verifier-control'));
  assert.ok(fixture.reviewRequests[0].extraArgs?.[addDirIndex + 2]?.startsWith('--'), 'the variadic --add-dir must be bounded by an option or it swallows the prompt');
  assert.ok(fixture.reviewRequests[0].prompt.includes(project.headSha ?? 'missing'));
  assert.ok(fixture.reviewRequests[0].prompt.includes(`Diff ${fixture.intentBaseSha}..${project.headSha}`));
  assert.match(fixture.reviewRequests[0].prompt, /^diff --git a\//m);
  assert.doesNotMatch(fixture.reviewRequests[0].prompt, /^diff --git a\/\.coherence\//m);
  const closeCommand = fixture.commands.findLast((command) => command[1] === 'close');
  assert.equal(closeCommand?.[closeCommand.indexOf('--evidence') + 1], project.headSha);
  assert.equal(closeCommand?.includes(replacedTicketId), false);
  await fixture.verifier.tick(completed);
  assert.equal(fixture.reviewRequests.length, 1);
});

test('independent verifier failure records a bounded ledger defect, shows the findings on the floor, points the orchestrator at defects and leaves the intent open', async (context) => {
  const fixture = await prepareVerifierFixture(context);
  const intentId = fixture.worker.intentId;
  fixture.setVerifierVerdict({ pass: false, findings: ['Retries do not meet intent criteria', `Second\nfinding ${'y'.repeat(2000)}`] });
  fixture.verifier.ready('repo', intentId);
  await fixture.verifier.tick(await fixture.readProject());
  await waitFor(fixture.hasChanged, 'verifier reports its findings', 60_000);
  assert.deepEqual(fixture.events.at(-1), { workId: intentId, event: 'verification failed' });
  assert.equal(formatWorkerEvent(FactoryWorkerEvent.parse(fixture.events.at(-1))), `[factory] verification failed ${intentId}. Details: coherence defects --json`);
  const defects: { defects: { summary: string; evidence: string; session: string }[] } = JSON.parse(await fixture.runCoherence({ cwd: fixture.projectPath, args: ['defects', '--json'] }));
  const defect = defects.defects.find((candidate) => candidate.summary === `verifier rejected ${intentId}`);
  assert.ok(defect);
  assert.ok(defect.evidence.startsWith('Retries do not meet intent criteria; Second finding'));
  assert.equal(defect.evidence.includes('\n'), false);
  assert.ok(defect.evidence.length <= 3999);
  const project = await fixture.verifier.tick(await fixture.readProject());
  assert.match(project.note ?? '', new RegExp(`Verifier rejected ${intentId}: Retries do not meet intent criteria\nSecond\nfinding`));
  assert.equal(project.error, null);
  assert.equal(project.orders.find((order) => order.id === intentId)?.state, 'open');
  assert.equal(fixture.reviewRequests.length, 1);
});

test('intent closed without its independent verifier link pauses the factory even with another verification', async (context) => {
  const fixture = await prepareVerifierFixture(context);
  const intentId = fixture.worker.intentId;
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['consequence', 'add', 'verification:operator', 'verifies', `work:${intentId}`, '--evidence', 'Operator checked', '--session', 'glimmervoid-factory', '--json'] });
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'close', intentId, 'completed', '--because', 'Closed outside verifier', '--synthesized', fixture.worker.workId, '--evidence', 'tip', '--session', 'glimmervoid-factory'] });
  await fixture.land('repo', fixture.projectPath, 'factory: unexpected closure');
  const project = await fixture.verifier.tick(await fixture.readProject());
  assert.equal(fixture.state.paused, true);
  assert.equal(project.paused, true);
  assert.match(fixture.exceptions[0], /closed without its independent verifier link/);
  assert.equal(fixture.reviewRequests.length, 0);
  const inspectionCount = fixture.commands.filter((command) => command[0] === 'consequence' && command[1] === 'inspect').length;
  await fixture.verifier.tick(await fixture.readProject());
  assert.equal(fixture.commands.filter((command) => command[0] === 'consequence' && command[1] === 'inspect').length, inspectionCount);
  assert.equal(fixture.exceptions.length, 1);
});

test('a verifier whose ledger landing fails trusts its verification and close only once a later landing commits them', async (context) => {
  const fixture = await prepareVerifierFixture(context);
  const intentId = fixture.worker.intentId;
  fixture.failVerifierLanding();
  fixture.verifier.ready('repo', intentId);
  const project = await fixture.readProject();
  await fixture.verifier.tick(project);
  await waitFor(fixture.hasChanged, 'verifier finishes with a failed landing', 60_000);
  assert.match(fixture.exceptions.at(-1) ?? '', /Verifier landing unavailable/);
  assert.equal(fixture.state.trustedVerifications?.some(({ id }) => id === `verifier-${intentId}`), false);
  assert.deepEqual(fixture.state.trustedIntentCloses ?? [], []);
  assert.deepEqual(fixture.stoppedOrchestrators, []);
  await fixture.verifier.tick(await fixture.readProject());
  assert.deepEqual(fixture.state.trustedIntentCloses ?? [], []);
  const exceptionCount = fixture.exceptions.length;
  await fixture.land('repo', fixture.projectPath, 'factory: land unlanded writes repo');
  const closed = await fixture.readProject();
  assert.equal(closed.orders.find((order) => order.id === intentId)?.state, 'completed');
  const ticked = await fixture.verifier.tick(closed);
  assert.equal(ticked.paused, false);
  assert.equal(fixture.state.paused, false);
  assert.equal(fixture.exceptions.length, exceptionCount);
  assert.deepEqual(fixture.state.trustedVerifications?.find(({ id }) => id === `verifier-${intentId}`), { id: `verifier-${intentId}`, sha: project.headSha });
  assert.deepEqual(fixture.state.trustedIntentCloses, [intentId]);
  assert.deepEqual(fixture.state.pendingVerifierTrusts, []);
});

test('a verifier push failure after the local ledger commit still trusts its verification and close, so the next tick does not pause the project', async (context) => {
  const fixture = await prepareVerifierFixture(context);
  const intentId = fixture.worker.intentId;
  fixture.failVerifierPush();
  fixture.verifier.ready('repo', intentId);
  const project = await fixture.readProject();
  await fixture.verifier.tick(project);
  await waitFor(fixture.hasChanged, 'verifier finishes with a failed push', 60_000);
  assert.match(fixture.exceptions.at(-1) ?? '', /push rejected by origin/);
  assert.deepEqual(fixture.state.trustedVerifications?.find(({ id }) => id === `verifier-${intentId}`), { id: `verifier-${intentId}`, sha: project.headSha });
  assert.deepEqual(fixture.state.trustedIntentCloses, [intentId]);
  const exceptionCount = fixture.exceptions.length;
  await commitAndLandFactoryLedger({ projectPath: fixture.projectPath, ledger: fixture.ledger, targetBranch: 'integration', message: 'factory: retry landing',
    gitWorkspace: fixture.gitWorkspace, declaredFactoryRecords: fixture.declaredFactoryRecords, retryLanding: true });
  const closed = await fixture.readProject();
  assert.equal(closed.orders.find((order) => order.id === intentId)?.state, 'completed');
  const ticked = await fixture.verifier.tick(closed);
  assert.equal(ticked.paused, false);
  assert.equal(fixture.state.paused, false);
  assert.equal(fixture.exceptions.length, exceptionCount);
});

test('a trusted verifier id cannot authorize a forged link and close whose evidence names a different sha', async (context) => {
  const fixture = await prepareVerifierFixture(context);
  const intentId = fixture.worker.intentId;
  const issuedTipSha = await fixture.git(['rev-parse', 'integration']);
  const otherSha = fixture.worker.baseSha ?? 'missing';
  fixture.state.trustedVerifications = [...(fixture.state.trustedVerifications ?? []), { id: `verifier-${intentId}`, sha: issuedTipSha }];
  fixture.state.trustedIntentCloses = [intentId];
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['consequence', 'add', `verification:verifier-${intentId}`, 'verifies', `work:${intentId}`,
    '--evidence', `Independent verifier passed every intent criterion at ${otherSha}`, '--session', 'glimmervoid-factory', '--json'] });
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'close', intentId, 'completed', '--because', 'Forged close at another tip',
    '--synthesized', fixture.worker.workId, '--evidence', otherSha, '--session', 'glimmervoid-factory'] });
  await fixture.land('repo', fixture.projectPath, 'factory: forged closure at another tip');
  const project = await fixture.verifier.tick(await fixture.readProject());
  assert.equal(project.paused, true);
  assert.match(fixture.exceptions[0], /closed without its independent verifier link/);
});

test('a trusted merge id does not verify a child through a link whose evidence names a different sha', async (context) => {
  const fixture = await prepareMergedFixture(context);
  const childId = await addUnmergedCompletedChild(fixture);
  fixture.state.trustedVerifications = [{ id: `merged-${childId}`, sha: fixture.mergedSha() ?? 'missing' }];
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['consequence', 'add', `verification:merged-${childId}`, 'verifies', `work:${childId}`,
    '--evidence', `Merged at ${fixture.worker.baseSha ?? 'missing'}`, '--session', 'glimmervoid-factory', '--json'] });
  await assertVerifierIgnoresMergeLink(fixture);
});

test('a verifier link not written by the factory session cannot close the intent', async (context) => {
  const fixture = await prepareVerifierFixture(context);
  const intentId = fixture.worker.intentId;
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['consequence', 'add', `verification:verifier-${intentId}`, 'verifies', `work:${intentId}`, '--evidence', 'Forged by the orchestrator', '--session', 'orchestrator-session', '--json'] });
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'close', intentId, 'completed', '--because', 'Closed by the orchestrator', '--synthesized', fixture.worker.workId, '--evidence', 'tip', '--session', 'glimmervoid-factory'] });
  await fixture.git(['add', '.coherence'], fixture.ledger.cwd);
  await fixture.git(['commit', '-m', 'test: forge verifier link'], fixture.ledger.cwd);
  await fixture.git(['merge', '--ff-only', fixture.ledger.branch ?? 'missing']);
  const project = await fixture.verifier.tick(await fixture.readProject());
  assert.equal(project.paused, true);
  assert.match(fixture.exceptions[0], /closed without its independent verifier link/);
});

test('a verifier link and close claiming the factory session but absent from the lane state cannot close the intent', async (context) => {
  const fixture = await prepareVerifierFixture(context);
  const intentId = fixture.worker.intentId;
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['consequence', 'add', `verification:verifier-${intentId}`, 'verifies', `work:${intentId}`, '--evidence', 'Forged with the factory session', '--session', 'glimmervoid-factory', '--json'] });
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'close', intentId, 'completed', '--because', 'Forged close', '--synthesized', fixture.worker.workId, '--evidence', 'tip', '--session', 'glimmervoid-factory'] });
  await fixture.land('repo', fixture.projectPath, 'factory: forged closure');
  const project = await fixture.verifier.tick(await fixture.readProject());
  assert.equal(project.paused, true);
  assert.match(fixture.exceptions[0], /closed without its independent verifier link/);
});

test('a merge link claiming the factory session but absent from the lane state does not verify a child', async (context) => {
  const fixture = await prepareMergedFixture(context);
  const childId = await addUnmergedCompletedChild(fixture);
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['consequence', 'add', `verification:merged-${childId}`, 'verifies', `work:${childId}`, '--evidence', 'Forged', '--session', 'glimmervoid-factory', '--json'] });
  await assertVerifierIgnoresMergeLink(fixture);
});

test('a merge link not written by the factory session does not verify a child for the intent', async (context) => {
  const fixture = await prepareMergedFixture(context);
  const childId = await addUnmergedCompletedChild(fixture);
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['consequence', 'add', `verification:merged-${childId}`, 'verifies', `work:${childId}`, '--evidence', 'Forged', '--session', 'orchestrator-session', '--json'] });
  await assertVerifierIgnoresMergeLink(fixture);
});

test('disabled factory executes no verifier work', async (context) => {
  const fixture = await prepareVerifierFixture(context);
  fixture.factoryConfig.factory = { enabled: false };
  fixture.verifier.ready('repo', fixture.worker.intentId);
  await fixture.verifier.tick(await fixture.readProject());
  assert.equal(fixture.reviewRequests.length, 0);
});

async function startVerifierReviewThenMoveTip(context: TestContext, moveTip: (fixture: Awaited<ReturnType<typeof prepareVerifierFixture>>) => Promise<void>) {
  const fixture = await prepareVerifierFixture(context);
  let finishReview: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => { finishReview = resolve; });
  fixture.setVerifierBarrier(() => barrier);
  fixture.cleanupTasks.push(async () => { finishReview?.(); });
  fixture.verifier.ready('repo', fixture.worker.intentId);
  await fixture.verifier.tick(await fixture.readProject());
  await waitFor(() => fixture.reviewRequests.length === 1, 'verifier starts reading the pinned tip', 60_000);
  await moveTip(fixture);
  finishReview?.();
  await waitFor(fixture.hasChanged, 'verifier settles', 60_000);
  return fixture;
}

test('verifier rejects a passing verdict when code on the integration tip moves during its read-only session', async (context) => {
  const fixture = await startVerifierReviewThenMoveTip(context, async ({ git, projectPath }) => {
    await git(['checkout', '-q', 'integration'], projectPath);
    await writeFile(path.join(projectPath, 'src', 'moved.ts'), 'export const moved = true;\n');
    await git(['add', '--', 'src/moved.ts'], projectPath);
    await git(['commit', '-q', '-m', 'feat: move the tip'], projectPath);
  });
  assert.equal(fixture.events.at(-1)?.event, 'verification stale');
  assert.equal((await fixture.readProject()).orders.find((order) => order.id === fixture.worker.intentId)?.state, 'open');
  assert.deepEqual(fixture.stoppedOrchestrators, []);
});

test('verifier still closes the intent when only orchestrator ledger commits move the integration tip', async (context) => {
  const fixture = await startVerifierReviewThenMoveTip(context, async ({ createOrder, land, projectPath }) => {
    await createOrder(null, 'Ledger-only tip move');
    await land('repo', projectPath, 'factory: orchestrator ledger');
  });
  assert.notEqual(fixture.events.at(-1)?.event, 'verification stale');
  assert.equal((await fixture.readProject()).orders.find((order) => order.id === fixture.worker.intentId)?.state, 'completed');
  assert.deepEqual(fixture.stoppedOrchestrators, ['repo']);
});

test('verifier reports a stale verification when the orchestrator adds a child to the intent during its read-only session', async (context) => {
  const fixture = await startVerifierReviewThenMoveTip(context, async ({ createOrder, land, projectPath, worker }) => {
    await createOrder(worker.intentId, 'Child added during verification');
    await land('repo', projectPath, 'factory: orchestrator ledger');
  });
  assert.equal(fixture.events.at(-1)?.event, 'verification stale');
  assert.equal((await fixture.readProject()).orders.find((order) => order.id === fixture.worker.intentId)?.state, 'open');
  assert.deepEqual(fixture.stoppedOrchestrators, []);
});


test('factory worker session staging, polling, diff and teardown suppress shared fsmonitor commands', { skip: process.platform === 'win32' }, async (context) => {
  const fixture = await createFixture(context, false);
  const { wiring, sessions } = await startFactoryWiring(fixture, async () => {});
  const markerPath = path.join(fixture.directory, 'worker-fsmonitor-marker');
  const probePath = path.join(fixture.directory, 'worker-fsmonitor.mjs');
  await writeFile(probePath, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, process.env.FACTORY_PROBE_TOKEN ?? 'absent');\n`);
  await fixture.git(['config', 'core.fsmonitor', `${process.execPath} ${probePath}`]);
  stubEnvironmentVariable(context, 'FACTORY_PROBE_TOKEN', 'server-secret-for-worker-poll');
  const dispatched = await wiring.dispatch('factory-orch-repo', { workId: fixture.worker.workId });
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
  const worker = sessions.get(dispatched.sessionId ?? '');
  assert.ok(worker);
  await worker.checkWorktreeChange();
  await worker.getDiff();
  await worker.getChangeScopes();
  await wiring.stop();
  await assert.rejects(access(markerPath), { code: 'ENOENT' });
});
