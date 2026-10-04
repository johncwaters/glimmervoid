import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync } from '../server/child-process-safe.ts';
import { createMyPrMergeabilityFix, createMyPrsStateIo, sweepKeepMergeableLeftovers } from '../server/my-prs-wiring.ts';
import { createRepoCache } from '../server/repo-cache.ts';
import type { CommandResult } from '../server/repo-cache.ts';
import { KEEP_MERGEABLE_EXTRA_DENY_READ_PATHS, createTeamReviewSpawn, hooksPathPinnedSpawnEnv, keepMergeableSandbox, teamReviewSandbox, teamReviewSpawnEnv } from '../server/team-review-wiring.ts';
import type { TeamReviewSpawn } from '../server/team-review-wiring.ts';
import {
  KEEP_MERGEABLE_SANDBOX_STUB_NAMES, MY_PRS_FIX_BASE_BRANCH, MY_PRS_FIX_BOOTSTRAP_PROMPT, MY_PRS_FIX_CHECKOUT_DIRNAME, MY_PRS_FIX_ALLOW_RULES, MY_PRS_FIX_DENY_RULES, MY_PRS_FIX_PROMPT_FILENAME,
} from '../server/core/my-prs-core.ts';
import { LANE_ENVIRONMENT_ARGS } from '../server/core/lane-permissions-core.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';
import type { MyPr } from '../shared/contracts/my-prs.ts';

const GIT_IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function tryGit(args: string[], cwd: string): Promise<CommandResult> {
  try {
    return { ok: true, out: await git(args, cwd), err: '' };
  } catch (error) {
    return { ok: false, out: '', err: error instanceof Error ? error.message : String(error) };
  }
}

function conflictingPr(headRefOid = 'a'.repeat(40)): MyPr {
  return {
    key: 'Acme/app#7', repo: 'Acme/app', number: 7, title: 'Fix', url: 'https://github.com/Acme/app/pull/7',
    isDraft: false, state: 'OPEN', createdAt: '', mergedAt: null, updatedAt: '', baseRefName: 'main', headRefName: 'fix/checks',
    isCrossRepository: false, headRefOid, isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY', reviewDecision: null, checks: { state: 'FAILURE', failing: ['lint'], pendingCount: 0 },
    unresolvedThreads: 0, threads: [], behindBy: 1, reviewRequests: [], approvals: 0, reviews: [], stage: 'conflicts', keepMergeable: true,
  };
}

