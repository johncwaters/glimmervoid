import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createVerificationWiring } from '../server/verification/verification-wiring.ts';
import { PANEL_MIN_CHANGED_LINES, VerificationRun, VerificationSettings } from '../shared/contracts/verification.ts';

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repoPath }).toString().trim();
}

function writeFiles(repoPath: string, contentByPath: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(contentByPath)) {
    fs.mkdirSync(path.dirname(path.join(repoPath, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(repoPath, relativePath), content);
  }
}

test('a turn end below the panel line threshold shows no panel until the session diff passes it, whatever the integration branch or an earlier check did, and check runs the done commands on demand', async (context) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-changed-lines-'));
  context.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  git(repoPath, ['init', '--quiet']);
  writeFiles(repoPath, { 'README.md': 'base\n' });
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '--quiet', '-m', 'base']);
  const baseSha = git(repoPath, ['rev-parse', 'HEAD']);
  const sessionBranch = git(repoPath, ['branch', '--show-current']);
  git(repoPath, ['checkout', '--quiet', '-b', 'integration']);
  writeFiles(repoPath, { 'landed.md': Array.from({ length: 30 }, (_, lineIndex) => `landed by another session ${lineIndex}`).join('\n') });
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '--quiet', '-m', 'landed elsewhere']);
  git(repoPath, ['checkout', '--quiet', sessionBranch]);
  const broadcastRuns: VerificationRun[] = [];
  let onTurnEnd = () => {};
  let treeNumber = 0;
  const verification = createVerificationWiring({
    getVerificationConfig: () => ({ repos: { [repoPath]: { checks: [{ id: 'node', command: 'node --version' }] } } }),
    isSessionSandboxOn: () => false,
    broadcastControl: (message) => { if (message.type === 'verification-run') broadcastRuns.push(VerificationRun.parse(message.run)); },
    logger: console,
  });
  verification.attachSession({
    id: 'changed-lines',
    path: repoPath,
    ephemeral: false,
    agentDoneLines: [{ text: 'node runs', command: 'node --version' }],
    hasOwnWorktree: true,
    worktreeDir: repoPath,
    on: (_event, listener) => { onTurnEnd = listener; },
    worktreeLifecycle: {
      computeGateTree: async () => ({ sig: `tree-${++treeNumber}`, dirty: true, headSha: baseSha }),
      snapshot: () => ({ baseSha, effectiveBase: 'integration' }),
      setMergeGate: () => {},
    },
  });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  writeFiles(repoPath, { 'README.md': 'base\nsmall\n' });
  const earlyCheck = await verification.checkNow('changed-lines', 10_000);
  assert.deepEqual(earlyCheck.ok ? earlyCheck.run?.checks.map((check) => `${check.id} ${check.status}`) : [], ['node pass', 'agent-done-1 pass']);
  onTurnEnd();
  await sleep(1000);
  assert.equal(broadcastRuns.length, 0, 'a small diff shows no panel, even after a check and with the integration branch moved on');
  writeFiles(repoPath, { 'README.md': Array.from({ length: PANEL_MIN_CHANGED_LINES + 1 }, (_, lineIndex) => `line ${lineIndex}`).join('\n') });
  onTurnEnd();
  await sleep(1500);
  assert.deepEqual(broadcastRuns.at(-1)?.checks.map((check) => `${check.id} ${check.status}`), ['node pass', 'agent-done-1 pass']);
  const checked = await verification.checkNow('changed-lines', 10_000);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.ok ? checked.run?.checks.map((check) => `${check.id} ${check.status}`) : [], ['node pass', 'agent-done-1 pass']);
  assert.deepEqual(await verification.checkNow('not-attached', 10_000), { ok: false, reason: 'this session has no worktree of its own, so there is nothing to check' });
});

