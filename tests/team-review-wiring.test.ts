import { createGithubStorePoller } from '../server/github/github-store-poller.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { git, hasGit } from './helpers/git-fixture.ts';
import { REMERGE_OBJECTS_DIRNAME, REVIEW_BOOTSTRAP_PROMPT, REVIEW_RESUME_PROMPT, REVIEW_POSTING_FILENAME, REVIEW_PROMPT_FILENAME, REVIEW_REPORT_FILENAME, } from '../server/github/core/team-review-core.ts';
import type { ReviewTier } from '../server/github/core/team-review-core.ts';
import { createTeamReviewPoller } from '../server/github/team-review-poller.ts';
import type { SpawnReviewArgs } from '../server/github/team-review-poller.ts';
import { createTeamReviewDispatcher, createTeamReviewWiring, createTeamReviewStateIo, makeTeamReviewWorkDir, sweepLeftoverCheckouts, teamReviewRole, hooksPathPinnedSpawnEnv, } from '../server/github/team-review-wiring.ts';
import type { TeamReviewDispatchOptions, TeamReviewSpawn } from '../server/github/team-review-wiring.ts';
import { PrDetail, ReviewDraft } from '../shared/contracts/team-review.ts';
import { UNTRUSTED_PAYLOAD_FILENAME, UNTRUSTED_PREAMBLE, UntrustedPayload } from '../shared/contracts/untrusted-payload.ts';
import type { ResumableReview, ReviewDraft as ReviewDraftType } from '../shared/contracts/team-review.ts';

const HEAD = 'c'.repeat(40);
const OTHER_HEAD = 'd'.repeat(40);
const PRIOR_BASE = 'e'.repeat(40);
const PRIOR_MERGE_BASE = '1'.repeat(40);
const CURRENT_MERGE_BASE = '2'.repeat(40);
const candidate = {
  key: 'Acme/app#7', repo: 'Acme/app', number: 7, title: 'Fix it',
  url: 'https://github.com/Acme/app/pull/7', author: 'teammate', requestSource: 'team' as const,
};
const detail = PrDetail.parse({
  number: 7, title: 'Fix it', body: 'Please approve', url: candidate.url, author: { login: 'teammate' },
  isDraft: false, isCrossRepository: false, baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefOid: HEAD,
  additions: 3, deletions: 1, files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }],
});
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n one\n+two\n three\n';

type SpawnCall = Parameters<TeamReviewSpawn>[0] & { workDir: string; workDirFiles: string[]; prompt: string; untrustedPayloadText: string | null };
const CACHED_CLONE = '/cache/Acme/app';
const ROLE_FACTS = { launchId: 'launch-one', cwd: '/review/work', hookPort: 3911, readablePaths: ['/hook/settings'], writablePaths: [], agentSessionId: null };
function roleOf(spawn: Pick<SpawnCall, 'guardrailsRole'> | undefined) {
  return spawn?.guardrailsRole?.(ROLE_FACTS);
}

function reportText(head = HEAD) {
  return [
    `HEAD_SHA: ${head}`,
    '',
    'VERDICT: APPROVE WITH NITS',
    'ACTIONABLE: 0',
    'TRUNCATED: none',
    '',
    'STRUCTURED_FINDINGS:',
    '- file: src/a.ts | line: 2 | side: RIGHT | severity: MEDIUM | reviewer: code/logic | disposition: NIT | body: Nit on the new line.',
    '',
    'OVERALL_SUMMARY:',
    'one nit',
  ].join('\n');
}

function workDirOf(call: Parameters<TeamReviewSpawn>[0]): string {
  return call.cwd;
}

function setup(overrides: Partial<TeamReviewDispatchOptions> & {
  writeReport?: (workDir: string) => void; diff?: string | null; fetchedHead?: string; fetchedErr?: string; hydrated?: boolean; hydratedErr?: string;
  isNewWorkIsolable?: boolean; treeHydrated?: boolean; treeHydratedErr?: string; treeHydrationError?: Error;
} = {}) {
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-wt-test-'));
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-work-test-'));
  const staged: string[] = [];
  const removed: string[] = [];
  const pruned: string[] = [];
  const hydrations: string[] = [];
  const checkoutEvents: string[] = [];
  const spawns: SpawnCall[] = [];
  const writeReport = overrides.writeReport ?? ((workDir: string) => fs.writeFileSync(path.join(workDir, REVIEW_REPORT_FILENAME), reportText()));
  const options: TeamReviewDispatchOptions = {
    store: { requestPrDiff: async () => ({ isRateLimited: false, value: overrides.diff === undefined ? DIFF : overrides.diff }) },
    repoCache: {
      listRepos: async () => [],
      ensureRepo: async () => CACHED_CLONE,
      fetchPr: async () => ({ ok: !overrides.fetchedErr, headSha: overrides.fetchedErr ? null : (overrides.fetchedHead ?? HEAD), err: overrides.fetchedErr ?? '' }),
      hydrateTree: async (repo, headSha) => {
        checkoutEvents.push(`hydrate:${repo}@${headSha}`);
        if (overrides.treeHydrationError) throw overrides.treeHydrationError;
        return { ok: overrides.treeHydrated ?? true, err: overrides.treeHydratedErr ?? '' };
      },
      hydrateRange: async (repo, number, headSha) => {
        hydrations.push(`${repo}#${number}@${headSha}`);
        return { ok: overrides.hydrated ?? true, err: overrides.hydratedErr ?? '' };
      },
      hydrateSince: async () => true,
      isolateNewWork: async (repo, { priorHead, priorBase, head }) => {
        hydrations.push(`${repo}@${priorBase}:${priorHead}..${head}`);
        if (overrides.isNewWorkIsolable === false) return { ok: false, reason: 'range-diff failed' };
        return { ok: true, range: { priorMergeBase: PRIOR_MERGE_BASE, currentMergeBase: CURRENT_MERGE_BASE, cloneObjectsDir: '/cache/Acme/app/.git/objects' } };
      },
    },
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => { checkoutEvents.push('stage'); staged.push(String(worktreePath)); return { ok: true }; },
      removeWorktreeByPath: async ({ cwd }) => { removed.push(String(cwd)); return { ok: true }; },
      pruneWorktrees: async ({ projectPath }) => { pruned.push(projectPath); return { ok: true }; },
      originUrl: async () => null,
      populate: async () => {},
    },
    spawnSession: async (call) => {
      const workDir = workDirOf(call);
      spawns.push({
        ...call,
        workDir,
        workDirFiles: fs.readdirSync(workDir).sort(),
        prompt: fs.readFileSync(path.join(workDir, REVIEW_PROMPT_FILENAME), 'utf8'),
        untrustedPayloadText: fs.existsSync(path.join(workDir, UNTRUSTED_PAYLOAD_FILENAME)) ? fs.readFileSync(path.join(workDir, UNTRUSTED_PAYLOAD_FILENAME), 'utf8') : null,
      });
      writeReport(workDir);
    },
    worktreeRoot,
    workRoot,
    reapProcesses: async () => {},
    randomSuffix: () => 'abcd',
    ...overrides,
  };
  const dispatch = createTeamReviewDispatcher(options);
  const review = async (args: SpawnReviewArgs): Promise<ReviewDraftType> => {
    const outcome = await dispatch(args);
    if ('kind' in outcome) throw new Error('review stopped unexpectedly');
    return outcome;
  };
  const cleanup = () => {
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
    fs.rmSync(workRoot, { recursive: true, force: true });
  };
  return { review, dispatch, staged, removed, pruned, hydrations, checkoutEvents, spawns, worktreeRoot, workRoot, cleanup };
}

