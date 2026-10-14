import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileAsync } from '../server/child-process-safe.ts';
import { createFactoryCloseOut } from '../server/factory/factory-closeout.ts';
import type { FactoryCloseOutWorker } from '../server/factory/factory-closeout.ts';
import { createFactoryDecisionLog } from '../server/factory/factory-decision-log.ts';
import { createFactoryWiring } from '../server/factory/factory-wiring.ts';
import { FACTORY_DECISION_OUTPUT_MAX_BYTES, FactoryDecisionLogLine } from '../shared/contracts/factory-decision-log.ts';
import { FactoryLaneState } from '../shared/contracts/factory.ts';
import { createCoherenceLedger, stubEnvironmentVariable } from './helpers/factory-fixture.ts';
import { waitFor } from './helpers/wait-for.ts';

test('close-out logs one decision per attempt with redacted byte-capped output and the review verdict', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-decisions-'));
  let stopLane = async () => {};
  context.after(async () => { await stopLane(); await rm(directory, { recursive: true, force: true }); });
  const fixture = await createCoherenceLedger(directory);
  const intentId = await fixture.createOrder({ parent: null, objective: 'Ship retries' });
  const workId = await fixture.createOrder({ parent: intentId, objective: 'Implement retries' });
  await fixture.runCoherence({ cwd: fixture.ledger.cwd, args: ['work', 'transition', workId, 'active', '--because', 'Factory dispatch', '--session', 'glimmervoid-factory'] });
  await fixture.land('repo', fixture.projectPath, 'factory: prepare tickets');
  const workspace = await fixture.gitWorkspace.create({ projectPath: fixture.projectPath, teamId: 'repo', label: 'worker', baseBranch: 'integration', configuredIntegrationBranch: 'integration', worktreeBase: directory, shareList: [] });
  assert.ok(workspace.isGit);
  assert.ok(workspace.baseSha);
  const secret = 'factory-decision-test-secret';
  const sharedEnvFileSecret = 'factory-decision-shared-env-secret';
  await mkdir(path.join(fixture.projectPath, '.git/info'), { recursive: true });
  await writeFile(path.join(fixture.projectPath, '.git/info/exclude'), '.env\n');
  await writeFile(path.join(fixture.projectPath, '.env'), `export DEPLOY_TOKEN="quoted-${sharedEnvFileSecret}" # rotate monthly\nAPI_TOKEN=unquoted-${sharedEnvFileSecret}#nospace comment\n`);
  const sourcePath = path.join(workspace.cwd, 'src/retry.ts');
  await writeFile(sourcePath, `process.stdout.write('PREFIX' + '\u03bb'.repeat(12000) + '\\nsecret line ${secret}\\ndotenv line quoted-${sharedEnvFileSecret}\\ndotenv line unquoted-${sharedEnvFileSecret}\\nTAIL\\n'); process.exitCode = 1;\n`);
  await fixture.git(['add', '.'], workspace.cwd);
  await fixture.git(['commit', '-m', 'test: failing check'], workspace.cwd);
  const warnings: string[] = [];
  const announcedDecisions: FactoryDecisionLogLine[] = [];
  const decisionLog = createFactoryDecisionLog({
    homeDir: directory, now: () => Date.parse('2026-10-11T12:00:00Z'), log: { warn: (message) => { warnings.push(message); } },
    onDecision: (line) => { announcedDecisions.push(line); },
  });
  const feedback: string[] = [];
  let isDestroyed = false;
  let mergedSha: string | null = null;
  const worker: FactoryCloseOutWorker = {
    projectId: 'repo', projectPath: fixture.projectPath, workId, intentId, baseSha: workspace.baseSha,
    objective: 'Implement retries', criteria: ['Retries pass'], writeScopes: ['src/retry.ts'],
    session: { id: 'worker-session', worktreeDir: workspace.cwd, baseSha: workspace.baseSha,
      get _destroyed() { return isDestroyed; }, destroy: () => { isDestroyed = true; }, write: () => {},
      pasteTextWhenReady: (text) => { feedback.push(text); return { ok: true }; },
      mergeWorktree: () => fixture.gitWorkspace.mergeBack({ projectPath: fixture.projectPath, workspace, targetBranch: 'integration' }) },
  };
  const closeOut = createFactoryCloseOut({
    config: { factory: { enabled: true, checks: [`${process.execPath} --version`, `${process.execPath} src/retry.ts`, `${process.execPath} -p process.version.repeat(4000)`] }, worktreeShare: ['.env'] },
    gitWorkspace: fixture.gitWorkspace, serializeProject: fixture.serializeProject,
    ensureLedger: async () => fixture.ledger, runCoherence: fixture.runCoherence, commitAndLand: fixture.land,
    readIntegrationSha: () => fixture.git(['rev-parse', 'integration']), recordFactoryLandedSha: async (_projectId, sha) => { mergedSha = sha; },
    readPaused: async () => false, trustVerification: async () => {}, recordDecision: decisionLog.record,
    baseEnv: { ...process.env, GLIMMERVOID_POSTHOG_API_KEY: secret },
    prepareCheckRunner: async () => ({ runCheck: (argv, options) => execFileAsync(argv[0], argv.slice(1), options), dispose: async () => {} }),
    spawnReviewer: async (request) => { request.onOutput?.(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { pass: true, findings: [] } })); },
    notifyOrchestrator: decisionLog.recordEvent, setException: (_projectId, reason) => { assert.fail(reason); },
  });
  stopLane = closeOut.stop;
  await Promise.all([closeOut.turnEnded(worker), closeOut.turnEnded(worker)]);
  await decisionLog.idle();
  const filePath = path.join(directory, 'factory/repo/decisions/2026-10-11.jsonl');
  const readLines = async () => (await readFile(filePath, 'utf8')).trim().split('\n').map((line) => FactoryDecisionLogLine.parse(JSON.parse(line)));
  const [firstAttempt] = await readLines();
  assert.equal((await readLines()).length, 1);
  assert.deepEqual(announcedDecisions, [firstAttempt]);
  assert.equal(firstAttempt.kind, 'closeout');
  if (firstAttempt.kind !== 'closeout') assert.fail('Missing close-out decision');
  assert.equal(firstAttempt.outcome, 'retry');
  assert.equal(firstAttempt.failureClass, 'check');
  assert.equal(firstAttempt.attempt, 1);
  assert.ok(firstAttempt.durationMs > 0);
  assert.deepEqual(firstAttempt.fence, { ok: true });
  assert.equal(firstAttempt.checks.length, 3);
  assert.equal(firstAttempt.checks[0].pass, true);
  assert.ok(firstAttempt.checks.reduce((totalBytes, check) => totalBytes + Buffer.byteLength(check.output), 0) <= FACTORY_DECISION_OUTPUT_MAX_BYTES);
  assert.equal(firstAttempt.checks[1].command, `${process.execPath} src/retry.ts`);
  assert.equal(firstAttempt.checks[1].pass, false);
  assert.equal(firstAttempt.checks[2].pass, true);
  assert.equal(firstAttempt.review, null);
  const output = firstAttempt.checks[1].output;
  assert.ok(Buffer.byteLength(output) <= FACTORY_DECISION_OUTPUT_MAX_BYTES);
  assert.ok(Buffer.byteLength(output) > 4000);
  assert.ok(output.includes('TAIL'));
  assert.ok(!output.includes('PREFIX'));
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes('secret line'));
  assert.ok(!JSON.stringify(firstAttempt).includes(sharedEnvFileSecret));
  assert.ok(!output.includes('\ufffd'));
  assert.ok(feedback[0].length <= 4000);
  await writeFile(sourcePath, 'process.stdout.write("checks passed");\n');
  await fixture.git(['add', '.'], workspace.cwd);
  await fixture.git(['commit', '-m', 'fix: passing check'], workspace.cwd);
  await closeOut.turnEnded(worker);
  await decisionLog.idle();
  const lines = await readLines();
  const attempts = lines.filter((line) => line.kind === 'closeout');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].attempt, 2);
  assert.equal(attempts[1].outcome, 'merge');
  assert.equal(attempts[1].failureClass, null);
  assert.deepEqual(attempts[1].review, { pass: true, findings: [] });
  const merge = lines.find((line) => line.kind === 'merge');
  assert.equal(merge?.mergedSha, mergedSha);
  assert.ok(mergedSha);
  await fixture.git(['merge-base', '--is-ancestor', mergedSha, 'integration']);
  assert.deepEqual(warnings, []);
  if (process.platform !== 'win32') assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test('wiring logs identical exceptions and landing failures once, then records recovery', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'factory-decision-rate-'));
  let stopLane = async () => {};
  context.after(async () => { await stopLane(); await rm(directory, { recursive: true, force: true }); });
  const fixture = await createCoherenceLedger(directory);
  const homeDir = path.join(directory, 'home');
  const decisionsDirectory = path.join(homeDir, 'factory/repo/decisions');
  await mkdir(decisionsDirectory, { recursive: true });
  await writeFile(path.join(homeDir, 'factory/repo/state.json'), JSON.stringify({ ledgerPath: fixture.ledger.cwd, ledgerBranch: fixture.ledger.branch, paused: false }));
  const agedFilePath = path.join(decisionsDirectory, '2000-01-01.jsonl');
  await writeFile(agedFilePath, '{}\n');
  await utimes(agedFilePath, new Date('2000-01-01'), new Date('2000-01-01'));
  let shouldFailLanding = true;
  const wiring = createFactoryWiring({
    config: { factory: { enabled: true }, integrationBranch: 'integration', projects: [{ id: 'repo', name: 'Factory', path: fixture.projectPath }] },
    homeDir, broadcast: () => {}, firstTickDelayMs: () => 0, now: () => Date.parse('2026-10-11T12:00:00Z'),
    gitWorkspace: { ...fixture.gitWorkspace, mergeKeep: async (args) => {
      if (shouldFailLanding) return { merged: false, committed: true, branch: args.workspace?.branch ?? null, reason: 'landing refused' };
      return fixture.gitWorkspace.mergeKeep(args);
    } },
  });
  stopLane = wiring.stop;
  wiring.start();
  await waitFor(() => wiring.getState() !== null, 'factory lane starts', 30_000);
  await waitFor(() => !existsSync(agedFilePath), 'aged decision file is pruned');
  const exceptionSecret = 'factory-decision-exception-secret';
  stubEnvironmentVariable(context, 'FACTORY_DECISION_TEST_TOKEN', exceptionSecret);
  await mkdir(path.join(fixture.ledger.cwd, '.coherence'), { recursive: true });
  await writeFile(path.join(fixture.ledger.cwd, '.coherence', `${exceptionSecret}.txt`), 'stray orchestrator write\n');
  const request = { projectId: 'repo', objective: 'Ship retries', criteria: ['Retries pass'], risk: 'low' as const, boundary: 'This repo', writeScopes: ['src/retry.ts'] };
  assert.equal((await wiring.queueIntent(request)).error, 'landing refused');
  assert.equal((await wiring.queueIntent({ ...request, objective: 'Second intent' })).error, 'landing refused');
  shouldFailLanding = false;
  assert.equal((await wiring.queueIntent({ ...request, objective: 'Third intent' })).ok, true);
  const integrationTree = await fixture.git(['rev-parse', 'integration^{tree}']);
  const outsideSha = await fixture.git(['commit-tree', integrationTree, '-p', 'integration', '-m', 'Outside factory']);
  await fixture.git(['update-ref', 'refs/heads/integration', outsideSha]);
  const refused = await wiring.queueIntent({ ...request, objective: 'Fourth intent' });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /integration branch moved outside the factory/);
  const state = FactoryLaneState.parse(JSON.parse(await readFile(path.join(homeDir, 'factory/repo/state.json'), 'utf8')));
  assert.ok(state.ledgerPath);
  await fixture.git(['restore', '--source=HEAD', '--staged', '--worktree', '--', '.coherence'], state.ledgerPath);
  await fixture.git(['clean', '-fdq', '--', '.coherence'], state.ledgerPath);
  assert.equal((await wiring.queueIntent({ ...request, objective: 'Fifth intent' })).error, refused.error);
  await wiring.stop();
  const lines = (await readFile(path.join(decisionsDirectory, '2026-10-11.jsonl'), 'utf8')).trim().split('\n').map((line) => FactoryDecisionLogLine.parse(JSON.parse(line)));
  assert.equal(lines.filter((line) => line.kind === 'landing' && line.reason === 'landing refused').length, 1);
  assert.equal(lines.filter((line) => line.kind === 'landing' && line.outcome === 'recovered').length, 1);
  assert.equal(lines.filter((line) => line.kind === 'landing' && line.reason === refused.error).length, 1);
  assert.equal(lines.filter((line) => line.kind === 'exception').length, 2);
  assert.ok(!JSON.stringify(lines).includes(exceptionSecret));
});

test('decision contract rejects unknown fields and values outside its enums', () => {
  const line = { timestamp: '2026-10-11T12:00:00Z', projectId: 'repo', kind: 'landing', outcome: 'failed',
    workId: null, intentId: null, sessionId: null, attempt: null, durationMs: null, failureClass: 'landing', reason: 'landing refused' };
  assert.ok(FactoryDecisionLogLine.safeParse(line).success);
  for (const invalidFields of [{ unknown: true }, { kind: 'unknown' }, { outcome: 'unknown' }, { failureClass: 'unknown' }]) {
    assert.equal(FactoryDecisionLogLine.safeParse({ ...line, ...invalidFields }).success, false);
  }
});