test('the newest turn end decides the verdict: an unreadable tree shows skipped checks, a slower earlier run never overwrites it, and a readable turn shows its run again', async (context) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-unread-tree-'));
  context.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoPath, 'slow.js'), 'setTimeout(() => process.exit(1), 1500);\n');
  const broadcastRuns: VerificationRun[] = [];
  const gateTrees = [{ sig: 'turn-1', dirty: true, headSha: 'unused' }, null, { sig: 'turn-1', dirty: true, headSha: 'unused' }];
  let onTurnEnd = () => {};
  const verification = createVerificationWiring({
    getVerificationConfig: () => ({ repos: { [repoPath]: { checks: [{ id: 'slow', command: 'node slow.js' }] } } }),
    isSessionSandboxOn: () => false,
    broadcastControl: (message) => { if (message.type === 'verification-run') broadcastRuns.push(VerificationRun.parse(message.run)); },
    logger: console,
  });
  verification.attachSession({
    id: 'unread-tree',
    path: repoPath,
    ephemeral: false,
    agentDoneLines: [],
    hasOwnWorktree: true,
    worktreeDir: repoPath,
    on: (_event, listener) => { onTurnEnd = listener; },
    worktreeLifecycle: {
      computeGateTree: async () => gateTrees.shift() ?? null,
      snapshot: () => ({ baseSha: null, effectiveBase: null }),
      setMergeGate: () => {},
    },
  });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const shownVerdict = () => broadcastRuns.at(-1)?.checks.map((check) => check.status);

  onTurnEnd();
  await sleep(200);
  onTurnEnd();
  await sleep(3000);
  assert.deepEqual(shownVerdict(), ['skipped'], 'the earlier turn run finishing late does not replace the newer skipped verdict');
  assert.deepEqual(verification.latestRun('unread-tree')?.checks.map((check) => check.status), ['skipped'], 'a reopened panel gets the verdict last shown');
  onTurnEnd();
  await sleep(500);
  assert.deepEqual(shownVerdict(), ['fail'], 'a readable turn end on the same tree shows its cached run again');
});

test('an agent command runs at turn end with no operator step, reruns when changed, refuses a risky command however it arrived, and never fails the repo checks or takes a repo check id', async (context) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-agent-commands-'));
  context.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  git(repoPath, ['init', '--quiet']);
  writeFiles(repoPath, { 'README.md': 'base\n' });
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '--quiet', '-m', 'base']);
  const broadcastRuns: VerificationRun[] = [];
  let onTurnEnd = () => {};
  const verification = createVerificationWiring({
    getVerificationConfig: () => ({ repos: { [repoPath]: { checks: [{ id: 'node', command: 'node --version' }], gate: { enabled: true } } } }),
    isSessionSandboxOn: () => false,
    broadcastControl: (message) => { if (message.type === 'verification-run') broadcastRuns.push(VerificationRun.parse(message.run)); },
    logger: console,
  });
  assert.throws(() => VerificationSettings.parse({ checks: [{ id: 'agent-done-1', command: 'node --version' }] }));
  const session = {
    id: 'agent-commands',
    path: repoPath,
    ephemeral: false,
    agentDoneLines: [{ text: 'node runs', command: 'node --version' }],
    hasOwnWorktree: true,
    worktreeDir: repoPath,
    on: (_event: 'post-turn-check', listener: () => void) => { onTurnEnd = listener; },
    worktreeLifecycle: {
      computeGateTree: async () => ({ sig: 'tree', dirty: false, headSha: 'unused' }),
      snapshot: () => ({ baseSha: null, effectiveBase: null }),
      setMergeGate: () => {},
    },
  };
  verification.attachSession(session);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const shownAgentChecks = () => broadcastRuns.at(-1)?.checks.map((check) => `${check.id} ${check.status}`);

  onTurnEnd();
  await sleep(1500);
  assert.deepEqual(shownAgentChecks(), ['node pass', 'agent-done-1 pass']);
  session.agentDoneLines = [{ text: 'node fails', command: 'node --check missing-entry.js' }];
  onTurnEnd();
  await sleep(1500);
  assert.deepEqual(shownAgentChecks(), ['node pass', 'agent-done-1 fail']);
  assert.equal(broadcastRuns.at(-1)?.status, 'passed', 'a failing agent command leaves the repo checks passed');
  session.agentDoneLines = [{ text: 'restored from a saved session', command: 'git reset --hard HEAD' }];
  onTurnEnd();
  await sleep(1500);
  const refusedCheck = broadcastRuns.at(-1)?.checks.find((check) => check.id === 'agent-done-1');
  assert.equal(refusedCheck?.status, 'fail');
  assert.match(refusedCheck?.outputTail ?? '', /Sane YOLO refused to run it/);
});