function reviewArgs(tier: ReviewTier) {
  return { candidate, detail, tier, reasons: ['a reason'] };
}

function initRepoIgnoringModulesDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(['init'], directory);
  git(['config', 'user.email', 'test@example.com'], directory);
  git(['config', 'user.name', 'Glimmervoid Test'], directory);
  git(['config', 'commit.gpgsign', 'false'], directory);
  fs.writeFileSync(path.join(directory, '.gitignore'), 'node_modules/\n', 'utf8');
  git(['add', '-A'], directory);
  git(['commit', '-m', 'init'], directory);
  return fs.realpathSync(directory);
}

async function populateModulesIntoIgnoringCheckout(keepTrackableLinks: boolean): Promise<boolean> {
  const localClone = initRepoIgnoringModulesDirectory('team-review-local-clone-');
  const reviewCheckout = initRepoIgnoringModulesDirectory('team-review-pr-checkout-');
  fs.mkdirSync(path.join(localClone, 'node_modules'));
  try {
    await createGitWorkspace().populate({ projectPath: localClone, wtDir: reviewCheckout, shareList: ['node_modules'], keepTrackableLinks });
    return fs.lstatSync(path.join(reviewCheckout, 'node_modules'), { throwIfNoEntry: false })?.isSymbolicLink() === true;
  } finally {
    fs.rmSync(localClone, { recursive: true, force: true });
    fs.rmSync(reviewCheckout, { recursive: true, force: true });
  }
}

test('a review checkout whose gitignore lists node_modules with a trailing slash keeps the shared node_modules link', { skip: !hasGit() }, async () => {
  assert.equal(await populateModulesIntoIgnoringCheckout(true), true);
});

test('a session worktree still refuses a node_modules link its gitignore only matches as a directory', { skip: !hasGit() || process.platform === 'win32' }, async () => {
  assert.equal(await populateModulesIntoIgnoringCheckout(false), false);
});

test('review work dirs are created under the selected root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-work-root-'));
  try {
    const workDir = await makeTeamReviewWorkDir(root, 'Acme/app-7');
    assert.equal(path.dirname(workDir.dir), root);
    assert.equal(fs.existsSync(workDir.dir), true);
    await workDir.cleanup();
    assert.equal(fs.existsSync(workDir.dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shutdown keeps a captured review session and its two directories', async () => {
  const shutdownController = new AbortController();
  const { dispatch, worktreeRoot, cleanup } = setup({
    shutdownSignal: shutdownController.signal,
    timeoutSeconds: 60,
    now: () => 1000,
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => { fs.mkdirSync(String(worktreePath), { recursive: true }); return { ok: true }; },
      removeWorktreeByPath: async () => { throw new Error('checkout must remain'); },
      pruneWorktrees: async () => ({ ok: true }),
      originUrl: async () => null,
      populate: async () => {},
    },
    spawnSession: async ({ onSessionId }) => { onSessionId?.('claude-1'); shutdownController.abort(); },
  });
  try {
    const outcome = await dispatch(reviewArgs('full'));
    assert.equal('kind' in outcome && outcome.kind, 'stopped');
    if (!('kind' in outcome)) throw new Error('expected stopped review');
    assert.deepEqual(outcome.resumable && {
      sessionId: outcome.resumable.sessionId,
      head: outcome.resumable.head,
      deadlineAt: outcome.resumable.deadlineAt,
      savedAt: outcome.resumable.savedAt,
    }, { sessionId: 'claude-1', head: HEAD, deadlineAt: 61000, savedAt: 1000 });
    assert.equal(fs.existsSync(outcome.resumable?.workDir ?? ''), true);
    assert.equal(fs.existsSync(outcome.resumable?.worktreePath ?? ''), true);
    assert.equal(path.dirname(outcome.resumable?.worktreePath ?? ''), worktreeRoot);
  } finally {
    cleanup();
  }
});