async function conflictingOrigin(root: string): Promise<{ originDir: string; headSha: string }> {
  const originDir = path.join(root, 'origin.git');
  const sourceDir = path.join(root, 'source');
  await git(['init', '--bare', originDir], root);
  await git(['config', 'uploadpack.allowFilter', 'true'], originDir);
  await git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], originDir);
  await git(['init', sourceDir], root);
  await fs.mkdir(path.join(sourceDir, '.github', 'workflows'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  await fs.writeFile(path.join(sourceDir, 'shared.txt'), 'start\n');
  await git(['add', '-A'], sourceDir);
  await git(['commit', '-m', 'start'], sourceDir);
  await git(['branch', '-M', 'main'], sourceDir);
  await git(['checkout', '-b', 'fix/checks'], sourceDir);
  await fs.writeFile(path.join(sourceDir, 'shared.txt'), 'pull request\n');
  await git(['commit', '-am', 'pull request'], sourceDir);
  const headSha = await git(['rev-parse', 'HEAD'], sourceDir);
  await git(['checkout', 'main'], sourceDir);
  await fs.writeFile(path.join(sourceDir, 'shared.txt'), 'base moved\n');
  await git(['commit', '-am', 'base moved'], sourceDir);
  await git(['push', originDir, 'main:refs/heads/main', `${headSha}:refs/heads/fix/checks`, `${headSha}:refs/pull/7/head`], sourceDir);
  return { originDir, headSha };
}

async function resolveConflictAndCommit(checkoutPath: string, extraFile: string | null = null): Promise<void> {
  await tryGit(['merge', MY_PRS_FIX_BASE_BRANCH, '-m', 'merge base'], checkoutPath);
  await fs.writeFile(path.join(checkoutPath, 'shared.txt'), 'pull request and base moved\n');
  if (extraFile) {
    await fs.mkdir(path.dirname(path.join(checkoutPath, extraFile)), { recursive: true });
    await fs.writeFile(path.join(checkoutPath, extraFile), 'on: push\njobs: {}\n');
  }
  await git(['add', '-A'], checkoutPath);
  await git(['commit', '--no-edit', '-m', 'merge base'], checkoutPath);
}

async function fixHarness(root: string, { spawnSession, timeoutSeconds, setTimeoutFn, beforeGit = () => {} }: {
  spawnSession: TeamReviewSpawn;
  timeoutSeconds?: number;
  setTimeoutFn?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  beforeGit?: (args: string[]) => void;
}) {
  const { originDir, headSha } = await conflictingOrigin(root);
  const workRoot = path.join(root, 'work');
  const cacheRoot = path.join(root, 'cache');
  const repoCache = createRepoCache({ rootDir: cacheRoot, remoteUrlFor: () => `file://${originDir}` });
  const pushes: string[][] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const glimmervoidHome = path.join(root, 'glimmervoid-home');
  const fix = createMyPrMergeabilityFix({
    spawnSession, repoCache, workRoot, glimmervoidHome, timeoutSeconds, setTimeoutFn,
    log: { log: (message: string) => { logs.push(message); }, warn: (message: string) => { warnings.push(message); } },
    runGit: async (args, cwd) => {
      beforeGit(args);
      if (args[0] !== 'push') return tryGit(args, cwd);
      pushes.push(args);
      return tryGit(args.map((arg) => (arg === 'https://github.com/Acme/app.git' ? originDir : arg)), cwd);
    },
  });
  const cachedRepo = path.join(cacheRoot, 'Acme', 'app');
  return { fix, pushes, logs, warnings, workRoot, headSha, cachedRepo, repoCache, glimmervoidHome, originDir };
}

async function remoteRefs(originDir: string): Promise<Map<string, string>> {
  const listed = await git(['for-each-ref', '--format=%(refname) %(objectname)'], originDir);
  return new Map(listed.split('\n').filter(Boolean).map((line) => line.split(' ') as [string, string]));
}

test('My PRs state uses the existing atomic store and survives a new state IO instance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-state-'));
  try {
    const statePath = path.join(root, 'my-prs-state.json');
    const state = { keepMergeableKeys: ['Acme/app#7'], keepMergeableAttemptKeys: [`Acme/app#7@${'a'.repeat(40)}`] };
    const stateIo = createMyPrsStateIo(statePath, { warn() {} });
    assert.deepEqual(await stateIo.readState(), { keepMergeableKeys: [], keepMergeableAttemptKeys: [] });
    await stateIo.writeState(state);
    assert.deepEqual(await stateIo.readState(), state);
    assert.deepEqual(await createMyPrsStateIo(statePath, { warn() {} }).readState(), state);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')), state);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('My PRs state quarantines malformed saved flags and adopts no flags', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-invalid-'));
  const warnings: string[] = [];
  try {
    const statePath = path.join(root, 'my-prs-state.json');
    await fs.writeFile(statePath, JSON.stringify({ keepMergeableKeys: ['Acme/app#7'], keepMergeableAttemptKeys: ['bad'] }));
    const stateIo = createMyPrsStateIo(statePath, { warn: (message: string) => { warnings.push(message); } });
    assert.deepEqual(await stateIo.readState(), { keepMergeableKeys: [], keepMergeableAttemptKeys: [] });
    assert.ok(warnings.some((warning) => warning.includes('quarantined')));
    assert.equal((await fs.readdir(root)).length, 1);
    assert.notEqual((await fs.readdir(root))[0], 'my-prs-state.json');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable runs sandboxed with the review posture and the server fast-forwards the PR branch to the session commit and nothing else', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-'));
  const createdSessions: SessionOptions[] = [];
  const recordedLanes: string[] = [];
  const promptBodies: string[] = [];
  const reviewSessions = new Map<string, unknown>();
  const spawnSession = createTeamReviewSpawn({
    reviewSessions, closeSessionDataClients: () => {}, hookRouter: null, getHookPort: null,
    spawnGate: { run: async (task) => task() }, laneName: 'my-prs',
    recordLane: (_id, lane) => { recordedLanes.push(lane); },
    makeSession: (options) => {
      createdSessions.push(options);
      const session = new Session(options);
      session.start = async () => {
        promptBodies.push(await fs.readFile(path.join(options.path, MY_PRS_FIX_PROMPT_FILENAME), 'utf8'));
        await resolveConflictAndCommit(path.join(options.path, MY_PRS_FIX_CHECKOUT_DIRNAME));
        session.emit('claude-session-id', { id: 'fix-session' });
        session.emit('exit');
      };
      return session;
    },
  });
  try {
    const harness = await fixHarness(root, { spawnSession });
    const pr = conflictingPr(harness.headSha);
    const remoteRefsBefore = await remoteRefs(harness.originDir);
    const recordedPushedShas: string[] = [];
    await harness.fix(pr, new AbortController().signal, () => {}, () => pr, (pushedSha) => { recordedPushedShas.push(pushedSha); });
    assert.equal(createdSessions.length, 1);
    const workDir = createdSessions[0].path;
    assert.match(createdSessions[0].id, /^my-prs:/);
    assert.ok(workDir.startsWith(harness.workRoot));
    assert.equal(createdSessions[0].initialPrompt, MY_PRS_FIX_BOOTSTRAP_PROMPT);
    assert.deepEqual(createdSessions[0].settingsSandbox, keepMergeableSandbox(workDir, { glimmervoidHome: harness.glimmervoidHome, cachedClone: harness.cachedRepo }));
    assert.deepEqual(createdSessions[0].spawnEnv, { ...teamReviewSpawnEnv(workDir), GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '' });
    assert.deepEqual(createdSessions[0].spawnEnv, hooksPathPinnedSpawnEnv(workDir));
    assert.deepEqual(createdSessions[0].settingsPermissions, { deny: [...MY_PRS_FIX_DENY_RULES], defaultMode: 'acceptEdits' });
    assert.equal(createdSessions[0].dangerouslySkipPermissions, false, 'the skip flag would override the acceptEdits boundary');
    for (const rule of ['Bash(git push:*)', 'Bash(gh:*)', 'Edit(**/.github/workflows/**)', 'Edit(**/.git/**)', 'Write(**/.git/**)', 'Edit(**/.claude/**)', 'Write(**/.claude/**)']) assert.ok(MY_PRS_FIX_DENY_RULES.includes(rule), rule);
    assert.deepEqual(createdSessions[0].extraClaudeArgs, ['-p', '--allowedTools', ...MY_PRS_FIX_ALLOW_RULES, '--disallowedTools', ...MY_PRS_FIX_DENY_RULES, ...LANE_ENVIRONMENT_ARGS]);
    assert.equal(createdSessions[0].ephemeral, true);
    assert.match(promptBodies[0], /Do not push and do not merge/);
    assert.deepEqual(recordedLanes, ['my-prs']);
    assert.equal(reviewSessions.size, 0);
    assert.equal(harness.pushes.length, 1);
    const [pushCommand, ...pushArgs] = harness.pushes[0];
    assert.equal(pushCommand, 'push');
    assert.deepEqual(pushArgs.filter((arg) => arg.startsWith('--force') || arg === '-f' || arg.includes('+')), [`--force-with-lease=refs/heads/fix/checks:${harness.headSha}`], pushArgs.join(' '));
    assert.ok(pushArgs.includes('--no-verify'));
    assert.ok(pushArgs.includes('https://github.com/Acme/app.git'));
    const refspec = pushArgs.at(-1) ?? '';
    assert.match(refspec, /^[0-9a-f]{40}:refs\/heads\/fix\/checks$/);
    const pushedSha = refspec.split(':')[0];
    assert.notEqual(pushedSha, harness.headSha);
    assert.equal((await tryGit(['merge-base', '--is-ancestor', harness.headSha, pushedSha], harness.cachedRepo)).ok, true);
    assert.equal(await git(['for-each-ref', 'refs/glimmervoid-keep-mergeable/'], harness.cachedRepo), '');
    assert.ok(harness.logs.some((line) => line.includes(pushedSha) && line.includes('fix/checks')), harness.logs.join('\n'));
    const remoteRefsAfter = await remoteRefs(harness.originDir);
    assert.deepEqual([...remoteRefsAfter.keys()].sort(), [...remoteRefsBefore.keys()].sort(), 'the push creates no new remote ref');
    assert.equal(remoteRefsAfter.get('refs/heads/fix/checks'), pushedSha);
    assert.deepEqual(recordedPushedShas, [pushedSha]);
    assert.equal(await git(['rev-list', '--count', pushedSha, '--not', harness.headSha, 'refs/heads/main'], harness.originDir), '1');
    assert.equal(await git(['rev-parse', `${pushedSha}^1`], harness.originDir), harness.headSha);
    for (const [refName, sha] of remoteRefsBefore) {
      if (refName !== 'refs/heads/fix/checks') assert.equal(remoteRefsAfter.get(refName), sha, refName);
    }
    assert.deepEqual(await fs.readdir(harness.workRoot), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable excludes sandbox stub files from the checkout so a git add -A never pushes them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-stubs-'));
  const spawnSession = createTeamReviewSpawn({
    reviewSessions: new Map(), closeSessionDataClients: () => {}, hookRouter: null, getHookPort: null,
    spawnGate: { run: async (task) => task() }, laneName: 'my-prs', recordLane: () => {},
    makeSession: (options) => {
      const session = new Session(options);
      session.start = async () => {
        const checkoutPath = path.join(options.path, MY_PRS_FIX_CHECKOUT_DIRNAME);
        for (const stubName of KEEP_MERGEABLE_SANDBOX_STUB_NAMES) {
          const stubPath = path.join(checkoutPath, stubName.endsWith('/') ? `${stubName}stub` : stubName);
          await fs.mkdir(path.dirname(stubPath), { recursive: true });
          await fs.writeFile(stubPath, '');
        }
        await resolveConflictAndCommit(checkoutPath);
        session.emit('exit');
      };
      return session;
    },
  });
  try {
    const harness = await fixHarness(root, { spawnSession });
    await harness.fix(conflictingPr(harness.headSha), new AbortController().signal);
    assert.equal(harness.pushes.length, 1);
    const pushedSha = (harness.pushes[0].at(-1) ?? '').split(':')[0];
    const pushedFiles = (await git(['ls-tree', '-r', '--name-only', pushedSha], harness.cachedRepo)).split('\n');
    assert.deepEqual(pushedFiles.sort(), ['.github/workflows/ci.yml', 'shared.txt']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable refuses to push a session commit that adds a workflow file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-workflow-'));
  try {
    const harness = await fixHarness(root, {
      spawnSession: async ({ cwd }) => { await resolveConflictAndCommit(path.join(cwd, MY_PRS_FIX_CHECKOUT_DIRNAME), '.github/workflows/exfiltrate.yml'); },
    });
    await harness.fix(conflictingPr(harness.headSha), new AbortController().signal);
    assert.deepEqual(harness.pushes, []);
    assert.ok(harness.warnings.some((warning) => warning.includes('.github/workflows/exfiltrate.yml')));
    assert.equal(await git(['rev-parse', 'refs/heads/fix/checks'], harness.originDir), harness.headSha);
    assert.deepEqual(await fs.readdir(harness.workRoot), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable refuses to push a session commit that adds a credential-like file and cleans its handoff ref', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-credential-'));
  try {
    const harness = await fixHarness(root, {
      spawnSession: async ({ cwd }) => { await resolveConflictAndCommit(path.join(cwd, MY_PRS_FIX_CHECKOUT_DIRNAME), 'deploy/.env.production'); },
    });
    await harness.fix(conflictingPr(harness.headSha), new AbortController().signal);
    assert.deepEqual(harness.pushes, []);
    assert.ok(harness.warnings.some((warning) => warning.includes('deploy/.env.production') && warning.includes('credential')), harness.warnings.join('\n'));
    assert.equal(await git(['for-each-ref', 'refs/glimmervoid-keep-mergeable/'], harness.cachedRepo), '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable logs a PR branch that moved since staging as a rejected push and never retries or forces it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-moved-'));
  const steps: string[] = [];
  let movedSha = '';
  const sourceDir = path.join(root, 'source');
  try {
    const harness = await fixHarness(root, {
      spawnSession: async ({ cwd }) => {
        await resolveConflictAndCommit(path.join(cwd, MY_PRS_FIX_CHECKOUT_DIRNAME));
        await git(['checkout', 'fix/checks'], sourceDir);
        await fs.writeFile(path.join(sourceDir, 'later.txt'), 'pushed while the repair ran\n');
        await git(['add', '-A'], sourceDir);
        await git(['commit', '-m', 'later'], sourceDir);
        movedSha = await git(['rev-parse', 'HEAD'], sourceDir);
        await git(['push', path.join(root, 'origin.git'), 'fix/checks:refs/heads/fix/checks'], sourceDir);
      },
      beforeGit: (args) => { steps.push(args[0]); },
    });
    const recordedPushedShas: string[] = [];
    const pr = conflictingPr(harness.headSha);
    await harness.fix(pr, new AbortController().signal, () => { steps.push('push started'); }, () => pr, (pushedSha) => { recordedPushedShas.push(pushedSha); });
    assert.deepEqual(recordedPushedShas, []);
    assert.equal(harness.pushes.length, 1);
    assert.ok(!harness.pushes[0].some((arg) => arg === '--force' || arg === '-f' || arg.startsWith('+')), harness.pushes[0].join(' '));
    assert.equal(steps.filter((step) => step === 'push').length, 1);
    assert.ok(steps.includes('push started'), 'the attempt stays recorded so this head is not retried');
    assert.ok(harness.warnings.some((warning) => warning.includes('moved since the repair was staged') && warning.includes('not retried')), harness.warnings.join('\n'));
    assert.deepEqual(harness.logs, []);
    assert.equal(await git(['rev-parse', 'refs/heads/fix/checks'], harness.originDir), movedSha);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable refuses to push over a PR branch rewound to an ancestor during the repair and keeps the rewound sha', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-rewound-'));
  const steps: string[] = [];
  let rewoundSha = '';
  const sourceDir = path.join(root, 'source');
  try {
    const harness = await fixHarness(root, {
      spawnSession: async ({ cwd }) => {
        await resolveConflictAndCommit(path.join(cwd, MY_PRS_FIX_CHECKOUT_DIRNAME));
        rewoundSha = await git(['rev-parse', 'fix/checks^1'], sourceDir);
        await git(['push', '--force', path.join(root, 'origin.git'), `${rewoundSha}:refs/heads/fix/checks`], sourceDir);
      },
      beforeGit: (args) => { steps.push(args[0]); },
    });
    await harness.fix(conflictingPr(harness.headSha), new AbortController().signal, () => { steps.push('push started'); });
    assert.equal(harness.pushes.length, 1);
    assert.equal(steps.filter((step) => step === 'push').length, 1);
    assert.ok(steps.includes('push started'), 'the attempt stays recorded so this head is not retried');
    assert.ok(harness.warnings.some((warning) => warning.includes('moved since the repair was staged') && warning.includes('not retried')), harness.warnings.join('\n'));
    assert.deepEqual(harness.logs, []);
    assert.equal(await git(['rev-parse', 'refs/heads/fix/checks'], harness.originDir), rewoundSha);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable never repairs or pushes a pull request from a fork', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-fork-'));
  let spawnCount = 0;
  try {
    const harness = await fixHarness(root, { spawnSession: async () => { spawnCount += 1; } });
    const forkPr = { ...conflictingPr(harness.headSha), isCrossRepository: true };
    await harness.fix(forkPr, new AbortController().signal, () => {}, () => forkPr);
    assert.equal(spawnCount, 0);
    assert.deepEqual(harness.pushes, []);
    assert.ok(harness.warnings.some((warning) => warning.includes('fork')), harness.warnings.join('\n'));
    assert.equal(await git(['rev-parse', 'refs/heads/fix/checks'], harness.originDir), harness.headSha);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable never pushes when the live list shows the pull request closed or merged by the time the repair finishes', async () => {
  for (const state of ['CLOSED', 'MERGED'] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-closed-'));
    let hasRepairFinished = false;
    try {
      const harness = await fixHarness(root, {
        spawnSession: async ({ cwd }) => {
          await resolveConflictAndCommit(path.join(cwd, MY_PRS_FIX_CHECKOUT_DIRNAME));
          hasRepairFinished = true;
        },
      });
      const pr = conflictingPr(harness.headSha);
      await harness.fix(pr, new AbortController().signal, () => {}, () => (hasRepairFinished ? { ...pr, state } : pr));
      assert.equal(hasRepairFinished, true);
      assert.deepEqual(harness.pushes, [], state);
      assert.ok(harness.warnings.some((warning) => warning.includes(state.toLowerCase())), harness.warnings.join('\n'));
      assert.equal(await git(['rev-parse', 'refs/heads/fix/checks'], harness.originDir), harness.headSha);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('keep mergeable refuses to push a session commit that edits a local composite action under .github', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-action-'));
  try {
    const harness = await fixHarness(root, {
      spawnSession: async ({ cwd }) => { await resolveConflictAndCommit(path.join(cwd, MY_PRS_FIX_CHECKOUT_DIRNAME), '.github/actions/setup/action.yml'); },
    });
    await harness.fix(conflictingPr(harness.headSha), new AbortController().signal);
    assert.deepEqual(harness.pushes, []);
    assert.ok(harness.warnings.some((warning) => warning.includes('.github/actions/setup/action.yml')), harness.warnings.join('\n'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function repairAbortedAtGitStep(root: string, abortingGitStep: string) {
  const repairController = new AbortController();
  const steps: string[] = [];
  const harness = await fixHarness(root, {
    spawnSession: async ({ cwd }) => { await resolveConflictAndCommit(path.join(cwd, MY_PRS_FIX_CHECKOUT_DIRNAME)); },
    beforeGit: (args) => {
      steps.push(args[0]);
      if (args[0] === abortingGitStep) repairController.abort();
    },
  });
  await harness.fix(conflictingPr(harness.headSha), repairController.signal, () => { steps.push('push started'); });
  return { steps, pushes: harness.pushes };
}

test('keep mergeable reports the hand-off push as started before an abort lands during the push', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-abort-push-'));
  try {
    const { steps, pushes } = await repairAbortedAtGitStep(root, 'push');
    assert.equal(pushes.length, 1);
    assert.deepEqual(steps.filter((step) => step === 'push started' || step === 'push'), ['push started', 'push']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable reports the hand-off push as started when an abort lands during the cleanup after the push', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-abort-cleanup-'));
  try {
    const { steps, pushes } = await repairAbortedAtGitStep(root, 'update-ref');
    assert.equal(pushes.length, 1);
    assert.deepEqual(steps.filter((step) => step === 'push started' || step === 'push' || step === 'update-ref'), ['push started', 'push', 'update-ref']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable never reports the hand-off push as started when an abort lands before the push', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-abort-before-push-'));
  try {
    const { steps, pushes } = await repairAbortedAtGitStep(root, 'fetch');
    assert.deepEqual(pushes, []);
    assert.ok(steps.includes('fetch'));
    assert.ok(!steps.includes('push started'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the keep mergeable start sweep deletes leftover work folders and handoff refs and keeps other refs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-sweep-'));
  try {
    const harness = await fixHarness(root, { spawnSession: async () => {} });
    assert.ok(await harness.repoCache.ensureRepo('Acme/app'));
    await git(['update-ref', 'refs/glimmervoid-keep-mergeable/7-left-behind', harness.headSha], harness.cachedRepo);
    await git(['update-ref', 'refs/glimmervoid-keep-mergeable/8-left-behind', harness.headSha], harness.cachedRepo);
    await git(['update-ref', 'refs/heads/keep-me', harness.headSha], harness.cachedRepo);
    const leftoverWorkDir = path.join(harness.workRoot, 'glimmervoid-wt-team-review-Acme-app-7-abc');
    await fs.mkdir(path.join(leftoverWorkDir, MY_PRS_FIX_CHECKOUT_DIRNAME), { recursive: true });
    const reapedRoots: string[][] = [];
    const prunedClones: string[] = [];
    await sweepKeepMergeableLeftovers({
      workRoot: harness.workRoot, repoCache: harness.repoCache, log: { warn() {} },
      reapProcesses: async ({ reviewRoots, scope }) => { assert.equal(scope, 'sweep'); reapedRoots.push([...reviewRoots]); },
      gitWorkspace: { pruneWorktrees: async ({ projectPath }) => { prunedClones.push(projectPath); return { ok: true }; } },
    });
    assert.deepEqual(await fs.readdir(harness.workRoot), []);
    assert.equal(await git(['for-each-ref', 'refs/glimmervoid-keep-mergeable/'], harness.cachedRepo), '');
    assert.equal(await git(['rev-parse', 'refs/heads/keep-me'], harness.cachedRepo), harness.headSha);
    assert.deepEqual(reapedRoots, [[harness.workRoot, harness.workRoot]]);
    assert.deepEqual(prunedClones, [harness.cachedRepo]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the keep mergeable start sweep tolerates a missing work root and an empty clone cache', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-sweep-empty-'));
  try {
    await sweepKeepMergeableLeftovers({
      workRoot: path.join(root, 'missing'), repoCache: { listRepos: async () => [] }, log: { warn() {} },
      reapProcesses: async () => {}, gitWorkspace: { pruneWorktrees: async () => ({ ok: true }) },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable refuses a workflow file whose name git would print C-quoted', async () => {
  for (const workflowName of ['\u00e9.yml', 'tab\there.yml', '"quoted".yml']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-quoted-workflow-'));
    try {
      const harness = await fixHarness(root, {
        spawnSession: async ({ cwd }) => { await resolveConflictAndCommit(path.join(cwd, MY_PRS_FIX_CHECKOUT_DIRNAME), `.github/workflows/${workflowName}`); },
      });
      await harness.fix(conflictingPr(harness.headSha), new AbortController().signal);
      assert.deepEqual(harness.pushes, [], workflowName);
      assert.ok(harness.warnings.some((warning) => warning.includes(`.github/workflows/${workflowName}`)), harness.warnings.join('\n'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('the keep mergeable sandbox hides operator credential and config homes from Bash but re-opens its own work dir and cached clone', () => {
  const sandbox = keepMergeableSandbox('/home/op/.glimmervoid/my-prs-work/wt', { glimmervoidHome: '/srv/glimmervoid', cachedClone: '/home/op/.glimmervoid/team-review-repos/Acme/app' });
  for (const deniedPath of ['~/.ssh', '~/.config/gh', '~/.git-credentials', '~/.claude', '~/.codex', '~/.grok', '~/.glimmervoid', '~/.aws', '~/.gnupg', '~/.config', '~/.npmrc', '~/.netrc', '~/.docker', '~/.kube', '/srv/glimmervoid']) {
    assert.ok(sandbox.filesystem.denyRead.includes(deniedPath), deniedPath);
  }
  for (const deniedPath of KEEP_MERGEABLE_EXTRA_DENY_READ_PATHS) assert.ok(sandbox.filesystem.denyRead.includes(deniedPath), deniedPath);
  assert.equal(new Set(sandbox.filesystem.denyRead).size, sandbox.filesystem.denyRead.length);
  assert.deepEqual(sandbox.filesystem.allowRead, ['/home/op/.glimmervoid/my-prs-work/wt', '/home/op/.glimmervoid/team-review-repos/Acme/app']);
  assert.deepEqual(sandbox.filesystem.allowWrite, ['/home/op/.glimmervoid/my-prs-work/wt'], 'a denied ~/.codex is never writable');
  assert.deepEqual(teamReviewSandbox('/work/dir').filesystem.denyRead, ['~/.ssh', '~/.config/gh', '~/Library/Keychains', '~/.git-credentials']);
});

test('the keep mergeable sandbox reaches no GitHub domain and opens no unix socket while the review sandbox stays as it was', () => {
  const sandbox = keepMergeableSandbox('/work/dir', { glimmervoidHome: '/home/op/.glimmervoid', cachedClone: '/clone' });
  const reviewSandbox = teamReviewSandbox('/work/dir');
  assert.equal(sandbox.network.allowAllUnixSockets, false);
  assert.equal(sandbox.network.strictAllowlist, true);
  assert.deepEqual(sandbox.network.allowedDomains.filter((domain) => /github/i.test(domain)), []);
  assert.deepEqual(sandbox.network.allowedDomains, reviewSandbox.network.allowedDomains.filter((domain) => !/github/i.test(domain)));
  assert.equal(sandbox.failIfUnavailable, true);
  assert.equal(sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(sandbox.filesystem.denyWrite, reviewSandbox.filesystem.denyWrite);
  assert.equal(reviewSandbox.network.allowAllUnixSockets, true);
  assert.ok(reviewSandbox.network.allowedDomains.includes('api.github.com'));
});

test('keep mergeable aborts a session past its deadline and pushes nothing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-deadline-'));
  let sessionSignal: AbortSignal | null = null;
  try {
    const harness = await fixHarness(root, {
      timeoutSeconds: 1,
      setTimeoutFn: (callback) => setTimeout(callback, 0),
      spawnSession: async ({ cwd, signal }) => {
        sessionSignal = signal;
        await resolveConflictAndCommit(path.join(cwd, MY_PRS_FIX_CHECKOUT_DIRNAME));
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    });
    await harness.fix(conflictingPr(harness.headSha), new AbortController().signal);
    assert.equal((sessionSignal as AbortSignal | null)?.aborted, true);
    assert.deepEqual(harness.pushes, []);
    assert.ok(harness.warnings.some((warning) => warning.includes('deadline')));
    assert.deepEqual(await fs.readdir(harness.workRoot), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable stops a session when its dispatch is cancelled and pushes nothing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-cancel-'));
  const cancel = new AbortController();
  try {
    const harness = await fixHarness(root, {
      spawnSession: async ({ cwd, signal }) => {
        await resolveConflictAndCommit(path.join(cwd, MY_PRS_FIX_CHECKOUT_DIRNAME));
        cancel.abort();
        assert.equal(signal.aborted, true);
      },
    });
    await harness.fix(conflictingPr(harness.headSha), cancel.signal);
    assert.deepEqual(harness.pushes, []);
    assert.deepEqual(await fs.readdir(harness.workRoot), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable aborted while reading the session commit pushes nothing and cleans its work folder', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-abort-handoff-'));
  const cancel = new AbortController();
  try {
    const harness = await fixHarness(root, {
      spawnSession: async ({ cwd }) => { await resolveConflictAndCommit(path.join(cwd, MY_PRS_FIX_CHECKOUT_DIRNAME)); },
      beforeGit: (args) => { if (args[0] === 'fetch') cancel.abort(); },
    });
    await harness.fix(conflictingPr(harness.headSha), cancel.signal);
    assert.equal(cancel.signal.aborted, true);
    assert.deepEqual(harness.pushes, []);
    assert.deepEqual(harness.warnings, []);
    assert.equal(await git(['for-each-ref', 'refs/glimmervoid-keep-mergeable/'], harness.cachedRepo), '');
    assert.deepEqual(await fs.readdir(harness.workRoot), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable aborted while staging the checkout never spawns and cleans its work folder', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-abort-stage-'));
  const cancel = new AbortController();
  let spawnCount = 0;
  try {
    const harness = await fixHarness(root, {
      spawnSession: async () => { spawnCount += 1; },
      beforeGit: (args) => { if (args[0] === 'clone') cancel.abort(); },
    });
    await harness.fix(conflictingPr(harness.headSha), cancel.signal);
    assert.equal(spawnCount, 0);
    assert.deepEqual(harness.pushes, []);
    assert.deepEqual(harness.warnings, []);
    assert.deepEqual(await fs.readdir(harness.workRoot), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keep mergeable cleanup runs after a failed spawn and an aborted dispatch creates no directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'my-prs-fix-failed-'));
  let spawnCount = 0;
  try {
    const harness = await fixHarness(root, { spawnSession: async () => { spawnCount += 1; throw new Error('Spawn failed'); } });
    await assert.rejects(harness.fix(conflictingPr(harness.headSha), new AbortController().signal), /Spawn failed/);
    assert.deepEqual(await fs.readdir(harness.workRoot), []);
    const controller = new AbortController();
    controller.abort();
    await harness.fix(conflictingPr(harness.headSha), controller.signal);
    assert.equal(spawnCount, 1);
    assert.deepEqual(await fs.readdir(harness.workRoot), []);
    assert.deepEqual(harness.pushes, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