test('a built-in check gates a merge with no verification entry in config.json, judges the commit that lands afresh at every merge, and a passing one lets the merge through', async (context) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-built-in-gate-'));
  context.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  git(repoPath, ['init', '--quiet']);
  writeFiles(repoPath, { 'README.md': 'base\n' });
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '--quiet', '-m', 'base']);
  const headSha = git(repoPath, ['rev-parse', 'HEAD']);
  let builtInStatus: 'pass' | 'fail' = 'fail';
  let builtInFreshness = 'board@1';
  const judgedCommits: (string | null)[] = [];
  const installed: { mergeGate: ((tree: { sig: string; dirty: boolean; headSha: string | null } | null) => Promise<{ allowed: boolean; reason?: string }>) | null } = { mergeGate: null };
  const verification = createVerificationWiring({
    getVerificationConfig: () => ({}),
    builtInChecks: {
      outcomesOf: async (_session, commitSha) => { judgedCommits.push(commitSha); return [{ id: 'codemap', command: 'codemap check (built in)', status: builtInStatus, exitCode: null, outputTail: 'adds module imports the operator has not allowed: lib -> tools' }]; },
      requiredIdsOf: async () => ['codemap'],
      freshnessOf: () => builtInFreshness,
    },
    isSessionSandboxOn: () => true,
    broadcastControl: () => {},
    logger: console,
  });
  verification.attachSession({
    id: 'built-in-gate',
    path: repoPath,
    ephemeral: false,
    agentDoneLines: [],
    hasOwnWorktree: true,
    worktreeDir: repoPath,
    on: () => {},
    worktreeLifecycle: {
      computeGateTree: async () => ({ sig: 'tree-fail', dirty: false, headSha }),
      snapshot: () => ({ baseSha: headSha, effectiveBase: null }),
      setMergeGate: (gate) => { installed.mergeGate = gate; },
    },
  });
  const checked = await verification.checkNow('built-in-gate', 10_000);
  assert.deepEqual(checked.ok ? checked.run?.checks.map((check) => `${check.id} ${check.status}`) : [], ['codemap fail'], 'the built-in check runs even with sessionSandbox on');
  const refused = await installed.mergeGate?.({ sig: 'tree-fail', dirty: false, headSha });
  assert.equal(refused?.allowed, false);
  assert.match(refused?.reason ?? '', /checks failed: codemap/);
  builtInStatus = 'pass';
  assert.deepEqual(await installed.mergeGate?.({ sig: 'tree-fail', dirty: false, headSha }), { allowed: true }, 'a merge judges the built-in check afresh, never from a run cached under the same tree');
  assert.deepEqual(judgedCommits, [null, headSha, headSha], 'session check judges the working tree, a merge judges the commit that lands');
  const cachedUnderSameTree = await verification.checkNow('built-in-gate', 10_000);
  assert.deepEqual(cachedUnderSameTree.ok ? cachedUnderSameTree.run?.checks.map((check) => `${check.id} ${check.status}`) : [], ['codemap fail'], 'session check reuses its run while neither the tree nor the built-in freshness moved');
  builtInFreshness = 'board@2';
  const rerunAfterBoardChange = await verification.checkNow('built-in-gate', 10_000);
  assert.deepEqual(rerunAfterBoardChange.ok ? rerunAfterBoardChange.run?.checks.map((check) => `${check.id} ${check.status}`) : [], ['codemap pass'], 'a built-in freshness change, such as a board edit, reruns session check under the same tree');
});