test('shutdown saves the awake budget left after capped clock jumps, even when the wall-clock deadline has passed', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const shutdownController = new AbortController();
  let nowMs = 1000;
  let markSpawnStarted = () => {};
  const spawnStarted = new Promise<void>((resolve) => { markSpawnStarted = resolve; });
  const { dispatch, cleanup } = setup({
    shutdownSignal: shutdownController.signal,
    timeoutSeconds: 600,
    now: () => nowMs,
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => { fs.mkdirSync(String(worktreePath), { recursive: true }); return { ok: true }; },
      removeWorktreeByPath: async () => { throw new Error('checkout must remain'); },
      pruneWorktrees: async () => ({ ok: true }),
      originUrl: async () => null,
      populate: async () => {},
    },
    spawnSession: ({ signal, onSessionId }) => new Promise<void>((resolve) => {
      onSessionId?.('claude-1');
      signal.addEventListener('abort', () => resolve(), { once: true });
      markSpawnStarted();
    }),
  });
  try {
    const pendingOutcome = dispatch(reviewArgs('full'));
    await spawnStarted;
    for (let tickIndex = 0; tickIndex < 3; tickIndex += 1) {
      nowMs += 30 * 60 * 1000;
      context.mock.timers.tick(15000);
    }
    shutdownController.abort();
    const outcome = await pendingOutcome;
    if (!('kind' in outcome)) throw new Error('expected stopped review');
    assert.equal(outcome.kind, 'stopped');
    assert.equal(outcome.resumable?.deadlineAt, 601000);
    assert.equal(outcome.resumable?.remainingAwakeMs, 600000 - 3 * 30000);
    assert.equal(outcome.resumable?.savedAt, nowMs);
  } finally {
    cleanup();
  }
});

test('shutdown without a captured session removes the review directories', async () => {
  const shutdownController = new AbortController();
  const { dispatch, removed, workRoot, worktreeRoot, cleanup } = setup({
    shutdownSignal: shutdownController.signal,
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => { fs.mkdirSync(String(worktreePath), { recursive: true }); return { ok: true }; },
      removeWorktreeByPath: async ({ cwd }) => { removed.push(String(cwd)); fs.rmSync(String(cwd), { recursive: true, force: true }); return { ok: true }; },
      pruneWorktrees: async () => ({ ok: true }),
      originUrl: async () => null,
      populate: async () => {},
    },
    spawnSession: async () => { shutdownController.abort(); },
  });
  try {
    assert.deepEqual(await dispatch(reviewArgs('full')), { kind: 'stopped', resumable: null });
    assert.equal(removed.length, 1);
    assert.deepEqual(fs.readdirSync(workRoot), []);
    assert.deepEqual(fs.readdirSync(worktreeRoot), []);
  } finally {
    cleanup();
  }
});

