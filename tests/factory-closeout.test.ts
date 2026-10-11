import { createFactoryWatch } from '../server/factory-watch.ts';
import type { FactoryWatchDeps } from '../server/factory-watch.ts';
import { createFactoryVerifier } from '../server/factory-verifier.ts';
import { buildFactoryProjectState, FACTORY_REVIEW_DIFF_MAX_CHARS, formatWorkerEvent, nextIntent } from '../server/core/factory-core.ts';
import type { FactoryProjectState } from '../shared/contracts/factory.ts';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createFactoryCloseOut } from '../server/factory-closeout.ts';
import type { FactoryCloseOutWorker } from '../server/factory-closeout.ts';
import { commitAndLandFactoryLedger, hasCodeChangedBetween, screenPendingLedgerWrites } from '../server/factory-ledger.ts';
import type { LaneSpawn } from '../server/lane-spawn.ts';
import { createFactoryWiring } from '../server/factory-wiring.ts';
import { createSessionFactory } from '../server/session-factory.ts';
import { HookRouter } from '../detection/hook-source.ts';
import type { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { createCoherenceLedger, stubEnvironmentVariable } from './helpers/factory-fixture.ts';
import { waitFor } from './helpers/wait-for.ts';
import { FactoryLaneState, FactoryWorkerEvent } from '../shared/contracts/factory.ts';
import type { GlimmervoidConfig } from '../server/config-store.ts';
import type { FactoryWatchEntry } from '../shared/contracts/factory.ts';
import type { Config } from '../shared/contracts/config.ts';

async function createFixture(context: TestContext, activateOrder = true) {
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
  await land('repo', projectPath, 'factory: prepare orders');
  const workspace = await gitWorkspace.create({ projectPath, teamId: 'repo', label: 'factory-worker', baseBranch: 'integration', configuredIntegrationBranch: 'integration', worktreeBase: directory, shareList: [] });
  assert.ok(workspace.isGit);
  assert.ok(workspace.baseSha);
  const feedback: string[] = [];
  const events: FactoryWorkerEvent[] = [];
  const watches: FactoryWatchEntry[] = [];
  const exceptions: string[] = [];
  const reviewRequests: Parameters<LaneSpawn>[0][] = [];
  const reviewerCwdEntries: string[][] = [];
  let isDestroyed = false;
  let isPaused = false;
  let shouldFailWatchWrite = false;
  let shouldWriteVerdictFileOnly = false;
  let verdict: unknown = { pass: true, findings: [] };
  let reviewBarrier: (() => Promise<void>) | null = null;
  let mergeReason: string | null = null;
  let mergedSha: string | null = null;
  const config: Pick<Config, 'factory' | 'worktreeShare'> = { factory: { enabled: true, checks: [`${process.execPath} --version`], reviewerModel: 'sonnet' }, worktreeShare: ['node_modules'] };
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  const worker: FactoryCloseOutWorker = {
    workId, intentId, projectId: 'repo', projectPath, baseSha: workspace.baseSha,
    objective: 'Ship retries', criteria: ['Retries pass'], writeScopes: ['src/retry.ts'],
    session: {
      worktreeDir: workspace.cwd, baseSha: workspace.baseSha,
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
    config, runCoherence, gitWorkspace, ensureLedger: async () => ledger, commitAndLand: land,
    serializeProject: coherenceLedger.serializeProject,
    readIntegrationSha: () => git(['rev-parse', 'integration']),
    recordFactoryLandedSha: async () => {},
    readPaused: async () => isPaused, baseEnv,
    appendWatch: async (entry) => {
      if (shouldFailWatchWrite) throw new Error('Watch state is unwritable');
      watches.push(entry);
    },
    setException: (_projectId, reason) => { exceptions.push(reason); },
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
  return { ...coherenceLedger, config, worker, closeOut, createOrder, workspace, directory, cleanupTasks, feedback, events, watches, exceptions, reviewRequests, reviewerCwdEntries, commitChange, baseEnv,
    isDestroyed: () => isDestroyed, mergedSha: () => mergedSha, setPaused: (paused: boolean) => { isPaused = paused; },
    failWatchWrite: () => { shouldFailWatchWrite = true; },
    setVerdictFileOnly: (nextVerdict: unknown) => { verdict = nextVerdict; shouldWriteVerdictFileOnly = true; },
    setVerdict: (nextVerdict: unknown) => { verdict = nextVerdict; },
    setReviewBarrier: (barrier: () => Promise<void>) => { reviewBarrier = barrier; },
    setMergeReason: (reason: string) => { mergeReason = reason; },
  };
}

test('passing factory worker merges and pushes, closes with merge-tip evidence, and records watch', async (context) => {
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
  assert.equal(fixture.watches[0].mergedSha, fixture.mergedSha());
  assert.equal(fixture.watches[0].workId, fixture.worker.workId);
  assert.equal(fixture.watches[0].intentId, fixture.worker.intentId);
  assert.equal(fixture.watches[0].projectId, fixture.worker.projectId);
  assert.deepEqual(fixture.watches[0].writeScopes, ['src/retry.ts']);
  assert.equal(fixture.events.at(-1)?.event, 'merged');
  assert.equal(fixture.closeOut.reviewing.size, 0);
  assert.notEqual(fixture.reviewRequests[0].cwd, fixture.workspace.cwd);
  assert.ok(fixture.reviewRequests[0].cwd.startsWith(os.tmpdir()));
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

test('out-of-fence worker retries with the path and never runs a reviewer', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange('outside.ts');
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.match(fixture.feedback[0], /Outside write scopes: outside.ts/);
  assert.equal(fixture.reviewRequests.length, 0);
  assert.equal(fixture.isDestroyed(), false);
});

test('failing repo check retries with captured output and never runs a reviewer', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  await writeFile(path.join(fixture.workspace.cwd, 'src/retry.ts'), 'process.stderr.write("failed check evidence"); process.exitCode = 1;\n');
  await fixture.git(['add', '.'], fixture.workspace.cwd);
  await fixture.git(['commit', '-m', 'test: fail check'], fixture.workspace.cwd);
  fixture.config.factory = { enabled: true, checks: [`${process.execPath} src/retry.ts`] };
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.match(fixture.feedback[0], /failed check evidence/);
  assert.equal(fixture.reviewRequests.length, 0);
});

test('third factory failure blocks the ledger order and raises an exception', async (context) => {
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
    assert.equal(fixture.watches.length, 0);
  });
}

test('uncommitted work fails the attempt with commit feedback before any HEAD comparison', async (context) => {
  const fixture = await createFixture(context);
  await writeFile(path.join(fixture.workspace.cwd, 'src/retry.ts'), 'export const retries = 5;\n');
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.match(fixture.feedback[0], /commit your work/);
  assert.equal(fixture.reviewRequests.length, 0);
});

test('a clean worker with no commits fails each attempt and blocks on the third', async (context) => {
  const fixture = await createFixture(context);
  for (const attempt of [1, 2, 3]) {
    await fixture.closeOut.turnEnded(fixture.worker);
    assert.equal(fixture.feedback.length, Math.min(attempt, 2));
  }
  assert.match(fixture.feedback[0], /No change was committed/);
  assert.equal(await fixture.orderState(fixture.worker.workId), 'blocked');
  assert.equal(fixture.isDestroyed(), true);
  assert.equal(fixture.reviewRequests.length, 0);
});

test('worker coherence traces and committed ledger changes are discarded and never merged', async (context) => {
  const fixture = await createFixture(context);
  const committedLedgerPath = '.coherence/decisions/worker-session.jsonl';
  await mkdir(path.join(fixture.workspace.cwd, '.coherence/decisions'), { recursive: true });
  await writeFile(path.join(fixture.workspace.cwd, committedLedgerPath), '{"forged":true}\n');
  await fixture.git(['add', '--', committedLedgerPath], fixture.workspace.cwd);
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

test('a check that writes ignored output still lets the next attempt reach the checks and review, and never touches the worker tree', async (context) => {
  const fixture = await createFixture(context);
  await ignoreInCommonGitDirectory(fixture, ['dist/', '*.tsbuildinfo']);
  await commitCheckScript(fixture, [
    "const fs = process.getBuiltinModule('node:fs');",
    "fs.mkdirSync('dist', { recursive: true });",
    "fs.writeFileSync('dist/out.js', 'built');",
    "fs.writeFileSync('tsconfig.tsbuildinfo', '{}');",
  ]);
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
  assert.equal((await fixture.git(['worktree', 'list', '--porcelain'])).includes('glimmervoid-factory-checks-'), false);
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
  assert.match(fixture.feedback[0], /change too large for review; split it into smaller orders/);
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
  assert.equal(fixture.watches.length, 0);
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
  assert.equal(fixture.watches.length, 0);
});


async function startFactoryWiring(fixture: Awaited<ReturnType<typeof createFixture>>, spawnReviewer: LaneSpawn) {
  let nowMs = Date.now();
  const notifications: { category: string; message: string }[] = [];
  const config: GlimmervoidConfig = {
    projects: [{ id: 'repo', name: 'Factory', path: fixture.projectPath }], integrationBranch: 'integration',
    factory: { enabled: true, watchWindowMinutes: 1, checks: [`${process.execPath} --version`], reviewerModel: null },
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
    config, homeDir, now: () => nowMs, readSpentTodayUsd: () => ({ status: 'known', amountUsd: 1 }),
    notify: (_projectName, category, message) => { notifications.push({ category, message }); }, gitWorkspace: fixture.gitWorkspace, firstTickDelayMs: () => 0, broadcast: () => {},
    orchestratorOptions: {
      getHookPort: () => 3911,
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
  return { wiring, config, sessions, statePath, notifications, setNow: (timestampMs: number) => { nowMs = timestampMs; } };
}

test('factory wiring observes worker Stop, exposes Review, and persists the merged watch entry', async (context) => {
  const fixture = await createFixture(context, false);
  const workId = fixture.worker.workId;
  let finishReview: (() => void) | undefined;
  const reviewBarrier = new Promise<void>((resolve) => { finishReview = resolve; });
  fixture.cleanupTasks.push(async () => { finishReview?.(); });
  const { wiring, config, sessions, statePath, notifications, setNow } = await startFactoryWiring(fixture, async (request) => {
    await reviewBarrier;
    request.onOutput?.(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { pass: true, findings: [] } }));
  });
  const reply = await wiring.dispatch('factory-orch-repo', { workId });
  if (!reply.ok) throw new Error(reply.reason);
  const worker = sessions.get(reply.sessionId);
  assert.ok(worker?.worktreeDir);
  await writeFile(path.join(worker.worktreeDir, 'src/retry.ts'), 'export const retries = 2;\n');
  await fixture.git(['add', 'src/retry.ts'], worker.worktreeDir);
  await fixture.git(['commit', '-m', 'fix: wired retries'], worker.worktreeDir);
  worker.emit('hook-event', { event: 'stop', payload: {} });
  await waitFor(() => wiring.getState()?.projects[0]?.reviewing?.includes(workId) === true, 'factory exposes Review during close-out', 30_000);
  finishReview?.();
  await waitFor(() => worker._destroyed, 'factory completes close-out and destroys the worker', 30_000);
  const state = FactoryLaneState.parse(JSON.parse(await readFile(statePath, 'utf8')));
  assert.equal(state.watch?.length, 1);
  assert.equal(state.watch[0].workId, workId);
  assert.equal(state.watch[0].intentId, fixture.worker.intentId);
  assert.deepEqual(state.watch[0].writeScopes, ['src/retry.ts']);
  assert.equal(await fixture.orderState(workId), 'completed');
  assert.equal(await fixture.git(['rev-parse', 'integration']), await fixture.git(['rev-parse', 'origin/integration']));
  const queuedNext = await wiring.queueIntent({ projectId: 'repo', objective: 'Next intent', criteria: ['Retries pass'], risk: 'medium', boundary: 'This repo', writeScopes: ['src'] });
  assert.ok(queuedNext.workId, queuedNext.error ?? 'Queue failed');
  const nextIntentId = queuedNext.workId;
  setNow(Date.now() + 61_000);
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

test('a watch write failure after a successful merge raises an exception without asking the worker to redo landed work', async (context) => {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  fixture.failWatchWrite();
  await fixture.closeOut.turnEnded(fixture.worker);
  assert.ok(fixture.mergedSha());
  assert.equal(await fixture.orderState(fixture.worker.workId), 'completed');
  assert.deepEqual(fixture.feedback, []);
  assert.match(fixture.exceptions[0], /Factory finalization failed after merge:.*Watch state is unwritable/);
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

async function prepareWatchFixture(context: TestContext) {
  const fixture = await createFixture(context);
  await fixture.commitChange();
  await fixture.closeOut.turnEnded(fixture.worker);
  const state: FactoryLaneState = { ledgerPath: fixture.ledger.cwd, ledgerBranch: fixture.ledger.branch ?? null, paused: false, watch: fixture.watches.slice() };
  const config: GlimmervoidConfig = { projects: [{ id: 'repo', name: 'Factory', path: fixture.projectPath }], factory: { enabled: true, watchWindowMinutes: 1, watchProjects: [{ project: 'repo', posthogProjectId: 12 }], verifierModel: 'sonnet' }, posthog: { host: 'https://posthog.test', apiKey: 'test-key' } };
  const notifications: string[] = [];
  let queryCount = 0;
  let queryBody: unknown = { results: [] };
  let shouldFailQuery = false;
  let nowMs = Date.parse(fixture.watches[0].mergedAt) + 60_000;
  let shouldFailLanding = false;
  const watchDeps: FactoryWatchDeps = { config, runCoherence: fixture.runCoherence, ensureLedger: async () => fixture.ledger, commitAndLand: async (...args) => {
    if (shouldFailLanding) { shouldFailLanding = false; throw new Error('Landing unavailable'); }
    await fixture.land(...args);
  },
    serializeProject: async <T>(_projectId: string, operation: () => Promise<T>) => operation(),
    readLaneState: async () => state, writeLaneState: async (_projectId, updated) => { Object.assign(state, updated); }, now: () => nowMs,
    log: { warn: () => {} }, notify: (_projectName, message) => { notifications.push(message); }, notifyOrchestrator: (_projectId, event) => { fixture.events.push(event); },
    runHogQL: async (projectId, query) => {
      queryCount += 1;
      assert.equal(projectId, 12);
      assert.ok(query.includes(fixture.watches[0].mergedAt));
      if (shouldFailQuery) return { ok: false, error: 'query unavailable' };
      return { ok: true, status: 200, body: queryBody };
    },
  };
  const watcher = createFactoryWatch(watchDeps);
  const readProject = async (): Promise<FactoryProjectState> => buildFactoryProjectState({ projectId: 'repo', projectName: 'Factory',
    headSha: await fixture.git(['rev-parse', 'integration']), orient: await fixture.readOrient(), work: await fixture.inspect(), error: null, paused: state.paused });
  return { ...fixture, watcher, watchDeps, state, failLanding: () => { shouldFailLanding = true; }, watchConfig: config, notifications, readProject, queryCount: () => queryCount,
    setQuery: (body: unknown) => { queryBody = body; }, failQuery: () => { shouldFailQuery = true; }, restoreQuery: () => { shouldFailQuery = false; }, setNow: (timestampMs: number) => { nowMs = timestampMs; } };
}

async function assertVerifierIgnoresWatchLink(fixture: Awaited<ReturnType<typeof prepareWatchFixture>>) {
  const reviewRequests: string[] = [];
  const verifier = createFactoryVerifier({ config: fixture.watchConfig, runCoherence: fixture.runCoherence, ensureLedger: async () => fixture.ledger,
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

test('clean watch files the verification and orient stops listing the merged order as unverified', async (context) => {
  const fixture = await prepareWatchFixture(context);
  assert.ok((await fixture.readProject()).unverifiedCompletedWork.includes(fixture.worker.workId));
  await fixture.watcher.tick(await fixture.readProject());
  assert.equal(fixture.state.watch?.length, 0);
  assert.deepEqual(fixture.state.trustedVerifications, [{ id: `watch-${fixture.worker.workId}`, sha: fixture.watches[0].mergedSha }]);
  assert.equal((await fixture.readProject()).unverifiedCompletedWork.includes(fixture.worker.workId), false);
  await fixture.watcher.tick(await fixture.readProject());
  assert.equal(fixture.queryCount(), 1);
  assert.deepEqual(fixture.notifications, []);
});

test('a watch whose ledger landing fails records no trusted verification until a later landing succeeds', async (context) => {
  const fixture = await prepareWatchFixture(context);
  fixture.failLanding();
  const project = await fixture.readProject();
  await assert.rejects(() => fixture.watcher.tick(project), /Landing unavailable/);
  assert.deepEqual(fixture.state.trustedVerifications ?? [], []);
  assert.equal(fixture.state.watch?.length, 1);
  await fixture.watcher.tick(await fixture.readProject());
  assert.deepEqual(fixture.state.trustedVerifications, [{ id: `watch-${fixture.worker.workId}`, sha: fixture.watches[0].mergedSha }]);
  assert.equal(fixture.state.watch?.length, 0);
});

test('one project query watches multiple merges and only drops elapsed clean windows', async (context) => {
  const fixture = await prepareWatchFixture(context);
  const firstWatch = fixture.watches[0];
  const secondWorkId = await fixture.createOrder(fixture.worker.intentId, 'Ship follow-up retries');
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'close', secondWorkId, 'completed',
    '--because', 'Follow-up merged', '--session', 'glimmervoid-factory', '--evidence', firstWatch.mergedSha] });
  await fixture.land('repo', fixture.projectPath, 'factory: follow-up merge');
  const secondWatch = { ...firstWatch, workId: secondWorkId, mergedAt: new Date(Date.parse(firstWatch.mergedAt) + 30_000).toISOString() };
  fixture.state.watch = [secondWatch, firstWatch];
  const watched = await fixture.watcher.tick(await fixture.readProject());
  assert.equal(fixture.queryCount(), 1);
  assert.deepEqual(watched.watches, [secondWatch]);
  assert.deepEqual(fixture.state.watch, [secondWatch]);
  const refreshed = await fixture.readProject();
  assert.equal(refreshed.unverifiedCompletedWork.includes(firstWatch.workId), false);
  assert.equal(refreshed.unverifiedCompletedWork.includes(secondWorkId), true);
  assert.deepEqual(fixture.notifications, []);
});

test('watch breach files one defect per issue and watch, notifies, and never verifies or reverts', async (context) => {
  const fixture = await prepareWatchFixture(context);
  const firstSeen = new Date(Date.parse(fixture.watches[0].mergedAt) + 1).toISOString();
  fixture.setQuery({ columns: ['issueId', 'firstSeen', 'framePaths'], results: [['issue-123', firstSeen, ['webpack:///dist/src/retry.ts']], ['issue-123', firstSeen, ['src/retry.ts']]] });
  await fixture.watcher.tick(await fixture.readProject());
  await fixture.watcher.tick(await fixture.readProject());
  assert.equal(fixture.commands.filter((command) => command[0] === 'defect').length, 1);
  assert.equal(fixture.state.watch?.length, 0);
  assert.equal(fixture.events.at(-1)?.event, 'breach');
  assert.equal(fixture.notifications[0], `[factory] breach on ${fixture.worker.workId}: issue issue-123`);
  assert.equal((await fixture.readProject()).unverifiedCompletedWork.includes(fixture.worker.workId), true);
  assert.equal(await readFile(path.join(fixture.projectPath, 'src/retry.ts'), 'utf8'), 'export const retries = 1;\n');
});

for (const failure of ['unmapped', 'missing-key']) {
  test(`watch ${failure} elapses into an honest unwatched verification, never a clean watch`, async (context) => {
    const fixture = await prepareWatchFixture(context);
    if (failure === 'unmapped' && fixture.watchConfig.factory) fixture.watchConfig.factory.watchProjects = [];
    if (failure === 'missing-key') fixture.watchConfig.posthog = null;
    const project = await fixture.watcher.tick(await fixture.readProject());
    assert.match(project.note ?? '', /Watch:/);
    assert.equal(project.error, null);
    assert.equal(fixture.state.watch?.length, 0);
    assert.equal(fixture.queryCount(), 0);
    const added = fixture.commands.filter((command) => command[0] === 'consequence' && command[1] === 'add');
    assert.equal(added.length, 1);
    assert.equal(added[0][2], `verification:unwatched-${fixture.worker.workId}`);
    assert.match(added[0][added[0].indexOf('--evidence') + 1], /no PostHog (project was mapped|API key was available)/);
    assert.equal((await fixture.readProject()).unverifiedCompletedWork.includes(fixture.worker.workId), false);
  });
}

test('a failed watch query carries the window forward without verifying, then a successful query verifies it', async (context) => {
  const fixture = await prepareWatchFixture(context);
  fixture.failQuery();
  const failed = await fixture.watcher.tick(await fixture.readProject());
  assert.match(failed.note ?? '', /query unavailable/);
  assert.equal(fixture.state.watch?.length, 1);
  assert.equal(fixture.commands.some((command) => command[0] === 'consequence' && command[1] === 'add'), false);
  assert.equal((await fixture.readProject()).unverifiedCompletedWork.includes(fixture.worker.workId), true);
  fixture.restoreQuery();
  await fixture.watcher.tick(await fixture.readProject());
  assert.equal(fixture.state.watch?.length, 0);
  assert.equal(fixture.commands.find((command) => command[0] === 'consequence' && command[1] === 'add')?.[2], `verification:watch-${fixture.worker.workId}`);
});

async function prepareVerifierFixture(context: TestContext) {
  const fixture = await prepareWatchFixture(context);
  await fixture.watcher.tick(await fixture.readProject());
  const reviewRequests: Parameters<LaneSpawn>[0][] = [];
  const verifierCwdEntries: string[][] = [];
  let verdict = { pass: true, findings: [] as string[] };
  let hasChanged = false;
  let verifierBarrier: (() => Promise<void>) | null = null;
  const stoppedOrchestrators: string[] = [];
  let shouldFailVerifierLanding = false;
  const verifier = createFactoryVerifier({ config: fixture.watchConfig, runCoherence: fixture.runCoherence, ensureLedger: async () => fixture.ledger,
    commitAndLand: async (...args) => {
      if (shouldFailVerifierLanding) throw new Error('Verifier landing unavailable');
      await fixture.land(...args);
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
  return { ...fixture, verifier, failVerifierLanding: () => { shouldFailVerifierLanding = true; }, setVerifierBarrier: (barrier: () => Promise<void>) => { verifierBarrier = barrier; }, reviewRequests, verifierCwdEntries, stoppedOrchestrators, hasChanged: () => hasChanged,
    setVerifierVerdict: (next: typeof verdict) => { verdict = next; } };
}

test('independent verifier pass files its link, closes the intent with tip evidence, and advances the queue', async (context) => {
  const fixture = await prepareVerifierFixture(context);
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
  assert.ok(fixture.reviewRequests[0].cwd.startsWith(os.tmpdir()));
  assert.deepEqual(fixture.verifierCwdEntries, [[]]);
  const addDirIndex = fixture.reviewRequests[0].extraArgs?.indexOf('--add-dir') ?? -1;
  assert.equal(fixture.reviewRequests[0].extraArgs?.[addDirIndex + 1], path.join(fixture.directory, 'verifier-control'));
  assert.ok(fixture.reviewRequests[0].extraArgs?.[addDirIndex + 2]?.startsWith('--'), 'the variadic --add-dir must be bounded by an option or it swallows the prompt');
  assert.ok(fixture.reviewRequests[0].prompt.includes(project.headSha ?? 'missing'));
  const closeCommand = fixture.commands.findLast((command) => command[1] === 'close');
  assert.equal(closeCommand?.[closeCommand.indexOf('--evidence') + 1], project.headSha);
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
  assert.ok(defect.evidence.length <= 1000);
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

test('a verifier whose ledger landing fails leaves no trusted verification or intent close', async (context) => {
  const fixture = await prepareVerifierFixture(context);
  fixture.failVerifierLanding();
  fixture.verifier.ready('repo', fixture.worker.intentId);
  await fixture.verifier.tick(await fixture.readProject());
  await waitFor(fixture.hasChanged, 'verifier finishes with a failed landing', 60_000);
  assert.match(fixture.exceptions.at(-1) ?? '', /Verifier landing unavailable/);
  assert.equal(fixture.state.trustedVerifications?.some(({ id }) => id === `verifier-${fixture.worker.intentId}`), false);
  assert.deepEqual(fixture.state.trustedIntentCloses ?? [], []);
  assert.deepEqual(fixture.stoppedOrchestrators, []);
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

test('a trusted watch id does not verify a child through a link whose evidence names a different sha', async (context) => {
  const fixture = await prepareWatchFixture(context);
  const childId = fixture.worker.workId;
  fixture.state.trustedVerifications = [{ id: `watch-${childId}`, sha: fixture.watches[0].mergedSha }];
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['consequence', 'add', `verification:watch-${childId}`, 'verifies', `work:${childId}`,
    '--evidence', `Clean watch window after ${fixture.worker.baseSha ?? 'missing'} merged`, '--session', 'glimmervoid-factory', '--json'] });
  await assertVerifierIgnoresWatchLink(fixture);
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

test('a watch link claiming the factory session but absent from the lane state does not verify a child', async (context) => {
  const fixture = await prepareWatchFixture(context);
  const childId = fixture.worker.workId;
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['consequence', 'add', `verification:watch-${childId}`, 'verifies', `work:${childId}`, '--evidence', 'Forged', '--session', 'glimmervoid-factory', '--json'] });
  await assertVerifierIgnoresWatchLink(fixture);
});

for (const [name, body] of [['a null body', null], ['a body without results', { columns: ['issueId'] }], ['unreadable array rows', { results: [['issue-1', '2026-01-01T00:00:00Z', []]] }]] as const) {
  test(`a successful watch query with ${name} carries the window forward and never verifies`, async (context) => {
    const fixture = await prepareWatchFixture(context);
    fixture.setQuery(body);
    const project = await fixture.watcher.tick(await fixture.readProject());
    assert.match(project.note ?? '', /windows carry forward/);
    assert.equal(fixture.state.watch?.length, 1);
    assert.equal(fixture.commands.some((command) => command[0] === 'consequence' && command[1] === 'add'), false);
    assert.deepEqual(fixture.state.trustedVerifications ?? [], []);
    assert.equal((await fixture.readProject()).unverifiedCompletedWork.includes(fixture.worker.workId), true);
  });
}

test('a watch link not written by the factory session does not verify a child for the intent', async (context) => {
  const fixture = await prepareWatchFixture(context);
  const childId = fixture.worker.workId;
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['consequence', 'add', `verification:watch-${childId}`, 'verifies', `work:${childId}`, '--evidence', 'Forged', '--session', 'orchestrator-session', '--json'] });
  await assertVerifierIgnoresWatchLink(fixture);
});

test('disabled factory executes no watch query or verifier work', async (context) => {
  const fixture = await prepareVerifierFixture(context);
  fixture.watchConfig.factory = { enabled: false };
  fixture.state.watch = fixture.watches.slice();
  const queryCount = fixture.queryCount();
  fixture.verifier.ready('repo', fixture.worker.intentId);
  await fixture.watcher.tick(await fixture.readProject());
  await fixture.verifier.tick(await fixture.readProject());
  assert.equal(fixture.queryCount(), queryCount);
  assert.equal(fixture.reviewRequests.length, 0);
  assert.equal(fixture.state.watch.length, 1);
});

test('watch resumes a persisted breach after failed landing and a restart without duplicating defects', async (context) => {
  const fixture = await prepareWatchFixture(context);
  const firstSeen = new Date(Date.parse(fixture.watches[0].mergedAt) + 1).toISOString();
  fixture.setQuery({ results: [{ issueId: 'persisted-issue', firstSeen: firstSeen.replace('Z', ''), framePaths: ['src/retry.ts'] }] });
  fixture.failLanding();
  const project = await fixture.readProject();
  await assert.rejects(() => fixture.watcher.tick(project), /Landing unavailable/);
  assert.equal(fixture.state.watch?.[0]?.breaches?.[0]?.issueId, 'persisted-issue');
  fixture.watcher.stop();
  fixture.failQuery();
  const restarted = createFactoryWatch(fixture.watchDeps);
  await restarted.tick(await fixture.readProject());
  assert.equal(await fixture.countLandedDefectsMentioning('persisted-issue'), 1);
  assert.equal(fixture.notifications.length, 1);
  assert.equal(fixture.state.watch?.length, 0);
  assert.equal((await fixture.readProject()).unverifiedCompletedWork.includes(fixture.worker.workId), true);
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


test('watch retries through pending ledger screening after a failed landing and lands exactly one breach defect', async (context) => {
  const fixture = await prepareWatchFixture(context);
  let screeningRefusals = 0;
  fixture.watchDeps.ensureLedger = async () => {
    await screenPendingLedgerWrites({ cwd: fixture.ledger.cwd, intentId: fixture.worker.intentId,
      onRefused: () => { screeningRefusals += 1; } });
    return fixture.ledger;
  };
  fixture.watcher.stop();
  const watcher = createFactoryWatch(fixture.watchDeps);
  const firstSeen = new Date(Date.parse(fixture.watches[0].mergedAt) + 1).toISOString();
  fixture.setQuery({ results: [{ issueId: 'screened-retry', firstSeen, framePaths: ['src/retry.ts'] }] });
  fixture.failLanding();
  const project = await fixture.readProject();
  await assert.rejects(() => watcher.tick(project), /Landing unavailable/);
  assert.equal(fixture.state.watch?.length, 1);
  assert.equal(await fixture.countLandedDefectsMentioning('screened-retry'), 0);
  await watcher.tick(await fixture.readProject());
  assert.equal(screeningRefusals, 1);
  assert.equal(await fixture.countLandedDefectsMentioning('screened-retry'), 1);
  assert.equal(fixture.state.watch?.length, 0);
  assert.equal(fixture.commands.filter((command) => command[0] === 'defect' && command[1].includes('screened-retry')).length, 2);
  assert.equal(await fixture.git(['rev-parse', 'integration']), await fixture.git(['rev-parse', 'integration'], path.join(fixture.directory, 'origin.git')));
});


test('a push failure after the ledger commit files the breach once, recovery lands exactly one defect, and a restart does not re-file', async (context) => {
  const fixture = await prepareWatchFixture(context);
  const originPath = path.join(fixture.directory, 'origin.git');
  let screeningRefusals = 0;
  let shouldFailPush = true;
  let hasPendingLanding = false;
  const failingPushWorkspace = { ...fixture.gitWorkspace, mergeKeep: async (args: Parameters<typeof fixture.gitWorkspace.mergeKeep>[0]) => {
    if (!shouldFailPush) return fixture.gitWorkspace.mergeKeep(args);
    shouldFailPush = false;
    return { merged: false, committed: true, branch: args.workspace?.branch ?? null, reason: 'push rejected by origin' };
  } };
  fixture.watchDeps.ensureLedger = async () => {
    await screenPendingLedgerWrites({ cwd: fixture.ledger.cwd, intentId: fixture.worker.intentId, onRefused: () => { screeningRefusals += 1; } });
    return fixture.ledger;
  };
  fixture.watchDeps.commitAndLand = async (_projectId, projectPath, message, options) => {
    try {
      await commitAndLandFactoryLedger({ projectPath, ledger: fixture.ledger, targetBranch: 'integration', message, gitWorkspace: failingPushWorkspace,
        trusted: true, writtenRecordIds: fixture.writtenRecordIds, retryLanding: hasPendingLanding, onCommitted: options?.onCommitted });
      hasPendingLanding = false;
    } catch (error) {
      hasPendingLanding = true;
      throw error;
    }
  };
  fixture.watcher.stop();
  const firstSeen = new Date(Date.parse(fixture.watches[0].mergedAt) + 1).toISOString();
  fixture.setQuery({ results: [{ issueId: 'push-failed', firstSeen, framePaths: ['src/retry.ts'] }] });
  const defectCommands = () => fixture.commands.filter((command) => command[0] === 'defect' && command[1].includes('push-failed')).length;
  const landedDefects = () => fixture.countLandedDefectsMentioning('push-failed');
  const watcher = createFactoryWatch(fixture.watchDeps);
  await assert.rejects(async () => watcher.tick(await fixture.readProject()), /push rejected by origin/);
  assert.equal(defectCommands(), 1);
  assert.deepEqual(fixture.state.filedBreaches, [`${fixture.worker.workId}:push-failed`]);
  assert.equal(await landedDefects(), 0);
  watcher.stop();
  const restarted = createFactoryWatch(fixture.watchDeps);
  await restarted.tick(await fixture.readProject());
  assert.equal(defectCommands(), 1);
  assert.equal(screeningRefusals, 0);
  assert.equal(await landedDefects(), 1);
  assert.equal(fixture.state.watch?.length, 0);
  assert.deepEqual(fixture.state.filedBreaches, []);
  assert.equal(await fixture.git(['rev-parse', 'integration'], originPath), await fixture.git(['rev-parse', 'integration']));
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
