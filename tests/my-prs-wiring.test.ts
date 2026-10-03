import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync } from '../server/child-process-safe.ts';
import { createMyPrMergeabilityFix, createMyPrsStateIo } from '../server/my-prs-wiring.ts';
import { createRepoCache } from '../server/repo-cache.ts';
import type { CommandResult } from '../server/repo-cache.ts';
import { createTeamReviewSpawn, keepMergeableSandbox, teamReviewSandbox, teamReviewSpawnEnv } from '../server/team-review-wiring.ts';
import type { TeamReviewSpawn } from '../server/team-review-wiring.ts';
import {
  MY_PRS_FIX_BASE_BRANCH, MY_PRS_FIX_BOOTSTRAP_PROMPT, MY_PRS_FIX_CHECKOUT_DIRNAME, MY_PRS_FIX_DENY_RULES, MY_PRS_FIX_PROMPT_FILENAME,
} from '../server/core/my-prs-core.ts';
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
  const fix = createMyPrMergeabilityFix({
    spawnSession, repoCache, workRoot, timeoutSeconds, setTimeoutFn,
    log: { log: (message: string) => { logs.push(message); }, warn: (message: string) => { warnings.push(message); } },
    runGit: async (args, cwd) => {
      beforeGit(args);
      if (args[0] !== 'push') return tryGit(args, cwd);
      pushes.push(args);
      return { ok: true, out: '', err: '' };
    },
  });
  const cachedRepo = path.join(cacheRoot, 'Acme', 'app');
  return { fix, pushes, logs, warnings, workRoot, headSha, cachedRepo };
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

test('keep mergeable runs sandboxed with the review posture and the server pushes the session commit only to the review branch', async () => {
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
    await harness.fix(pr, new AbortController().signal);
    assert.equal(createdSessions.length, 1);
    const workDir = createdSessions[0].path;
    assert.match(createdSessions[0].id, /^my-prs:/);
    assert.ok(workDir.startsWith(harness.workRoot));
    assert.equal(createdSessions[0].initialPrompt, MY_PRS_FIX_BOOTSTRAP_PROMPT);
    assert.deepEqual(createdSessions[0].settingsSandbox, keepMergeableSandbox(workDir));
    assert.deepEqual(createdSessions[0].spawnEnv, teamReviewSpawnEnv(workDir));
    assert.deepEqual(createdSessions[0].settingsPermissions, { deny: [...MY_PRS_FIX_DENY_RULES], defaultMode: 'bypassPermissions' });
    for (const rule of ['Bash(git push:*)', 'Bash(gh:*)', 'Edit(**/.github/workflows/**)']) assert.ok(MY_PRS_FIX_DENY_RULES.includes(rule), rule);
    assert.deepEqual(createdSessions[0].extraClaudeArgs, ['-p', '--strict-mcp-config', '--disallowedTools', ...MY_PRS_FIX_DENY_RULES]);
    assert.equal(createdSessions[0].ephemeral, true);
    assert.match(promptBodies[0], /Do not push and do not merge/);
    assert.deepEqual(recordedLanes, ['my-prs']);
    assert.equal(reviewSessions.size, 0);
    assert.equal(harness.pushes.length, 1);
    const [pushCommand, ...pushArgs] = harness.pushes[0];
    assert.equal(pushCommand, 'push');
    assert.ok(!pushArgs.some((arg) => arg.startsWith('--force') || arg === '-f' || arg.includes('+')), pushArgs.join(' '));
    assert.ok(pushArgs.includes('https://github.com/Acme/app.git'));
    const refspec = pushArgs.at(-1) ?? '';
    assert.match(refspec, new RegExp(`^[0-9a-f]{40}:refs/heads/glimmervoid/keep-mergeable/7-${harness.headSha.slice(0, 8)}$`));
    assert.ok(!refspec.includes(pr.headRefName));
    const pushedSha = refspec.split(':')[0];
    assert.notEqual(pushedSha, harness.headSha);
    assert.equal((await tryGit(['merge-base', '--is-ancestor', harness.headSha, pushedSha], harness.cachedRepo)).ok, true);
    assert.equal(await git(['for-each-ref', 'refs/glimmervoid-keep-mergeable/'], harness.cachedRepo), '');
    assert.ok(harness.logs.some((line) => line.includes(`glimmervoid/keep-mergeable/7-${harness.headSha.slice(0, 8)}`)));
    assert.deepEqual(await fs.readdir(harness.workRoot), []);
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
    assert.deepEqual(await fs.readdir(harness.workRoot), []);
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

test('the keep mergeable sandbox reaches no GitHub domain and opens no unix socket while the review sandbox stays as it was', () => {
  const sandbox = keepMergeableSandbox('/work/dir');
  const reviewSandbox = teamReviewSandbox('/work/dir');
  assert.equal(sandbox.network.allowAllUnixSockets, false);
  assert.equal(sandbox.network.strictAllowlist, true);
  assert.deepEqual(sandbox.network.allowedDomains.filter((domain) => /github/i.test(domain)), []);
  assert.deepEqual(sandbox.network.allowedDomains, reviewSandbox.network.allowedDomains.filter((domain) => !/github/i.test(domain)));
  assert.equal(sandbox.failIfUnavailable, true);
  assert.equal(sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(sandbox.filesystem, reviewSandbox.filesystem);
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