test('resume uses the saved cwd and session with the remaining timeout without staging', async () => {
  const timeouts: number[] = [];
  const { dispatch, staged, hydrations, spawns, workRoot, worktreeRoot, cleanup } = setup({
    now: () => 3000,
    makeWorkDir: async () => { throw new Error('resume must use the saved work dir'); },
    setTimeoutFn: (_fn, timeoutMs) => { timeouts.push(timeoutMs); return setTimeout(() => {}, 100000); },
  });
  const workDir = fs.mkdtempSync(path.join(workRoot, 'resume-work-'));
  const worktreePath = fs.mkdtempSync(path.join(worktreeRoot, 'resume-tree-'));
  fs.writeFileSync(path.join(workDir, REVIEW_PROMPT_FILENAME), 'original prompt');
  fs.mkdirSync(path.join(workDir, REMERGE_OBJECTS_DIRNAME));
  const resume = { sessionId: 'claude-1', workDir, worktreePath, head: HEAD, deadlineAt: 81000, savedAt: 1000 };
  try {
    const outcome = await dispatch({ ...reviewArgs('full'), resume });
    if ('kind' in outcome) throw new Error('expected a draft');
    assert.equal(outcome.status, 'ready');
    assert.deepEqual(staged, []);
    assert.deepEqual(hydrations, []);
    assert.equal(spawns[0]?.resumeSessionId, 'claude-1');
    assert.equal(spawns[0]?.initialPrompt, REVIEW_RESUME_PROMPT);
    assert.equal(spawns[0]?.cwd, workDir);
    assert.deepEqual(spawns[0]?.spawnEnv, hooksPathPinnedSpawnEnv(workDir));
    const reviewArgsSpawned = spawns[0]?.extraClaudeArgs ?? [];
    assert.deepEqual(reviewArgsSpawned.slice(0, 2), ['-p', '--allowedTools']);
    assert.equal(reviewArgsSpawned.includes('Bash'), false);
    assert.ok(reviewArgsSpawned.includes(`Bash(git -C ${worktreePath} diff:*)`));
    assert.ok(reviewArgsSpawned.includes(`Read(/${worktreePath}/**)`));
    const remergeEnvPrefix = `GIT_OBJECT_DIRECTORY=${path.join(workDir, REMERGE_OBJECTS_DIRNAME)} GIT_ALTERNATE_OBJECT_DIRECTORIES=${path.join(CACHED_CLONE, '.git', 'objects')}`;
    assert.ok(reviewArgsSpawned.includes(`Bash(${remergeEnvPrefix} git -C ${worktreePath} range-diff:*)`));
    assert.equal(spawns[0]?.workDirFiles.includes('tmp'), false);
    assert.deepEqual(roleOf(spawns[0]), teamReviewRole(ROLE_FACTS, { checkoutPath: worktreePath, cachedClone: CACHED_CLONE, unreadablePaths: [] }));
    assert.deepEqual(timeouts, [78000]);
  } finally {
    cleanup();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test('resume with a saved awake budget uses that budget even when the wall-clock deadline has passed', async () => {
  const timeouts: number[] = [];
  const { dispatch, workRoot, worktreeRoot, cleanup } = setup({
    now: () => 3000,
    makeWorkDir: async () => { throw new Error('resume must use the saved work dir'); },
    setTimeoutFn: (_fn, timeoutMs) => { timeouts.push(timeoutMs); return setTimeout(() => {}, 100000); },
  });
  const workDir = fs.mkdtempSync(path.join(workRoot, 'resume-work-'));
  const worktreePath = fs.mkdtempSync(path.join(worktreeRoot, 'resume-tree-'));
  fs.writeFileSync(path.join(workDir, REVIEW_PROMPT_FILENAME), 'original prompt');
  fs.mkdirSync(path.join(workDir, REMERGE_OBJECTS_DIRNAME));
  const resume = { sessionId: 'claude-1', workDir, worktreePath, head: HEAD, deadlineAt: 2000, remainingAwakeMs: 45000, savedAt: 1000 };
  try {
    const outcome = await dispatch({ ...reviewArgs('full'), resume });
    if ('kind' in outcome) throw new Error('expected a draft');
    assert.equal(outcome.status, 'ready');
    assert.deepEqual(timeouts, [45000]);
  } finally {
    cleanup();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test('shutdown before a resumed spawn restores the saved record', async () => {
  const shutdownController = new AbortController();
  shutdownController.abort();
  const { dispatch, staged, spawns, workRoot, worktreeRoot, cleanup } = setup({ shutdownSignal: shutdownController.signal, now: () => 3000 });
  const workDir = fs.mkdtempSync(path.join(workRoot, 'paused-work-'));
  const worktreePath = fs.mkdtempSync(path.join(worktreeRoot, 'paused-tree-'));
  const resume = { sessionId: 'claude-1', workDir, worktreePath, head: HEAD, deadlineAt: 81000, savedAt: 1000 };
  try {
    assert.deepEqual(await dispatch({ ...reviewArgs('full'), resume }), { kind: 'stopped', resumable: { ...resume, savedAt: 3000 } });
    assert.deepEqual(staged, []);
    assert.deepEqual(spawns, []);
    assert.equal(fs.existsSync(workDir), true);
    assert.equal(fs.existsSync(worktreePath), true);
  } finally {
    cleanup();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test('a missing saved work dir deletes the remaining checkout and starts a fresh review', async () => {
  const { dispatch, staged, spawns, workRoot, worktreeRoot, cleanup } = setup();
  const worktreePath = fs.mkdtempSync(path.join(worktreeRoot, 'orphan-tree-'));
  try {
    const outcome = await dispatch({ ...reviewArgs('stamp'), resume: {
      sessionId: 'claude-1', workDir: path.join(workRoot, 'missing'), worktreePath, head: HEAD, deadlineAt: 81000, savedAt: 1000,
    } });
    if ('kind' in outcome) throw new Error('expected a draft');
    assert.equal(outcome.status, 'ready');
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(staged.length, 1);
    assert.equal(spawns[0]?.resumeSessionId, undefined);
    assert.equal(spawns[0]?.initialPrompt, REVIEW_BOOTSTRAP_PROMPT);
  } finally {
    cleanup();
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test('a saved review whose paths sit outside the review roots is ignored and nothing outside is deleted', async () => {
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-outside-'));
  const outsideWorkDir = fs.mkdtempSync(path.join(outsideDirectory, 'work-'));
  const outsideWorktree = fs.mkdtempSync(path.join(outsideDirectory, 'tree-'));
  const { dispatch, staged, spawns, cleanup } = setup();
  try {
    const outcome = await dispatch({ ...reviewArgs('stamp'), resume: {
      sessionId: 'claude-1', workDir: outsideWorkDir, worktreePath: outsideWorktree, head: HEAD, deadlineAt: 81000, savedAt: 1000,
    } });
    if ('kind' in outcome) throw new Error('expected a draft');
    assert.equal(staged.length, 1);
    assert.equal(spawns[0]?.resumeSessionId, undefined);
    assert.equal(fs.existsSync(outsideWorkDir), true);
    assert.equal(fs.existsSync(outsideWorktree), true);
  } finally {
    cleanup();
    fs.rmSync(outsideDirectory, { recursive: true, force: true });
  }
});

test('a saved review whose directory is a symlink out of the review roots is ignored and its target is kept', async () => {
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-outside-'));
  const { dispatch, staged, spawns, workRoot, worktreeRoot, cleanup } = setup();
  const linkedWorkDir = path.join(workRoot, 'linked-work');
  fs.symlinkSync(outsideDirectory, linkedWorkDir, 'dir');
  const worktreePath = fs.mkdtempSync(path.join(worktreeRoot, 'saved-tree-'));
  try {
    const outcome = await dispatch({ ...reviewArgs('stamp'), resume: {
      sessionId: 'claude-1', workDir: linkedWorkDir, worktreePath, head: HEAD, deadlineAt: 81000, savedAt: 1000,
    } });
    if ('kind' in outcome) throw new Error('expected a draft');
    assert.equal(staged.length, 1);
    assert.equal(spawns[0]?.resumeSessionId, undefined);
    assert.notEqual(spawns[0]?.cwd, linkedWorkDir);
    assert.equal(fs.existsSync(outsideDirectory), true);
  } finally {
    cleanup();
    fs.rmSync(outsideDirectory, { recursive: true, force: true });
  }
});

test('a review that finished its report before shutdown returns the ready draft and cleans up', async () => {
  const shutdownController = new AbortController();
  const { dispatch, removed, workRoot, worktreeRoot, cleanup } = setup({
    shutdownSignal: shutdownController.signal,
    log: { warn: () => { shutdownController.abort(); } },
    spawnSession: async ({ cwd }) => {
      fs.writeFileSync(path.join(cwd, REVIEW_REPORT_FILENAME), reportText());
      fs.writeFileSync(path.join(cwd, REVIEW_POSTING_FILENAME), 'not a posting plan');
    },
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => { fs.mkdirSync(String(worktreePath), { recursive: true }); return { ok: true }; },
      removeWorktreeByPath: async ({ cwd }) => { removed.push(String(cwd)); fs.rmSync(String(cwd), { recursive: true, force: true }); return { ok: true }; },
      pruneWorktrees: async () => ({ ok: true }),
      originUrl: async () => null,
      populate: async () => {},
    },
  });
  try {
    const outcome = await dispatch(reviewArgs('full'));
    if ('kind' in outcome) throw new Error('expected a draft');
    assert.equal(shutdownController.signal.aborted, true);
    assert.equal(outcome.status, 'ready');
    assert.equal(removed.length, 1);
    assert.deepEqual(fs.readdirSync(workRoot), []);
    assert.deepEqual(fs.readdirSync(worktreeRoot), []);
  } finally {
    cleanup();
  }
});

test('a fresh review started after an unusable saved record is stopped with its own full deadline', async () => {
  const shutdownController = new AbortController();
  const { dispatch, workRoot, worktreeRoot, cleanup } = setup({
    shutdownSignal: shutdownController.signal,
    timeoutSeconds: 60,
    now: () => 5000,
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => { fs.mkdirSync(String(worktreePath), { recursive: true }); return { ok: true }; },
      removeWorktreeByPath: async () => ({ ok: true }),
      pruneWorktrees: async () => ({ ok: true }),
      originUrl: async () => null,
      populate: async () => {},
    },
    spawnSession: async ({ onSessionId }) => { onSessionId?.('claude-2'); shutdownController.abort(); },
  });
  try {
    const outcome = await dispatch({ ...reviewArgs('full'), resume: {
      sessionId: 'claude-1', workDir: path.join(workRoot, 'missing'), worktreePath: path.join(worktreeRoot, 'also-missing'), head: HEAD, deadlineAt: 6000, savedAt: 1000,
    } });
    if (!('kind' in outcome)) throw new Error('expected stopped review');
    assert.equal(outcome.resumable?.sessionId, 'claude-2');
    assert.equal(outcome.resumable?.deadlineAt, 65000);
  } finally {
    cleanup();
  }
});

test('the default dispatcher timeout counts capped awake time, so a 30 minute clock jump per tick does not time the review out early', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let nowMs = 1000;
  let wasAborted = false;
  let markSpawnStarted = () => {};
  const spawnStarted = new Promise<void>((resolve) => { markSpawnStarted = resolve; });
  const { review, cleanup } = setup({
    timeoutSeconds: 120,
    now: () => nowMs,
    spawnSession: ({ signal }) => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { wasAborted = true; resolve(); }, { once: true });
      markSpawnStarted();
    }),
  });
  try {
    const pendingDraft = review(reviewArgs('full'));
    await spawnStarted;
    for (let tickIndex = 0; tickIndex < 3; tickIndex += 1) {
      nowMs += 30 * 60 * 1000;
      context.mock.timers.tick(15000);
      assert.equal(wasAborted, false);
    }
    nowMs += 30 * 60 * 1000;
    context.mock.timers.tick(15000);
    assert.equal(wasAborted, true);
    const draft = await pendingDraft;
    assert.equal(draft.status, 'error');
    assert.match(draft.error ?? '', /timed out after 120s/);
  } finally {
    cleanup();
  }
});

test('review process cleanup follows session exit and precedes checkout removal on every outcome', async () => {
  for (const outcome of ['success', 'error', 'timeout', 'shutdown'] as const) {
    const events: string[] = [];
    const reapedDirectories: string[][] = [];
    const shutdownController = new AbortController();
    const spawnSession: TeamReviewSpawn = async ({ cwd, signal, onSessionId }) => {
      if (outcome === 'timeout') {
        await new Promise<void>((resolve) => {
          const liveSessionHandle = setInterval(() => {}, 1000);
          signal.addEventListener('abort', () => { clearInterval(liveSessionHandle); resolve(); }, { once: true });
        });
        events.push('session-exit');
        return;
      }
      if (outcome === 'shutdown') {
        onSessionId?.('claude-1');
        shutdownController.abort();
        events.push('session-exit');
        return;
      }
      events.push('session-exit');
      if (outcome === 'error') throw new Error('session failed');
      fs.writeFileSync(path.join(cwd, REVIEW_REPORT_FILENAME), reportText());
    };
    const { dispatch, cleanup } = setup({
      spawnSession,
      shutdownSignal: shutdownController.signal,
      timeoutSeconds: outcome === 'timeout' ? 0.001 : 60,
      setTimeoutFn: outcome === 'timeout' ? (callback) => setTimeout(callback, 0) : undefined,
      reapProcesses: async ({ ownedDirectories }) => {
        reapedDirectories.push([...ownedDirectories]);
        events.push('reap');
      },
      gitWorkspace: {
        stageDetachedWorktree: async ({ worktreePath }) => { fs.mkdirSync(String(worktreePath), { recursive: true }); return { ok: true }; },
        removeWorktreeByPath: async ({ cwd }) => { events.push('remove'); fs.rmSync(String(cwd), { recursive: true, force: true }); return { ok: true }; },
        pruneWorktrees: async () => ({ ok: true }),
        originUrl: async () => null,
        populate: async () => {},
      },
    });
    try {
      const reviewOutcome = await dispatch(reviewArgs('full'));
      assert.equal(reapedDirectories.length, 1, outcome);
      assert.equal(reapedDirectories[0].length, 2);
      assert.match(path.basename(reapedDirectories[0][0]), /^glimmervoid-wt-team-review-/);
      assert.match(path.basename(reapedDirectories[0][1]), /^glimmervoid-wt-team-review-/);
      assert.deepEqual(events, outcome === 'shutdown' ? ['session-exit', 'reap'] : ['session-exit', 'reap', 'remove'], outcome);
      if (outcome === 'shutdown') assert.equal('kind' in reviewOutcome && reviewOutcome.kind, 'stopped');
    } finally {
      cleanup();
    }
  }
});

test('a resumed review reaps its prior run before spawning', async () => {
  const events: string[] = [];
  const { dispatch, workRoot, worktreeRoot, cleanup } = setup({
    reapProcesses: async ({ ownedDirectories, reviewRoots, scope }) => { events.push(`reap:${ownedDirectories.join('|')}:${scope}:${reviewRoots.join('|')}`); },
    spawnSession: async ({ cwd }) => {
      events.push('spawn');
      assert.equal(fs.existsSync(path.join(cwd, 'tmp')), false);
      fs.writeFileSync(path.join(cwd, REVIEW_REPORT_FILENAME), reportText());
    },
  });
  const workDir = fs.mkdtempSync(path.join(workRoot, 'resume-work-'));
  const worktreePath = fs.mkdtempSync(path.join(worktreeRoot, 'resume-tree-'));
  const resume = { sessionId: 'claude-1', workDir, worktreePath, head: HEAD, deadlineAt: Date.now() + 60000, savedAt: Date.now() };
  try {
    const reviewOutcome = await dispatch({ ...reviewArgs('full'), resume });
    assert.equal('kind' in reviewOutcome, false);
    const expectedReap = `reap:${workDir}|${worktreePath}:run:${workRoot}|${worktreeRoot}`;
    assert.deepEqual(events, [expectedReap, 'spawn', expectedReap]);
  } finally {
    cleanup();
  }
});

test('the head tree is hydrated before the detached worktree is staged', async () => {
  const { review, checkoutEvents, cleanup } = setup();
  try {
    assert.equal((await review(reviewArgs('full'))).status, 'ready');
    assert.deepEqual(checkoutEvents, [`hydrate:Acme/app@${HEAD}`, 'stage']);
  } finally {
    cleanup();
  }
});

for (const hydrationFailure of [
  { treeHydrated: false, treeHydratedErr: 'fatal: missing blob\nmore detail' },
  { treeHydrationError: new Error('fatal: missing blob\nmore detail') },
  { treeHydrated: false, treeHydratedErr: '' },
]) {
  test(`a head tree hydration failure never stages or spawns: ${Object.keys(hydrationFailure).join(', ')}`, async () => {
    const { review, staged, spawns, cleanup } = setup(hydrationFailure);
    try {
      const draft = await review(reviewArgs('full'));
      assert.equal(draft.status, 'error');
      const detail = hydrationFailure.treeHydratedErr === '' ? '' : ': fatal: missing blob';
      assert.equal(draft.error, `could not fetch the file contents of Acme/app#7${detail}`);
      assert.deepEqual(staged, []);
      assert.deepEqual(spawns, []);
    } finally {
      cleanup();
    }
  });
}

test('a failed fetch reports the first git error line in its error draft', async () => {
  const { review, staged, spawns, cleanup } = setup({ fetchedErr: 'fatal: permission denied\nmore detail' });
  try {
    const draft = await review(reviewArgs('full'));
    assert.equal(draft.error, 'could not fetch Acme/app#7: fatal: permission denied');
    assert.deepEqual(staged, []);
    assert.equal(spawns.length, 0);
  } finally {
    cleanup();
  }
});



test('the start sweep keeps saved review paths in both roots and deletes other paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-sweep-keep-'));
  const worktreeRoot = path.join(root, 'trees');
  const workRoot = path.join(root, 'work');
  const keptTree = path.join(worktreeRoot, 'kept');
  const keptWork = path.join(workRoot, 'kept');
  try {
    for (const directory of [keptTree, keptWork, path.join(worktreeRoot, 'old'), path.join(workRoot, 'old')]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    await sweepLeftoverCheckouts({
      worktreeRoot, workRoot, keepPaths: new Set([keptTree, keptWork]),
      reapProcesses: async () => {},
      repoCache: { listRepos: async () => [] },
      gitWorkspace: { pruneWorktrees: async () => ({ ok: true }) },
      log: { warn: () => {} },
    });
    assert.deepEqual(fs.readdirSync(worktreeRoot), ['kept']);
    assert.deepEqual(fs.readdirSync(workRoot), ['kept']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discarding a saved review reaps its processes before removing its directories', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-discard-test-'));
  const workRoot = path.join(homeDir, 'team-review-work');
  const worktreeRoot = path.join(homeDir, 'team-review-worktrees');
  fs.mkdirSync(workRoot);
  fs.mkdirSync(worktreeRoot);
  const workDir = fs.mkdtempSync(path.join(workRoot, 'review-'));
  const worktreePath = fs.mkdtempSync(path.join(worktreeRoot, 'checkout-'));
  const events: string[] = [];
  let discardSavedReview: ((record: ResumableReview) => Promise<void>) | undefined;
  const pollerCreated = deferredSignal();
  const wiring = createTeamReviewWiring({
    config: { teamReview: { enabled: true, org: 'Acme', team: 'core' } },
    store: emptyGithubStore(),
    reviewSessions: new Map(), closeSessionDataClients: () => {}, hookRouter: null, getHookPort: null,
    spawnGate: { run: async (task) => task() }, homeDir, log: { warn: () => {} },
    reapProcesses: async ({ ownedDirectories, reviewRoots, scope }) => {
      if (ownedDirectories[0] !== workDir) return;
      assert.deepEqual(ownedDirectories, [workDir, worktreePath]);
      assert.deepEqual(reviewRoots, [workRoot, worktreeRoot]);
      assert.equal(scope, 'run');
      assert.equal(fs.existsSync(workDir), true);
      assert.equal(fs.existsSync(worktreePath), true);
      events.push('reap');
    },
    github: {},
    repoCache: {
      listRepos: async () => [], ensureRepo: async () => null,
      fetchPr: async () => ({ ok: false, headSha: null, err: '' }), hydrateTree: async () => ({ ok: true, err: '' }), hydrateRange: async () => ({ ok: false, err: '' }), hydrateSince: async () => false, isolateNewWork: async () => ({ ok: false, reason: '' }),
    },
    gitWorkspace: {
      stageDetachedWorktree: async () => ({ ok: false }), removeWorktreeByPath: async () => ({ ok: false }),
      pruneWorktrees: async () => ({ ok: true }),
      originUrl: async () => null,
      populate: async () => {},
    },
    createPoller: (dependencies) => {
      discardSavedReview = dependencies.discardResumable;
      pollerCreated.resolve();
      return createTeamReviewPoller({ ...dependencies, beforeStart: async () => {} });
    },
  });
  try {
    wiring.startPoller();
    await pollerCreated.promise;
    const discard = discardSavedReview;
    assert.ok(discard);
    await discard({ sessionId: 'claude-1', workDir, worktreePath, head: HEAD, deadlineAt: 1000, savedAt: 1000 });
    assert.deepEqual(events, ['reap']);
    assert.equal(fs.existsSync(workDir), false);
    assert.equal(fs.existsSync(worktreePath), false);
  } finally {
    await wiring.stopPoller();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

function deferredSignal(): { promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void } {
  let resolve: () => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<void>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

const ACTION_KEY = 'Acme/app#7';


function actionDraft(overrides: Partial<ReviewDraftType> = {}): ReviewDraftType {
  return ReviewDraft.parse({
    key: ACTION_KEY, repo: 'Acme/app', number: 7, title: 'Listen on host', url: 'https://github.com/Acme/app/pull/7',
    author: 'teammate', tier: 'stamp', reasons: ['3 counted lines in 1 files'], reviewedHead: HEAD,
    verdict: 'APPROVE', summary: 'Looks fine', body: 'LGTM', comments: [], status: 'ready', ...overrides,
  });
}

test('state loading drops an invalid saved review while retaining a valid draft', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-state-test-'));
  try {
    const statePath = path.join(homeDir, 'state.json');
    const validEntry = { draft: actionDraft(), reviewedHead: HEAD, inFlight: false, reviewAttempts: 1, updatedAt: 42 };
    fs.writeFileSync(statePath, JSON.stringify({ [ACTION_KEY]: validEntry, 'Acme/app#8': { draft: 'bad' } }));
    const warnings: string[] = [];
    const stateIo = createTeamReviewStateIo(statePath, { warn: (message) => { warnings.push(message); } });
    assert.deepEqual(await stateIo.readState(), { [ACTION_KEY]: validEntry });
    assert.deepEqual(warnings, ['[team-review] dropped an invalid saved review Acme/app#8']);
    assert.equal(fs.existsSync(statePath), true);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

const PRIOR_REVIEW = { head: OTHER_HEAD, base: PRIOR_BASE, verdict: 'REQUEST CHANGES' as const, summary: 'null deref', body: 'Fix the null check.', comments: [], wasPosted: true };

test('a re-review isolates the new work since the earlier review from the base branch and points the reviewer at it', async () => {
  const { review, hydrations, spawns, cleanup } = setup();
  try {
    await review({ ...reviewArgs('full'), priorReview: PRIOR_REVIEW });
    assert.ok(hydrations.includes(`Acme/app@${PRIOR_BASE}:${OTHER_HEAD}..${HEAD}`));
    assert.match(spawns[0].prompt, /This is a re-review:/);
    assert.ok(spawns[0].prompt.includes(`range-diff --diff-merges=remerge ${PRIOR_MERGE_BASE}..${OTHER_HEAD} ${CURRENT_MERGE_BASE}..${HEAD}`));
    const scratchObjectsDir = path.join(spawns[0].workDir, REMERGE_OBJECTS_DIRNAME);
    assert.ok(spawns[0].prompt.includes(`GIT_OBJECT_DIRECTORY=${scratchObjectsDir} GIT_ALTERNATE_OBJECT_DIRECTORIES=/cache/Acme/app/.git/objects`));
    assert.ok(spawns[0].workDirFiles.includes(REMERGE_OBJECTS_DIRNAME));
    const remergeEnvPrefix = `GIT_OBJECT_DIRECTORY=${scratchObjectsDir} GIT_ALTERNATE_OBJECT_DIRECTORIES=/cache/Acme/app/.git/objects`;
    assert.ok(spawns[0].extraClaudeArgs.some((argument) => argument.startsWith(`Bash(${remergeEnvPrefix} git -C `) && argument.endsWith(' range-diff:*)')));
    const payload = UntrustedPayload.parse(JSON.parse(spawns[0].untrustedPayloadText ?? 'null'));
    assert.deepEqual(payload.items.map((item) => item.kind), ['pr-title', 'pr-body', 'prior-review']);
    assert.ok(spawns[0].prompt.includes(UNTRUSTED_PREAMBLE));
    assert.ok(!spawns[0].prompt.includes(PRIOR_REVIEW.summary));
  } finally {
    cleanup();
  }
});

test('a re-review whose new work cannot be isolated, or whose earlier review stored no base, reviews the whole range', async () => {
  const unisolable = setup({ isNewWorkIsolable: false });
  try {
    await unisolable.review({ ...reviewArgs('full'), priorReview: PRIOR_REVIEW });
    assert.match(unisolable.spawns[0].prompt, /cannot be told apart from the base branch/);
    assert.ok(!unisolable.spawns[0].prompt.includes('range-diff --diff-merges'));
  } finally {
    unisolable.cleanup();
  }
  const { base: _storedBase, ...legacyPriorReview } = PRIOR_REVIEW;
  const legacy = setup();
  try {
    await legacy.review({ ...reviewArgs('full'), priorReview: legacyPriorReview });
    assert.deepEqual(legacy.hydrations.filter((hydration) => hydration.includes('..')), []);
    assert.match(legacy.spawns[0].prompt, /cannot be told apart from the base branch/);
  } finally {
    legacy.cleanup();
  }
});


function emptyGithubStore(github: Partial<Parameters<typeof createGithubStorePoller>[0]['github']> = {}) {
  const searches: string[] = [];
  const poller = createGithubStorePoller({
    now: Date.now, isDashboardConnected: () => true, exclusive: async (work) => work(),
    setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout, log: { warn() {} },
    github: {
      async searchPrsLight(qualifiers) { searches.push(qualifiers); return { ok: true, items: [], isComplete: true, error: '' }; },
      async prsLightByKey() { return new Map(); },
      async prDetails() { return new Map(); },
      async notificationsSince() { return { kind: 'unchanged' }; },
      async behindCounts() { return new Map(); },
      async reviewThreadsBatch() { return new Map(); },
      async rateLimitWaitMs() { return null; },
      async viewPr() { return null; },
      async prDiff() { return null; },
      async prHead() { return null; },
      ...github,
    },
  });
  return {
    ...poller, searches,
    subscribe: <Event extends 'snapshot-changed' | 'change'>(event: Event, listener: Parameters<typeof poller.events.on<Event>>[1]) => {
      poller.events.on(event, listener);
      return () => { poller.events.off(event, listener); };
    },
  };
}

test('a pull request session starts from the main checkout under a repo root even when a linked worktree of it sorts first', { skip: !hasGit() }, async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-home-test-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-pr-roots-'));
  const mainCheckout = path.join(root, 'app');
  fs.mkdirSync(path.join(root, 'aaa-other'));
  git(['init', '-q', '-b', 'main', mainCheckout]);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'seed'], mainCheckout);
  git(['remote', 'add', 'origin', 'https://github.com/Acme/app'], mainCheckout);
  git(['worktree', 'add', '-q', '-b', 'feature', path.join(root, 'a-app-feature')], mainCheckout);
  const bareClone = path.join(root, '0-app.git');
  const bareCloneWorktree = path.join(root, '0-app-feature');
  git(['clone', '-q', '--bare', mainCheckout, bareClone]);
  git(['remote', 'set-url', 'origin', 'https://github.com/Acme/app'], bareClone);
  git(['worktree', 'add', '-q', bareCloneWorktree], bareClone);
  const wiring = createTeamReviewWiring({
    config: { teamReview: { enabled: true, org: 'Acme', team: 'core' }, projects: [{ path: bareCloneWorktree }], repoRoots: [root] },
    store: {
      ...emptyGithubStore(),
      requestPrHead: async () => ({ isRateLimited: false, value: HEAD }),
      requestPrView: async () => ({ isRateLimited: false, value: PrDetail.parse({ ...detail, headRefName: 'feature', headRefOid: HEAD }) }),
    },
    reviewSessions: new Map(), closeSessionDataClients: () => {}, hookRouter: null, getHookPort: null,
    spawnGate: { run: async (task) => task() }, homeDir, log: { warn: () => {} }, reapProcesses: async () => {},
    github: {},
    repoCache: {
      listRepos: async () => [], ensureRepo: async () => CACHED_CLONE,
      fetchPr: async () => ({ ok: false, headSha: null, err: '' }), hydrateTree: async () => ({ ok: true, err: '' }), hydrateRange: async () => ({ ok: false, err: '' }), hydrateSince: async () => false, isolateNewWork: async () => ({ ok: false, reason: '' }),
    },
    gitWorkspace: {
      stageDetachedWorktree: async () => ({ ok: false }), removeWorktreeByPath: async () => ({ ok: false }),
      pruneWorktrees: async () => ({ ok: true }),
      originUrl: async ({ projectPath }) => git(['config', '--get', 'remote.origin.url'], projectPath).trim() || null,
      populate: async () => {},
      seedBranchFromOrigin: async () => ({ ok: true, out: HEAD, err: '' }),
    },
  });
  try {
    const checkout = await wiring.preparePrSession('Acme/app#7');
    assert.equal(checkout.ok, true);
    assert.equal(checkout.ok && checkout.checkoutPath, fs.realpathSync(mainCheckout));
    assert.equal(checkout.ok && checkout.isConfiguredProject, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
