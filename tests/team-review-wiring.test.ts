import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isDispatchWorkdir } from '../server/core/ingest-agent-core.ts';
import { createGitWorkspace } from '../server/git-workspace.ts';
import { git, hasGit } from './helpers/git-fixture.ts';
import { AUTOMATED_REVIEW_NOTE, FULL_MODEL, HAND_APPROVAL_LINE, REVIEW_BOOTSTRAP_PROMPT, REVIEW_RESUME_PROMPT, REVIEW_POSTING_FILENAME, REVIEW_PROMPT_FILENAME, REVIEW_REPORT_FILENAME, STAMP_MODEL } from '../server/core/team-review-core.ts';
import type { ReviewProgressEvent, ReviewTier } from '../server/core/team-review-core.ts';
import { createTeamReviewPoller } from '../server/team-review-poller.ts';
import type { DraftPatch, SpawnReviewArgs } from '../server/team-review-poller.ts';
import type { PostedReview } from '../server/pr-gh.ts';
import {
  TEAM_REVIEW_DENY_RULES, createTeamReviewActions, createTeamReviewDispatcher, createTeamReviewSpawn, createTeamReviewWiring, emptyTeamReviewStatus,
  createTeamReviewStateIo, makeTeamReviewWorkDir, readTeamReviewSettings, sweepLeftoverCheckouts, teamReviewClaudeArgs, teamReviewPermissions, teamReviewSandbox, teamReviewShouldStart, teamReviewSpawnEnv,
} from '../server/team-review-wiring.ts';
import type { TeamReviewActionGithub, TeamReviewDispatchOptions, TeamReviewSpawn } from '../server/team-review-wiring.ts';
import { PrDetail, ReviewDraft, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import type { ResumableReview, ReviewComment, ReviewDraft as ReviewDraftType, TeamReviewActionRequest } from '../shared/contracts/team-review.ts';
import { SANDBOX_UNAPPLIED_ERROR, Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';

const HEAD = 'c'.repeat(40);
const OTHER_HEAD = 'd'.repeat(40);
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

type SpawnCall = Parameters<TeamReviewSpawn>[0] & { workDir: string; workDirFiles: string[]; prompt: string };

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
  isPriorHeadFetchable?: boolean;
} = {}) {
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-wt-test-'));
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-work-test-'));
  const staged: string[] = [];
  const removed: string[] = [];
  const pruned: string[] = [];
  const hydrations: string[] = [];
  const spawns: SpawnCall[] = [];
  const writeReport = overrides.writeReport ?? ((workDir: string) => fs.writeFileSync(path.join(workDir, REVIEW_REPORT_FILENAME), reportText()));
  const options: TeamReviewDispatchOptions = {
    github: { prDiff: async () => (overrides.diff === undefined ? DIFF : overrides.diff) },
    repoCache: {
      listRepos: async () => [],
      ensureRepo: async () => '/cache/Acme/app',
      fetchPr: async () => ({ ok: !overrides.fetchedErr, headSha: overrides.fetchedErr ? null : (overrides.fetchedHead ?? HEAD), err: overrides.fetchedErr ?? '' }),
      hydrateRange: async (repo, number, headSha) => {
        hydrations.push(`${repo}#${number}@${headSha}`);
        return { ok: overrides.hydrated ?? true, err: overrides.hydratedErr ?? '' };
      },
      hydrateSince: async (repo, sinceSha, headSha) => {
        hydrations.push(`${repo}@${sinceSha}..${headSha}`);
        return overrides.isPriorHeadFetchable ?? true;
      },
    },
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => { staged.push(String(worktreePath)); return { ok: true }; },
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
  return { review, dispatch, staged, removed, pruned, hydrations, spawns, worktreeRoot, workRoot, cleanup };
}

function reviewArgs(tier: ReviewTier) {
  return { candidate, detail, tier, reasons: ['a reason'] };
}

function checkoutSharingWorkspace(overrides: Partial<TeamReviewDispatchOptions['gitWorkspace']> = {}): TeamReviewDispatchOptions['gitWorkspace'] {
  return {
    stageDetachedWorktree: async ({ worktreePath }) => { fs.mkdirSync(String(worktreePath), { recursive: true }); return { ok: true }; },
    originUrl: async () => 'https://github.com/Acme/app',
    populate: async ({ projectPath, wtDir }) => { fs.symlinkSync(path.join(projectPath, 'node_modules'), path.join(wtDir, 'node_modules'), 'dir'); },
    removeWorktreeByPath: async ({ cwd }) => { fs.rmSync(String(cwd), { recursive: true, force: true }); return { ok: true }; },
    pruneWorktrees: async () => ({ ok: true }),
    ...overrides,
  };
}

test('local checkout sharing prefers configured projects with matching origins and dependencies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-clones-'));
  const wrong = path.join(root, 'wrong');
  const missingModules = path.join(root, 'missing-modules');
  const preferred = path.join(root, 'preferred');
  const rootClone = path.join(root, 'root-clone');
  const populated: { projectPath: string; wtDir: string; shareList: string[] }[] = [];
  for (const directory of [wrong, missingModules, preferred, rootClone]) fs.mkdirSync(directory);
  for (const directory of [wrong, preferred, rootClone]) fs.mkdirSync(path.join(directory, 'node_modules'));
  const { review, spawns, cleanup } = setup({
    readLocalCheckoutConfig: () => ({ projects: [{ path: wrong }, { path: missingModules }, { path: preferred }], repoRoots: [root] }),
    gitWorkspace: checkoutSharingWorkspace({
      originUrl: async ({ projectPath }) => projectPath === fs.realpathSync(wrong) ? 'https://github.com/Acme/other.git' : 'git@github.com:acme/APP.git',
      populate: async (args) => { populated.push(args); fs.symlinkSync(path.join(args.projectPath, 'node_modules'), path.join(args.wtDir, 'node_modules'), 'dir'); },
    }),
  });
  try {
    assert.equal((await review(reviewArgs('full'))).status, 'ready');
    assert.deepEqual(populated, [{ projectPath: fs.realpathSync(preferred), wtDir: populated[0]?.wtDir, shareList: ['node_modules'], keepTrackableLinks: true }]);
    assert.match(spawns[0]?.prompt ?? '', /node_modules in the checkout is a read-only link/);
    assert.deepEqual(spawns[0]?.settingsSandbox, teamReviewSandbox(spawns[0]?.workDir ?? '', fs.realpathSync(preferred)));
  } finally {
    cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pull request that commits its own node_modules link is reviewed without dependencies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-foreign-link-'));
  const checkout = path.join(root, 'checkout');
  const foreignModules = path.join(root, 'foreign-modules');
  fs.mkdirSync(path.join(checkout, 'node_modules'), { recursive: true });
  fs.mkdirSync(foreignModules);
  const warnings: string[] = [];
  const { review, spawns, cleanup } = setup({
    readLocalCheckoutConfig: () => ({ projects: [{ path: checkout }] }),
    log: { warn: (message) => { warnings.push(message); } },
    gitWorkspace: checkoutSharingWorkspace({
      stageDetachedWorktree: async ({ worktreePath }) => {
        fs.mkdirSync(String(worktreePath), { recursive: true });
        fs.symlinkSync(foreignModules, path.join(String(worktreePath), 'node_modules'), 'dir');
        return { ok: true };
      },
      populate: async () => {},
    }),
  });
  try {
    assert.equal((await review(reviewArgs('full'))).status, 'ready');
    assert.match(spawns[0]?.prompt ?? '', /No dependencies are installed/);
    assert.deepEqual(spawns[0]?.settingsSandbox, teamReviewSandbox(spawns[0]?.workDir ?? ''));
    assert.match(warnings.join('\n'), /node_modules could not be linked/);
  } finally {
    cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

test('local checkout sharing sorts root children and skips hidden and node_modules directories', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-roots-'));
  const populated: string[] = [];
  for (const name of ['z-last', 'a-first', '.hidden', 'node_modules']) {
    fs.mkdirSync(path.join(root, name, 'node_modules'), { recursive: true });
  }
  const { review, cleanup } = setup({
    readLocalCheckoutConfig: () => ({ projects: [], repoRoots: [root] }),
    gitWorkspace: checkoutSharingWorkspace({
      originUrl: async () => 'ssh://git@github.com/Acme/app.git',
      populate: async ({ projectPath, wtDir }) => { populated.push(projectPath); fs.symlinkSync(path.join(projectPath, 'node_modules'), path.join(wtDir, 'node_modules'), 'dir'); },
    }),
  });
  try {
    assert.equal((await review(reviewArgs('stamp'))).status, 'ready');
    assert.deepEqual(populated, [fs.realpathSync(path.join(root, 'a-first'))]);
  } finally {
    cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local checkout sharing skips nonmatching origins and checkouts without dependencies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-no-share-'));
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(checkout);
  const populated: string[] = [];
  let originReads = 0;
  let origin = 'https://github.com/Acme/app';
  const { review, spawns, cleanup } = setup({
    readLocalCheckoutConfig: () => ({ projects: [{ path: checkout }, { path: checkout }], repoRoots: [] }),
    gitWorkspace: checkoutSharingWorkspace({
      originUrl: async () => { originReads += 1; return origin; },
      populate: async ({ projectPath }) => { populated.push(projectPath); },
    }),
  });
  try {
    assert.equal((await review(reviewArgs('full'))).status, 'ready');
    fs.mkdirSync(path.join(checkout, 'node_modules'));
    origin = 'https://github.com/Acme/other';
    assert.equal((await review(reviewArgs('full'))).status, 'ready');
    assert.deepEqual(populated, []);
    assert.equal(originReads, 1);
    for (const spawn of spawns) assert.match(spawn.prompt, /No dependencies are installed/);
  } finally {
    cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local checkout discovery reads the current project configuration for each review', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-live-config-'));
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(path.join(checkout, 'node_modules'), { recursive: true });
  const projects: { path: string }[] = [];
  const { review, spawns, cleanup } = setup({
    readLocalCheckoutConfig: () => ({ projects }),
    gitWorkspace: checkoutSharingWorkspace(),
  });
  try {
    assert.equal((await review(reviewArgs('full'))).status, 'ready');
    projects.push({ path: checkout });
    assert.equal((await review(reviewArgs('full'))).status, 'ready');
    assert.match(spawns[0]?.prompt ?? '', /No dependencies are installed/);
    assert.match(spawns[1]?.prompt ?? '', /node_modules in the checkout is a read-only link/);
  } finally {
    cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed dependency share logs a warning and review continues without dependencies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-share-fail-'));
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(path.join(checkout, 'node_modules'), { recursive: true });
  const warnings: string[] = [];
  const { review, spawns, cleanup } = setup({
    readLocalCheckoutConfig: () => ({ projects: [{ path: checkout }] }),
    log: { warn: (message) => { warnings.push(message); } },
    gitWorkspace: checkoutSharingWorkspace({
      originUrl: async () => 'https://github.com/Acme/app.git',
      populate: async () => { throw new Error('share refused'); },
    }),
  });
  try {
    assert.equal((await review(reviewArgs('full'))).status, 'ready');
    assert.match(warnings.join('\n'), /\[team-review\].*share refused/);
    assert.match(spawns[0]?.prompt ?? '', /No dependencies are installed/);
  } finally {
    cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local checkout sharing excludes the cache clone and both review roots', async () => {
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-cache-exclude-'));
  const cached = path.join(cacheHome, 'team-review-repos', 'Acme', 'app');
  fs.mkdirSync(path.join(cached, 'node_modules'), { recursive: true });
  let workRoot = '';
  let worktreeRoot = '';
  const populated: string[] = [];
  const { review, workRoot: reviewWorkRoot, worktreeRoot: reviewWorktreeRoot, cleanup } = setup({
    repoCacheRoot: path.join(cacheHome, 'team-review-repos'),
    repoCache: {
      listRepos: async () => [],
      ensureRepo: async () => cached,
      fetchPr: async () => ({ ok: true, headSha: HEAD, err: '' }),
      hydrateRange: async () => ({ ok: true, err: '' }),
      hydrateSince: async () => true,
    },
    readLocalCheckoutConfig: () => ({ projects: [cached, path.join(workRoot, 'clone'), path.join(worktreeRoot, 'clone')].map((checkoutPath) => ({ path: checkoutPath })) }),
    gitWorkspace: checkoutSharingWorkspace({
      populate: async ({ projectPath }) => { populated.push(projectPath); },
    }),
  });
  workRoot = reviewWorkRoot;
  worktreeRoot = reviewWorktreeRoot;
  fs.mkdirSync(path.join(workRoot, 'clone', 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(worktreeRoot, 'clone', 'node_modules'), { recursive: true });
  try {
    assert.equal((await review(reviewArgs('full'))).status, 'ready');
    assert.deepEqual(populated, []);
  } finally {
    cleanup();
    fs.rmSync(cacheHome, { recursive: true, force: true });
  }
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
    assert.deepEqual(spawns[0]?.spawnEnv, teamReviewSpawnEnv(workDir));
    assert.equal(spawns[0]?.workDirFiles.includes('tmp'), false);
    assert.deepEqual(spawns[0]?.settingsSandbox, teamReviewSandbox(workDir));
    assert.deepEqual(timeouts, [78000]);
  } finally {
    cleanup();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});

test('a resumed review whose checkout links a local clone still denies reads of that clone', async () => {
  const localClone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-resume-clone-')));
  fs.mkdirSync(path.join(localClone, 'node_modules'));
  const { dispatch, spawns, workRoot, worktreeRoot, cleanup } = setup({
    now: () => 3000, readLocalCheckoutConfig: () => ({ projects: [{ path: localClone }] }), gitWorkspace: checkoutSharingWorkspace(),
  });
  const workDir = fs.mkdtempSync(path.join(workRoot, 'resume-work-'));
  const worktreePath = fs.mkdtempSync(path.join(worktreeRoot, 'resume-tree-'));
  fs.symlinkSync(path.join(localClone, 'node_modules'), path.join(worktreePath, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(workDir, REVIEW_PROMPT_FILENAME), 'original prompt');
  const resume = { sessionId: 'claude-1', workDir, worktreePath, head: HEAD, deadlineAt: 81000, savedAt: 1000 };
  try {
    const outcome = await dispatch({ ...reviewArgs('full'), resume });
    if ('kind' in outcome) throw new Error('expected a draft');
    assert.deepEqual(spawns[0]?.settingsSandbox, teamReviewSandbox(workDir, localClone));
  } finally {
    cleanup();
    fs.rmSync(localClone, { recursive: true, force: true });
  }
});

test('a resumed review whose checkout links a directory other than the discovered clone denies no clone paths', async () => {
  const localClone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-resume-clone-')));
  const foreignClone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-resume-foreign-')));
  fs.mkdirSync(path.join(localClone, 'node_modules'));
  fs.mkdirSync(path.join(foreignClone, 'node_modules'));
  const { dispatch, spawns, workRoot, worktreeRoot, cleanup } = setup({
    now: () => 3000, readLocalCheckoutConfig: () => ({ projects: [{ path: localClone }] }), gitWorkspace: checkoutSharingWorkspace(),
  });
  const workDir = fs.mkdtempSync(path.join(workRoot, 'resume-work-'));
  const worktreePath = fs.mkdtempSync(path.join(worktreeRoot, 'resume-tree-'));
  fs.symlinkSync(path.join(foreignClone, 'node_modules'), path.join(worktreePath, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(workDir, REVIEW_PROMPT_FILENAME), 'original prompt');
  const resume = { sessionId: 'claude-1', workDir, worktreePath, head: HEAD, deadlineAt: 81000, savedAt: 1000 };
  try {
    const outcome = await dispatch({ ...reviewArgs('full'), resume });
    if ('kind' in outcome) throw new Error('expected a draft');
    assert.deepEqual(spawns[0]?.settingsSandbox, teamReviewSandbox(workDir));
  } finally {
    cleanup();
    fs.rmSync(localClone, { recursive: true, force: true });
    fs.rmSync(foreignClone, { recursive: true, force: true });
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

test('every tier runs the review from a throwaway work dir, and no argv entry names the staged checkout of the head', async () => {
  for (const tier of ['stamp', 'full'] as const) {
    const { review, staged, removed, hydrations, spawns, worktreeRoot, cleanup } = setup();
    try {
      const draft = await review(reviewArgs(tier));
      assert.equal(draft.status, 'ready');
      assert.equal(draft.tier, tier);
      const expectedWorktree = path.join(worktreeRoot, 'glimmervoid-wt-team-review-Acme-app-7-abcd');
      assert.deepEqual(staged, [expectedWorktree]);
      assert.deepEqual(removed, [expectedWorktree]);
      assert.deepEqual(hydrations, [`Acme/app#7@${HEAD}`]);
      assert.notEqual(spawns[0].cwd, expectedWorktree);
      assert.equal(spawns[0].cwd, spawns[0].workDir);
      assert.equal(spawns[0].extraClaudeArgs.some((arg) => arg.includes(expectedWorktree)), false, 'the untrusted checkout is never an added dir');
      assert.equal(spawns[0].extraClaudeArgs.includes('--add-dir'), false);
      assert.deepEqual(spawns[0].workDirFiles, ['gh-config', REVIEW_PROMPT_FILENAME]);
      assert.deepEqual(spawns[0].spawnEnv, teamReviewSpawnEnv(spawns[0].workDir));
      assert.deepEqual(spawns[0].settingsSandbox, teamReviewSandbox(spawns[0].workDir));
      assert.match(spawns[0].prompt, /whatever review skills or tools you have available/);
      assert.ok(spawns[0].prompt.includes(`git -C ${expectedWorktree}`));
      assert.ok(spawns[0].prompt.includes(path.join(spawns[0].workDir, REVIEW_REPORT_FILENAME)));
      assert.equal(spawns[0].id, 'team-review:Acme/app#7');
      const args = spawns[0].extraClaudeArgs;
      assert.equal(args[args.indexOf('--model') + 1], tier === 'full' ? FULL_MODEL : STAMP_MODEL);
      assert.equal(fs.existsSync(spawns[0].workDir), false, 'the throwaway dir is removed afterwards');
      assert.equal(isDispatchWorkdir(spawns[0].cwd), true, 'ingest must recognise the work dir cwd as the lane dispatch');
      assert.equal(isDispatchWorkdir(expectedWorktree), true);
    } finally {
      cleanup();
    }
  }
});

test('the report becomes a draft rendered in the pr-review posting format', async () => {
  const { review, cleanup } = setup();
  try {
    const draft = await review(reviewArgs('full'));
    assert.equal(draft.verdict, 'APPROVE WITH NITS');
    assert.equal(draft.summary, 'one nit');
    assert.equal(draft.comments.length, 1);
    assert.equal(draft.comments[0]?.line, 2);
    assert.match(draft.comments[0]?.body ?? '', /\*\*\[code\/logic\] MEDIUM\*\*/);
    assert.equal(draft.body, AUTOMATED_REVIEW_NOTE);
  } finally {
    cleanup();
  }
});

test('a Step 4 posting plan from the skill becomes the draft verbatim, and a bad one falls back to the findings', async () => {
  const inlineBody = `${AUTOMATED_REVIEW_NOTE}\n\n**[code/logic] MEDIUM**\n\nNit on the new line.\n\nSuggested fix: rename it.`;
  const plan = { event: 'COMMENT', body: 'Automated review. See inline comments.', commit_id: HEAD, comments: [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: inlineBody }] };
  const warnings: string[] = [];
  const withPlan = setup({
    writeReport: (workDir) => {
      fs.writeFileSync(path.join(workDir, REVIEW_REPORT_FILENAME), reportText());
      fs.writeFileSync(path.join(workDir, REVIEW_POSTING_FILENAME), JSON.stringify(plan));
    },
  });
  const badPlan = setup({
    log: { warn: (message: string) => { warnings.push(message); } },
    writeReport: (workDir) => {
      fs.writeFileSync(path.join(workDir, REVIEW_REPORT_FILENAME), reportText());
      fs.writeFileSync(path.join(workDir, REVIEW_POSTING_FILENAME), JSON.stringify({ ...plan, commit_id: OTHER_HEAD }));
    },
  });
  try {
    const draft = await withPlan.review(reviewArgs('full'));
    assert.equal(draft.body, `${AUTOMATED_REVIEW_NOTE}\n\nAutomated review. See inline comments.`);
    assert.deepEqual(draft.comments, [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: inlineBody }]);
    assert.equal(draft.verdict, 'APPROVE WITH NITS');
    assert.ok(withPlan.spawns[0].prompt.includes(path.join(withPlan.spawns[0].workDir, REVIEW_POSTING_FILENAME)));
    const fallback = await badPlan.review(reviewArgs('full'));
    assert.equal(fallback.body, AUTOMATED_REVIEW_NOTE);
    assert.match(warnings.join('\n'), /targets/);
  } finally {
    withPlan.cleanup();
    badPlan.cleanup();
  }
});

test('a finding off the diff lines folds into the review body, and without a diff every line finding stays inline', async () => {
  const offDiff = setup({ diff: 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-x\n+y\n' });
  const noDiff = setup({ diff: null });
  try {
    const folded = await offDiff.review(reviewArgs('full'));
    assert.deepEqual(folded.comments, []);
    assert.match(folded.body, /`src\/a.ts:2`: Nit on the new line\./);
    assert.equal((await noDiff.review(reviewArgs('full'))).comments.length, 1);
  } finally {
    offDiff.cleanup();
    noDiff.cleanup();
  }
});

test('a review removes the worktree when the session throws', async () => {
  const { review, removed, staged, cleanup } = setup({ spawnSession: async () => { throw new Error('spawn refused'); } });
  try {
    const draft = await review(reviewArgs('full'));
    assert.equal(draft.status, 'error');
    assert.equal(draft.error, 'spawn refused');
    assert.deepEqual(removed, staged);
    assert.equal(removed.length, 1);
  } finally {
    cleanup();
  }
});

test('a review removes the worktree when it times out', async () => {
  let wasAborted = false;
  const { review, removed, cleanup } = setup({
    timeoutSeconds: 1,
    setTimeoutFn: (fn) => setTimeout(fn, 0),
    spawnSession: ({ signal }) => new Promise<void>((resolve) => {
      const liveSessionHandle = setInterval(() => {}, 1000);
      signal.addEventListener('abort', () => { clearInterval(liveSessionHandle); wasAborted = true; resolve(); }, { once: true });
    }),
  });
  try {
    const draft = await review(reviewArgs('full'));
    assert.equal(draft.status, 'error');
    assert.match(draft.error ?? '', /timed out/);
    assert.equal(wasAborted, true);
    assert.equal(removed.length, 1);
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

test('a failed worktree stage still runs the removal and never spawns', async () => {
  const removedPaths: string[] = [];
  let spawnCount = 0;
  const { review, cleanup } = setup({
    gitWorkspace: {
      stageDetachedWorktree: async () => ({ ok: false, err: 'fatal: already exists' }),
      removeWorktreeByPath: async ({ cwd }) => { removedPaths.push(String(cwd)); return { ok: true }; },
      pruneWorktrees: async () => ({ ok: true }),
      originUrl: async () => null,
      populate: async () => {},
    },
    spawnSession: async () => { spawnCount += 1; },
  });
  try {
    const draft = await review(reviewArgs('stamp'));
    assert.equal(draft.status, 'error');
    assert.match(draft.error ?? '', /already exists/);
    assert.equal(spawnCount, 0);
    assert.equal(removedPaths.length, 1);
  } finally {
    cleanup();
  }
});

test('a failed blob hydration is an error draft that never spawns, and the checkout is still removed', async () => {
  const { review, staged, removed, spawns, cleanup } = setup({ hydrated: false, hydratedErr: 'fatal: missing blob\nmore detail' });
  try {
    const draft = await review(reviewArgs('full'));
    assert.equal(draft.status, 'error');
    assert.equal(draft.error, 'could not fetch the file contents of Acme/app#7: fatal: missing blob');
    assert.equal(spawns.length, 0);
    assert.deepEqual(removed, staged);
  } finally {
    cleanup();
  }
});

test('the review session env withholds every GitHub credential and blanks the glimmervoid secrets', () => {
  assert.deepEqual(teamReviewSpawnEnv('/work'), {
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GH_ENTERPRISE_TOKEN: '',
    GITHUB_ENTERPRISE_TOKEN: '',
    GH_CONFIG_DIR: path.join('/work', 'gh-config'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_SSH_COMMAND: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'remote.origin.pushurl',
    GIT_CONFIG_VALUE_1: 'https://push-disabled.invalid/',
    GLIMMERVOID_POSTHOG_API_KEY: '',
    GLIMMERVOID_TELEGRAM_BOT_TOKEN: '',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  });
});

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

test('a fetched head that differs from the triaged head is an error draft, with nothing staged or spawned', async () => {
  const { review, staged, spawns, cleanup } = setup({ fetchedHead: OTHER_HEAD });
  try {
    const draft = await review(reviewArgs('full'));
    assert.equal(draft.status, 'error');
    assert.equal(draft.reviewedHead, HEAD);
    assert.match(draft.error ?? '', /not the triaged head/);
    assert.deepEqual(staged, []);
    assert.equal(spawns.length, 0);
  } finally {
    cleanup();
  }
});

test('a missing, unreadable or failed report is an error draft', async () => {
  const missing = setup({ writeReport: () => {} });
  const garbled = setup({ writeReport: (workDir) => fs.writeFileSync(path.join(workDir, REVIEW_REPORT_FILENAME), 'looks fine to me') });
  const failedRun = setup({
    writeReport: (workDir) => fs.writeFileSync(path.join(workDir, REVIEW_REPORT_FILENAME), reportText().replace('VERDICT: APPROVE WITH NITS', 'VERDICT: FAILED')),
  });
  try {
    const missingDraft = await missing.review(reviewArgs('stamp'));
    assert.equal(missingDraft.status, 'error');
    assert.equal(missingDraft.error, 'no review report');
    assert.equal((await garbled.review(reviewArgs('stamp'))).status, 'error');
    assert.match((await failedRun.review(reviewArgs('stamp'))).error ?? '', /did not complete/);
  } finally {
    missing.cleanup();
    garbled.cleanup();
    failedRun.cleanup();
  }
});

test('a report whose head is not the provided head is an error draft', async () => {
  const { review, cleanup } = setup({ writeReport: (workDir) => fs.writeFileSync(path.join(workDir, REVIEW_REPORT_FILENAME), reportText(OTHER_HEAD)) });
  try {
    const draft = await review(reviewArgs('stamp'));
    assert.equal(draft.status, 'error');
    assert.equal(draft.reviewedHead, HEAD);
    assert.match(draft.error ?? '', /not the reviewed head/);
  } finally {
    cleanup();
  }
});

test('the sandbox fails closed, binds a strict egress allowlist, and keeps credential paths unreadable', () => {
  const sandbox = teamReviewSandbox('/work/dir');
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.failIfUnavailable, true, 'no bubblewrap means an error draft, never an unsandboxed run');
  assert.equal(sandbox.allowUnsandboxedCommands, false);
  assert.equal(sandbox.enableWeakerNetworkIsolation, true, 'macOS TLS verification needs trustd');
  assert.equal(sandbox.network.strictAllowlist, true, 'without it the domain list is advisory');
  assert.equal(sandbox.network.allowLocalBinding, true);
  assert.equal(sandbox.network.allowAllUnixSockets, true);
  assert.deepEqual(sandbox.network.allowedDomains, ['api.github.com', 'chatgpt.com', '*.chatgpt.com', 'auth.openai.com', 'api.openai.com', '*.openai.com']);
  assert.deepEqual(sandbox.filesystem.allowWrite, ['~/.codex', '/work/dir']);
  assert.deepEqual(sandbox.filesystem.denyWrite, ['~/.codex/config.toml', '~/.codex/AGENTS.md', '~/.codex/skills', '~/.codex/rules', '~/.codex/prompts', '~/.codex/hooks.json']);
  assert.deepEqual(sandbox.filesystem.denyRead, ['~/.ssh', '~/.config/gh', '~/Library/Keychains', '~/.git-credentials']);
  assert.deepEqual(Object.keys(sandbox).sort(), ['allowUnsandboxedCommands', 'enableWeakerNetworkIsolation', 'enabled', 'failIfUnavailable', 'filesystem', 'network']);
  assert.deepEqual(Object.keys(sandbox.network).sort(), ['allowAllUnixSockets', 'allowLocalBinding', 'allowedDomains', 'strictAllowlist']);
  assert.deepEqual(Object.keys(sandbox.filesystem).sort(), ['allowWrite', 'denyRead', 'denyWrite']);
  assert.notEqual(teamReviewSandbox('/a').network.allowedDomains, teamReviewSandbox('/b').network.allowedDomains, 'each call hands out fresh arrays');
  assert.notEqual(teamReviewSandbox('/a').filesystem.denyWrite, teamReviewSandbox('/b').filesystem.denyWrite, 'each call hands out fresh arrays');
});

test('a review that linked a local clone also denies reads of that clone env files and Claude settings', () => {
  const localClone = path.join(path.sep, 'repos', 'app');
  const sandbox = teamReviewSandbox('/work/dir', localClone);
  assert.deepEqual(sandbox.filesystem.denyRead, [
    '~/.ssh', '~/.config/gh', '~/Library/Keychains', '~/.git-credentials',
    path.join(localClone, '.env'), path.join(localClone, '.env.*'), path.join(localClone, '.claude'),
  ]);
  assert.deepEqual(sandbox.filesystem.allowWrite, ['~/.codex', '/work/dir']);
});

test('the posture denies every GitHub path, loads no MCP server, runs without prompts, and pins the model last', () => {
  const posture = teamReviewPermissions();
  assert.equal(posture.defaultMode, 'bypassPermissions');
  for (const rule of ['Bash(gh:*)', 'Bash(git push:*)', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch']) assert.ok(posture.deny.includes(rule), rule);
  assert.deepEqual([...TEAM_REVIEW_DENY_RULES], posture.deny);
  assert.equal(posture.deny.includes('Bash'), false, 'pr-review needs git in a shell');
  for (const tier of ['stamp', 'full'] as const) {
    const args = teamReviewClaudeArgs(tier);
    assert.deepEqual(args.slice(0, 3), ['-p', '--strict-mcp-config', '--disallowedTools']);
    assert.equal(args.includes('--add-dir'), false, 'an added dir loads its .claude/skills, so the checkout is reached by path only');
    assert.deepEqual(args.slice(args.indexOf('--disallowedTools') + 1, -2), [...TEAM_REVIEW_DENY_RULES], 'the argv carries the denies even when no hook settings file is written');
    assert.deepEqual(args.slice(-2), ['--model', tier === 'full' ? FULL_MODEL : STAMP_MODEL]);
    assert.equal(args.includes('--setting-sources'), false, 'the operator profile carries the pr-review skill');
    assert.equal(args.includes('--disable-slash-commands'), false);
  }
});

test('the spawned session runs the constant bootstrap prompt with the given env, without permission prompts, attributed to the lane', async () => {
  const created: SessionOptions[] = [];
  const recorded: string[] = [];
  const capturedIds: string[] = [];
  const reviewSessions = new Map<string, unknown>();
  const spawn = createTeamReviewSpawn({
    reviewSessions,
    closeSessionDataClients: () => {},
    hookRouter: null,
    getHookPort: null,
    spawnGate: { run: async (task) => task() },
    recordLane: (_id, lane) => { recorded.push(lane); },
    makeSession: (options) => {
      created.push(options);
      const session = new Session(options);
      session.start = async () => {
        session.emit('claude-session-id', { id: 'claude-1' });
        session.emit('exit');
      };
      return session;
    },
  });
  const posture = teamReviewPermissions();
  const request: Parameters<TeamReviewSpawn>[0] = {
    id: 'team-review:Acme/app#7', name: 'Team review Acme/app#7', cwd: '/tmp/x', spawnEnv: teamReviewSpawnEnv('/tmp/x'),
    extraClaudeArgs: teamReviewClaudeArgs('stamp'), settingsPermissions: posture, settingsSandbox: teamReviewSandbox('/tmp/x'),
    signal: new AbortController().signal,
    onSessionId: (id) => { capturedIds.push(id); },
  };
  await spawn(request);
  assert.equal(created[0].initialPrompt, REVIEW_BOOTSTRAP_PROMPT);
  assert.equal(REVIEW_BOOTSTRAP_PROMPT, `Read ${REVIEW_PROMPT_FILENAME} and follow all instructions in that file`);
  assert.equal(created[0].path, '/tmp/x');
  assert.deepEqual(created[0].spawnEnv, teamReviewSpawnEnv('/tmp/x'));
  assert.equal(created[0].dangerouslySkipPermissions, true);
  assert.deepEqual(created[0].settingsPermissions, posture);
  assert.deepEqual(created[0].settingsSandbox, teamReviewSandbox('/tmp/x'));
  assert.equal(created[0].ephemeral, true);
  assert.equal(created[0].observeToolCalls, false, 'no tool hook is installed when nobody listens');
  assert.deepEqual(recorded, ['team-review']);
  assert.deepEqual(capturedIds, ['claude-1']);
  await spawn({ ...request, id: 'team-review:Acme/app#7:resume', resumeSessionId: 'claude-1', initialPrompt: REVIEW_RESUME_PROMPT });
  assert.equal(created[1].resumeSessionId, 'claude-1');
  assert.equal(created[1].initialPrompt, REVIEW_RESUME_PROMPT);
});

test('a review whose sandbox cannot be applied ends as an error draft without spawning an agent', async () => {
  const created: SessionOptions[] = [];
  const { review, cleanup } = setup({
    spawnSession: createTeamReviewSpawn({
      reviewSessions: new Map<string, unknown>(),
      closeSessionDataClients: () => {},
      hookRouter: null,
      getHookPort: null,
      spawnGate: { run: async (task) => task() },
      makeSession: (options) => {
        created.push(options);
        return new Session({ ...options, ptySpawn: () => { throw new Error('an unsandboxed review must never spawn'); } });
      },
    }),
  });
  try {
    const draft = await review(reviewArgs('stamp'));
    assert.equal(draft.status, 'error');
    assert.equal(draft.error, SANDBOX_UNAPPLIED_ERROR);
    assert.ok(created[0].settingsSandbox, 'the review asked for a sandbox');
  } finally {
    cleanup();
  }
});

test('the spawned session forwards PreToolUse hook events as tool steps and ignores other hooks', async () => {
  const created: SessionOptions[] = [];
  const steps: { tool: string; detail: string }[] = [];
  const spawn = createTeamReviewSpawn({
    reviewSessions: new Map<string, unknown>(),
    closeSessionDataClients: () => {},
    hookRouter: null,
    getHookPort: null,
    spawnGate: { run: async (task) => task() },
    makeSession: (options) => {
      created.push(options);
      const session = new Session(options);
      session.start = async () => {
        session.emit('hook-event', { event: 'PreToolUse', payload: { tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } } });
        session.emit('hook-event', { event: 'Stop', payload: {} });
        session.emit('exit');
      };
      return session;
    },
  });
  await spawn({
    id: 'team-review:Acme/app#7', name: 'Team review Acme/app#7', cwd: '/tmp/x', spawnEnv: teamReviewSpawnEnv('/tmp/x'),
    extraClaudeArgs: teamReviewClaudeArgs('stamp'), settingsPermissions: teamReviewPermissions(), settingsSandbox: teamReviewSandbox('/tmp/x'),
    signal: new AbortController().signal, onToolStep: (step) => { steps.push(step); },
  });
  assert.equal(created[0].observeToolCalls, true);
  assert.deepEqual(steps, [{ tool: 'Read', detail: 'src/a.ts' }]);
});

test('a review reports checkout then reviewing with the timeout, and forwards tool steps', async () => {
  const events: ReviewProgressEvent[] = [];
  const { review, cleanup } = setup({
    timeoutSeconds: 30,
    spawnSession: async (call) => {
      call.onToolStep?.({ tool: 'Skill', detail: 'pr-review' });
      fs.writeFileSync(path.join(workDirOf(call), REVIEW_REPORT_FILENAME), reportText());
    },
  });
  try {
    const draft = await review({ ...reviewArgs('stamp'), reportProgress: (event) => { events.push(event); } });
    assert.equal(draft.status, 'ready');
    assert.deepEqual(events, [
      { kind: 'phase', phase: 'checkout', tier: 'stamp', reasons: ['a reason'] },
      { kind: 'phase', phase: 'reviewing', tier: 'stamp', reasons: ['a reason'], timeoutSeconds: 30 },
      { kind: 'step', tool: 'Skill', detail: 'pr-review' },
    ]);
  } finally {
    cleanup();
  }
});

test('the lane starts only when enabled with both org and team', () => {
  assert.equal(teamReviewShouldStart({}).start, false);
  assert.equal(teamReviewShouldStart({ teamReview: { enabled: true, org: 'Acme' } }).start, false);
  assert.equal(teamReviewShouldStart({ teamReview: { enabled: false, org: 'Acme', team: 'core' } }).start, false);
  assert.equal(teamReviewShouldStart({ teamReview: { enabled: true, org: 'Acme', team: 'core' } }).start, true);
});

test('the configured review skill reaches the prompt of each review as it is read at spawn time', async () => {
  let configuredSkill = 'my-review';
  const { review, spawns, cleanup } = setup({ readReviewSkill: () => configuredSkill });
  try {
    await review(reviewArgs('full'));
    configuredSkill = '';
    await review(reviewArgs('full'));
    assert.match(spawns[0].prompt, /Invoke the my-review skill with the Skill tool/);
    assert.doesNotMatch(spawns[1].prompt, /Skill tool/);
  } finally {
    cleanup();
  }
});

test('team review settings use configurable positive review and idle windows', () => {
  assert.deepEqual(readTeamReviewSettings({}), { enabled: false, org: '', team: '', reReviewAfterHours: 24, skipIdleAfterDays: 14, skill: '', autoRebaseMyPrs: false });
  assert.deepEqual(readTeamReviewSettings({ teamReview: { enabled: true, org: ' Acme ', team: ' core ', reReviewAfterHours: 6, skipIdleAfterDays: 3, skill: ' my-review ', autoRebaseMyPrs: true } }), {
    enabled: true, org: 'Acme', team: 'core', reReviewAfterHours: 6, skipIdleAfterDays: 3, skill: 'my-review', autoRebaseMyPrs: true,
  });
  assert.equal(readTeamReviewSettings({ teamReview: { autoRebaseMyPrs: 'yes' } }).autoRebaseMyPrs, false);
});

test('a failed worktree removal still deletes the checkout directory and prunes the cached clone', async () => {
  const warnings: string[] = [];
  const pruned: string[] = [];
  const { review, worktreeRoot, cleanup } = setup({
    log: { warn: (message: string) => { warnings.push(message); } },
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => {
        fs.mkdirSync(path.join(String(worktreePath), '.git'), { recursive: true });
        return { ok: true };
      },
      removeWorktreeByPath: async () => ({ ok: false, err: 'fatal: validation failed, cannot remove working tree' }),
      pruneWorktrees: async ({ projectPath }) => { pruned.push(projectPath); return { ok: true }; },
      originUrl: async () => null,
      populate: async () => {},
    },
  });
  try {
    const draft = await review(reviewArgs('full'));
    assert.equal(draft.status, 'ready');
    assert.deepEqual(fs.readdirSync(worktreeRoot), []);
    assert.deepEqual(pruned, ['/cache/Acme/app']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /validation failed/);
  } finally {
    cleanup();
  }
});

test('fallback checkout removal leaves the linked dependency directory intact', async () => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-linked-target-'));
  const localCheckout = path.join(localRoot, 'checkout');
  const localModules = path.join(localCheckout, 'node_modules');
  fs.mkdirSync(localModules, { recursive: true });
  fs.writeFileSync(path.join(localModules, 'keep.txt'), 'keep');
  const { review, worktreeRoot, cleanup } = setup({
    readLocalCheckoutConfig: () => ({ projects: [{ path: localCheckout }] }),
    log: { warn: () => {} },
    gitWorkspace: checkoutSharingWorkspace({
      populate: async ({ wtDir }) => { fs.symlinkSync(localModules, path.join(wtDir, 'node_modules'), 'dir'); },
      removeWorktreeByPath: async () => ({ ok: false, err: 'remove failed' }),
    }),
  });
  try {
    assert.equal((await review(reviewArgs('full'))).status, 'ready');
    assert.deepEqual(fs.readdirSync(worktreeRoot), []);
    assert.equal(fs.readFileSync(path.join(localModules, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    cleanup();
    fs.rmSync(localRoot, { recursive: true, force: true });
  }
});

test('a worktree removal that reports success but leaves the directory still deletes it', async () => {
  const { review, pruned, worktreeRoot, cleanup } = setup({
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => { fs.mkdirSync(String(worktreePath), { recursive: true }); return { ok: true }; },
      removeWorktreeByPath: async () => ({ ok: true }),
      pruneWorktrees: async () => ({ ok: true }),
      originUrl: async () => null,
      populate: async () => {},
    },
    log: { warn: () => {} },
  });
  try {
    await review(reviewArgs('full'));
    assert.deepEqual(fs.readdirSync(worktreeRoot), []);
    assert.deepEqual(pruned, []);
  } finally {
    cleanup();
  }
});

test('the start sweep deletes every leftover checkout and prunes each cached clone', async () => {
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-sweep-test-'));
  const pruned: string[] = [];
  const reapedDirectories: string[][] = [];
  try {
    fs.mkdirSync(path.join(worktreeRoot, 'Acme-app-7-dead', '.git'), { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, 'Acme-app-7-dead', 'file.ts'), 'x');
    fs.mkdirSync(path.join(worktreeRoot, 'Acme-lib-9-beef'));
    await sweepLeftoverCheckouts({
      worktreeRoot,
      workRoot: path.join(worktreeRoot, 'work'),
      keepPaths: new Set(),
      reapProcesses: async ({ ownedDirectories, reviewRoots, scope }) => {
        reapedDirectories.push([...ownedDirectories]);
        assert.deepEqual(reviewRoots, [path.join(worktreeRoot, 'work'), worktreeRoot]);
        assert.equal(scope, 'sweep');
        assert.equal(fs.existsSync(path.join(worktreeRoot, 'Acme-app-7-dead')), true);
      },
      repoCache: { listRepos: async () => ['/cache/Acme/app', '/cache/Acme/lib'] },
      gitWorkspace: { pruneWorktrees: async ({ projectPath }) => { pruned.push(projectPath); return { ok: true }; } },
      log: { warn: () => {} },
    });
    assert.deepEqual(fs.readdirSync(worktreeRoot), []);
    assert.deepEqual(reapedDirectories, [[path.join(worktreeRoot, 'work'), worktreeRoot]]);
    assert.deepEqual(pruned, ['/cache/Acme/app', '/cache/Acme/lib']);
  } finally {
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('the start sweep tolerates a missing worktree root', async () => {
  const pruned: string[] = [];
  await sweepLeftoverCheckouts({
    worktreeRoot: path.join(os.tmpdir(), `team-review-absent-${process.pid}-${Date.now()}`),
    workRoot: path.join(os.tmpdir(), `team-review-work-absent-${process.pid}-${Date.now()}`),
    keepPaths: new Set(),
    reapProcesses: async () => {},
    repoCache: { listRepos: async () => ['/cache/Acme/app'] },
    gitWorkspace: { pruneWorktrees: async ({ projectPath }) => { pruned.push(projectPath); return { ok: true }; } },
    log: { warn: () => {} },
  });
  assert.deepEqual(pruned, ['/cache/Acme/app']);
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
    github: {
      viewer: async () => null, teamProfile: async () => null, teamMembers: async () => [], searchDirectRequested: async () => ({ items: [], complete: true }), searchTeamRequested: async () => ({ items: [], complete: true }),
      searchAuthoredBy: async () => ({ items: [], complete: true }), viewPr: async () => null, prHead: async () => null, prReviewSnapshots: async () => new Map(), rateLimitWaitMs: async () => null, prDiff: async () => null,
    },
    repoCache: {
      listRepos: async () => [], ensureRepo: async () => null,
      fetchPr: async () => ({ ok: false, headSha: null, err: '' }), hydrateRange: async () => ({ ok: false, err: '' }), hydrateSince: async () => false,
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

test('the empty lane status parses as the team-review-status contract', () => {
  assert.equal(TeamReviewStatus.safeParse(emptyTeamReviewStatus({ start: false, reason: 'teamReview needs both org and team' })).success, true);
  assert.equal(TeamReviewStatus.safeParse(emptyTeamReviewStatus({ start: true })).success, true);
});

function deferredSignal(): { promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void } {
  let resolve: () => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<void>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

test('stopping the lane aborts an in-flight full review, yields no draft, and resolves only after its checkout is removed', { timeout: 10_000 }, async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-home-test-'));
  const removed: string[] = [];
  let spawnReview: ((args: SpawnReviewArgs) => Promise<unknown>) | null = null;
  const pollerStarted = deferredSignal();
  const sessionRunning = deferredSignal();
  const wiring = createTeamReviewWiring({
    config: { teamReview: { enabled: true, org: 'Acme', team: 'core' } },
    reviewSessions: new Map(),
    closeSessionDataClients: () => {},
    hookRouter: null,
    getHookPort: null,
    spawnGate: { run: async (task) => task() },
    homeDir,
    reapProcesses: async () => {},
    log: { warn: () => {} },
    github: {
      viewer: async () => null, teamProfile: async () => null, teamMembers: async () => [], searchDirectRequested: async () => ({ items: [], complete: true }), searchTeamRequested: async () => ({ items: [], complete: true }),
      searchAuthoredBy: async () => ({ items: [], complete: true }), viewPr: async () => null, prHead: async () => null, prReviewSnapshots: async () => new Map(), rateLimitWaitMs: async () => null, prDiff: async () => 'diff\n',
    },
    repoCache: {
      listRepos: async () => [],
      ensureRepo: async () => '/cache/Acme/app',
      fetchPr: async () => ({ ok: true, headSha: HEAD, err: '' }),
      hydrateRange: async () => ({ ok: true, err: '' }),
      hydrateSince: async () => true,
    },
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => { fs.mkdirSync(String(worktreePath), { recursive: true }); return { ok: true }; },
      removeWorktreeByPath: async ({ cwd }) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        removed.push(String(cwd));
        fs.rmSync(String(cwd), { recursive: true, force: true });
        return { ok: true };
      },
      pruneWorktrees: async () => ({ ok: true }),
      originUrl: async () => null,
      populate: async () => {},
    },
    spawnSession: ({ signal }) => new Promise<void>((resolve) => {
      sessionRunning.resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    }),
    createPoller: (dependencies) => {
      spawnReview = dependencies.spawnReview;
      const poller = createTeamReviewPoller(dependencies);
      return {
        ...poller,
        start: async () => {
          await poller.start().catch((startError: unknown) => { pollerStarted.reject(startError); throw startError; });
          pollerStarted.resolve();
        },
      };
    },
  });
  try {
    wiring.startPoller();
    await pollerStarted.promise;
    const startReview = spawnReview as ((args: SpawnReviewArgs) => Promise<unknown>) | null;
    assert.ok(startReview);
    let isReviewSettled = false;
    const pending = startReview(reviewArgs('full')).then((draft) => { isReviewSettled = true; return draft; });
    const firstToSettle = await Promise.race([
      sessionRunning.promise.then(() => 'session running' as const),
      pending.then(() => 'review settled' as const),
    ]);
    assert.equal(firstToSettle, 'session running', 'the review settled before its session spawned');
    await wiring.stopPoller();
    assert.equal(removed.length, 1);
    assert.equal(isReviewSettled, true);
    const draft = await pending;
    assert.deepEqual(draft, { kind: 'stopped', resumable: null });
    assert.deepEqual(fs.readdirSync(path.join(homeDir, 'team-review-worktrees')), []);
  } finally {
    await wiring.stopPoller();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

const ACTION_KEY = 'Acme/app#7';
const ACTION_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' const port = 3000;',
  '-listen(port);',
  '+listen(port, host);',
  '+ready();',
  '',
].join('\n');
const COMMENT_ON_ADDED_LINE: ReviewComment = { path: 'src/app.ts', line: 3, side: 'RIGHT', body: 'Log this?' };
const COMMENT_OFF_DIFF: ReviewComment = { path: 'src/app.ts', line: 40, side: 'RIGHT', body: 'Not in the diff' };

type PostArgs = Parameters<TeamReviewActionGithub['postReview']>[0];
type DismissArgs = Parameters<TeamReviewActionGithub['dismissReview']>[0];

interface ActionHarnessOptions {
  headReads?: (string | null)[];
  diff?: string | null;
  postResult?: PostedReview;
  dismissResult?: { ok: boolean; err: string };
  holdPost?: Promise<void>;
  onPost?: () => void;
  draft?: Partial<ReviewDraftType>;
}

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
    const validEntry = { draft: actionDraft(), reviewedHead: HEAD, inFlight: false, skipReason: null, reviewAttempts: 1, updatedAt: 42 };
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

function actionHarness(options: ActionHarnessOptions = {}) {
  let draft = actionDraft(options.draft);
  const headReads = [...(options.headReads ?? [HEAD, HEAD])];
  const headLookups: string[] = [];
  const diffLookups: string[] = [];
  const posted: PostArgs[] = [];
  const dismissed: DismissArgs[] = [];
  const patches: DraftPatch[] = [];
  const requeues: string[] = [];
  const actions = createTeamReviewActions({
    drafts: {
      getDraft: (key) => (key === draft.key ? draft : null),
      updateDraft: async (key, expected, patch) => {
        if (key !== draft.key || draft.reviewedHead !== expected.reviewedHead || draft.status !== expected.status) return null;
        patches.push(patch);
        draft = ReviewDraft.parse({ ...draft, ...patch });
        return draft;
      },
      requeue: async (key, head) => {
        requeues.push(`${key}@${head}`);
        return key === draft.key && head === draft.reviewedHead && (draft.status === 'error' || draft.status === 'ready' || draft.status === 'stale' || draft.status === 'discarded' || draft.status === 'posted');
      },
    },
    github: {
      prHead: async (repo, number) => {
        headLookups.push(`${repo}#${number}`);
        return headReads.length > 0 ? (headReads.shift() ?? null) : HEAD;
      },
      prDiff: async (repo, number) => {
        diffLookups.push(`${repo}#${number}`);
        return options.diff === undefined ? ACTION_DIFF : options.diff;
      },
      postReview: async (review) => {
        posted.push(review);
        if (options.holdPost) await options.holdPost;
        options.onPost?.();
        return options.postResult ?? { ok: true, err: '', reviewId: 99 };
      },
      dismissReview: async (dismissal) => {
        dismissed.push(dismissal);
        return options.dismissResult ?? { ok: true, err: '' };
      },
    },
    log: { warn: () => {} },
  });
  const submit = (overrides: Partial<TeamReviewActionRequest> & Pick<TeamReviewActionRequest, 'action'>) => actions.submitAction({
    key: ACTION_KEY, head: HEAD, body: 'LGTM', comments: [], ...overrides,
  });
  return {
    submit, posted, dismissed, patches, requeues, headLookups, diffLookups,
    currentDraft: () => draft,
    replaceDraft: (next: ReviewDraftType) => { draft = next; },
  };
}

test('approve posts one APPROVE review carrying the hand-approval line, the body and the inline comments at the reviewed head', async () => {
  const h = actionHarness();
  assert.deepEqual(await h.submit({ action: 'approve', body: 'Ship it', comments: [COMMENT_ON_ADDED_LINE] }), { ok: true });
  assert.deepEqual(h.posted, [{
    repo: 'Acme/app', number: 7, commitId: HEAD, event: 'APPROVE', body: `${HAND_APPROVAL_LINE}\n\nShip it`, comments: [COMMENT_ON_ADDED_LINE],
  }]);
  assert.equal(h.currentDraft().status, 'posted');
  assert.equal(h.currentDraft().postedEvent, 'APPROVE');
  assert.equal(h.currentDraft().body, `${HAND_APPROVAL_LINE}\n\nShip it`);
  assert.deepEqual(h.currentDraft().comments, [COMMENT_ON_ADDED_LINE]);
  assert.deepEqual(h.dismissed, []);
});

test('approve-only ignores supplied body and comments and records only the hand approval', async () => {
  const h = actionHarness({ diff: null });
  assert.deepEqual(await h.submit({ action: 'approve-only', body: 'Ship it', comments: [COMMENT_ON_ADDED_LINE] }), { ok: true });
  assert.deepEqual(h.posted, [{
    repo: 'Acme/app', number: 7, commitId: HEAD, event: 'APPROVE', body: HAND_APPROVAL_LINE, comments: [],
  }]);
  assert.equal(h.currentDraft().status, 'posted');
  assert.equal(h.currentDraft().postedEvent, 'APPROVE');
  assert.equal(h.currentDraft().body, HAND_APPROVAL_LINE);
  assert.deepEqual(h.currentDraft().comments, []);
  assert.deepEqual(h.diffLookups, []);
});

test('comment posts a COMMENT review with the body unchanged and without re-reading the head afterwards', async () => {
  const h = actionHarness();
  assert.equal((await h.submit({ action: 'comment', body: 'A few notes' })).ok, true);
  assert.equal(h.posted[0]?.event, 'COMMENT');
  assert.equal(h.posted[0]?.body, 'A few notes');
  assert.equal(h.headLookups.length, 1);
});

test('approve-only after a posted comment review posts an APPROVE with only the hand-approval line and keeps the posted comments', async () => {
  const h = actionHarness({ headReads: [HEAD, HEAD, HEAD] });
  assert.equal((await h.submit({ action: 'comment', body: 'Nits inline', comments: [COMMENT_ON_ADDED_LINE] })).ok, true);
  assert.equal(h.currentDraft().postedEvent, 'COMMENT');
  assert.deepEqual(await h.submit({ action: 'approve-only', body: 'Ignore this body', comments: [COMMENT_ON_ADDED_LINE] }), { ok: true });
  assert.deepEqual(h.posted.map((review) => [review.event, review.body, review.comments.length]), [['COMMENT', 'Nits inline', 1], ['APPROVE', HAND_APPROVAL_LINE, 0]]);
  assert.equal(h.currentDraft().status, 'posted');
  assert.equal(h.currentDraft().postedEvent, 'APPROVE');
  assert.equal(h.currentDraft().body, 'Nits inline');
  assert.deepEqual(h.currentDraft().comments, [COMMENT_ON_ADDED_LINE]);
});

test('a follow-up approval refuses to repost inline comments and a posted approval refuses another', async () => {
  const h = actionHarness({ draft: { status: 'posted', postedEvent: 'COMMENT' } });
  const withComments = await h.submit({ action: 'approve', body: '', comments: [COMMENT_ON_ADDED_LINE] });
  assert.equal(withComments.ok, false);
  assert.match(String(withComments.error), /already posted/);
  assert.equal((await h.submit({ action: 'comment', body: 'More', comments: [] })).ok, false);
  h.replaceDraft(actionDraft({ status: 'posted', postedEvent: 'APPROVE' }));
  assert.equal((await h.submit({ action: 'approve', body: '', comments: [] })).ok, false);
  assert.equal((await h.submit({ action: 'approve-only', body: '', comments: [] })).ok, false);
  assert.deepEqual(h.posted, []);
  assert.deepEqual(h.headLookups, []);
});

test('a follow-up approval whose live head moved refuses without posting and the draft stays posted', async () => {
  const h = actionHarness({ draft: { status: 'posted', postedEvent: 'COMMENT' }, headReads: [OTHER_HEAD] });
  const outcome = await h.submit({ action: 'approve-only', body: '', comments: [] });
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /after the comments were posted, so nothing was approved/);
  assert.deepEqual(h.posted, []);
  assert.deepEqual(h.patches, []);
  assert.equal(h.currentDraft().status, 'posted');
  assert.equal(h.currentDraft().postedEvent, 'COMMENT');
});

test('a follow-up approval whose head moved during the post is dismissed and the draft stays posted', async () => {
  const h = actionHarness({ draft: { status: 'posted', postedEvent: 'COMMENT' }, headReads: [HEAD, OTHER_HEAD] });
  const outcome = await h.submit({ action: 'approve', body: '', comments: [] });
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /approval was dismissed/);
  assert.match(String(outcome.error), /Queue a review|queue a review/);
  assert.doesNotMatch(String(outcome.error), /reviewed again/);
  assert.equal(h.posted.length, 1);
  assert.equal(h.dismissed[0]?.reviewId, 99);
  assert.deepEqual(h.patches, []);
  assert.equal(h.currentDraft().status, 'posted');
  assert.equal(h.currentDraft().postedEvent, 'COMMENT');
});

test('a clicked head that differs from the draft head is refused before GitHub is asked anything', async () => {
  const h = actionHarness();
  const outcome = await h.submit({ action: 'approve', head: OTHER_HEAD });
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /replaced/);
  assert.deepEqual(h.headLookups, []);
  assert.deepEqual(h.posted, []);
  assert.equal(h.currentDraft().status, 'ready');
});

test('requeue accepts error, ready, stale, discarded or posted drafts at the clicked head and never calls GitHub', async () => {
  const harness = actionHarness();
  harness.replaceDraft(actionDraft({ status: 'posted' }));
  assert.deepEqual(await harness.submit({ action: 'requeue', body: '', comments: [] }), { ok: true });
  harness.replaceDraft(actionDraft({ status: 'error', error: 'timed out' }));
  assert.equal((await harness.submit({ action: 'requeue', head: OTHER_HEAD, body: '', comments: [] })).ok, false);
  assert.deepEqual(await harness.submit({ action: 'requeue', body: '', comments: [] }), { ok: true });
  harness.replaceDraft(actionDraft({ status: 'ready' }));
  assert.deepEqual(await harness.submit({ action: 'requeue', body: '', comments: [] }), { ok: true });
  harness.replaceDraft(actionDraft({ status: 'discarded' }));
  assert.deepEqual(await harness.submit({ action: 'requeue', body: '', comments: [] }), { ok: true });
  harness.replaceDraft(actionDraft({ status: 'stale' }));
  assert.deepEqual(await harness.submit({ action: 'requeue', body: '', comments: [] }), { ok: true });
  assert.deepEqual(harness.requeues, Array(5).fill(`${ACTION_KEY}@${HEAD}`));
  assert.deepEqual(harness.headLookups, []);
  assert.deepEqual(harness.diffLookups, []);
  assert.deepEqual(harness.posted, []);
  assert.deepEqual(harness.dismissed, []);
});

test('discard of a draft replaced after it was shown is refused and the new draft stays ready', async () => {
  const h = actionHarness({ draft: { reviewedHead: OTHER_HEAD } });
  const outcome = await h.submit({ action: 'discard', head: HEAD });
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /replaced/);
  assert.equal(h.currentDraft().status, 'ready');
  assert.deepEqual(h.patches, []);
});

test('a live head that moved marks the draft stale and never posts', async () => {
  const h = actionHarness({ headReads: [OTHER_HEAD] });
  const outcome = await h.submit({ action: 'approve' });
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /moved to ddddddd/);
  assert.deepEqual(h.posted, []);
  assert.equal(h.currentDraft().status, 'stale');
});

test('an unreadable live head refuses without posting or marking the draft', async () => {
  const h = actionHarness({ headReads: [null] });
  assert.equal((await h.submit({ action: 'approve' })).ok, false);
  assert.deepEqual(h.posted, []);
  assert.equal(h.currentDraft().status, 'ready');
});

test('an inline comment outside the diff is refused by name and nothing is posted', async () => {
  const h = actionHarness();
  const outcome = await h.submit({ action: 'comment', comments: [COMMENT_ON_ADDED_LINE, COMMENT_OFF_DIFF] });
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /src\/app\.ts:40 \(RIGHT\)/);
  assert.doesNotMatch(String(outcome.error), /src\/app\.ts:3 /);
  assert.deepEqual(h.posted, []);
  assert.equal(h.currentDraft().status, 'ready');
});

test('an unavailable diff refuses inline comments rather than posting them unchecked', async () => {
  const h = actionHarness({ diff: null });
  assert.equal((await h.submit({ action: 'approve', comments: [COMMENT_ON_ADDED_LINE] })).ok, false);
  assert.deepEqual(h.posted, []);
});

test('a review with no inline comments posts without fetching the diff', async () => {
  const h = actionHarness();
  assert.equal((await h.submit({ action: 'approve' })).ok, true);
  assert.deepEqual(h.diffLookups, []);
});

test('a postReview failure reports the gh error and leaves the draft ready', async () => {
  const h = actionHarness({ postResult: { ok: false, err: 'HTTP 422: Unprocessable Entity', reviewId: null } });
  assert.deepEqual(await h.submit({ action: 'approve' }), { ok: false, error: 'HTTP 422: Unprocessable Entity' });
  assert.equal(h.currentDraft().status, 'ready');
  assert.deepEqual(h.patches, []);
});

test('discard marks the draft discarded without touching GitHub', async () => {
  const h = actionHarness();
  assert.deepEqual(await h.submit({ action: 'discard' }), { ok: true });
  assert.equal(h.currentDraft().status, 'discarded');
  assert.deepEqual(h.headLookups, []);
  assert.deepEqual(h.posted, []);
});

test('a second action for the same key while one runs is refused', async () => {
  let releasePost: () => void = () => {};
  const holdPost = new Promise<void>((resolve) => { releasePost = resolve; });
  const h = actionHarness({ holdPost });
  const first = h.submit({ action: 'approve' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = await h.submit({ action: 'approve' });
  releasePost();
  assert.equal(second.ok, false);
  assert.match(String(second.error), /already running/);
  assert.equal((await first).ok, true);
  assert.equal(h.posted.length, 1);
});

test('a draft that is not ready is never posted', async () => {
  const h = actionHarness({ draft: { status: 'stale' } });
  assert.equal((await h.submit({ action: 'approve' })).ok, false);
  assert.deepEqual(h.headLookups, []);
  assert.deepEqual(h.posted, []);
});

test('a draft replaced while the review posts is left untouched and the operator is warned not to post again', async () => {
  const freshDraft = actionDraft({ reviewedHead: OTHER_HEAD, body: 'Fresh review' });
  let replace: () => void = () => {};
  const h = actionHarness({ onPost: () => replace() });
  replace = () => h.replaceDraft(freshDraft);
  const outcome = await h.submit({ action: 'comment', body: 'Old text' });
  assert.equal(outcome.ok, true);
  assert.match(String(outcome.warning), /Do not post it again/);
  assert.deepEqual(h.currentDraft(), freshDraft);
  assert.deepEqual(h.patches, []);
});

test('an approval whose pull request moved during the post is dismissed and the draft marked stale', async () => {
  const h = actionHarness({ headReads: [HEAD, OTHER_HEAD] });
  const outcome = await h.submit({ action: 'approve' });
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /moved to ddddddd while the approval was posting, so the approval was dismissed/);
  assert.equal(h.dismissed.length, 1);
  const [dismissal] = h.dismissed;
  assert.deepEqual([dismissal?.repo, dismissal?.number, dismissal?.reviewId], ['Acme/app', 7, 99]);
  assert.match(String(dismissal?.message), /moved while this approval was posting/);
  assert.equal(h.currentDraft().status, 'stale');
});

test('a failed dismissal of a moved approval tells the operator the approval still stands', async () => {
  const h = actionHarness({ headReads: [HEAD, OTHER_HEAD], dismissResult: { ok: false, err: 'HTTP 403' } });
  const outcome = await h.submit({ action: 'approve' });
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /dismissing the approval failed \(HTTP 403\), so it still stands/);
  assert.equal(h.currentDraft().status, 'stale');
});

test('a moved approval without a review id is reported rather than dismissed blindly', async () => {
  const h = actionHarness({ headReads: [HEAD, OTHER_HEAD], postResult: { ok: true, err: '', reviewId: null } });
  const outcome = await h.submit({ action: 'approve' });
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /did not return the review id/);
  assert.deepEqual(h.dismissed, []);
});

test('an approval whose head cannot be re-read is marked posted with a warning to check GitHub', async () => {
  const h = actionHarness({ headReads: [HEAD, null] });
  const outcome = await h.submit({ action: 'approve' });
  assert.equal(outcome.ok, true);
  assert.match(String(outcome.warning), /Could not confirm/);
  assert.equal(h.currentDraft().status, 'posted');
  assert.deepEqual(h.dismissed, []);
});

const PRIOR_REVIEW = { head: OTHER_HEAD, verdict: 'REQUEST CHANGES' as const, summary: 'null deref', body: 'Fix the null check.', comments: [], wasPosted: true };

test('a re-review fetches the range since the earlier head and tells the reviewer about it', async () => {
  const { review, hydrations, spawns, cleanup } = setup();
  try {
    await review({ ...reviewArgs('full'), priorReview: PRIOR_REVIEW });
    assert.ok(hydrations.includes(`Acme/app@${OTHER_HEAD}..${HEAD}`));
    assert.match(spawns[0].prompt, /This is a re-review:/);
    assert.ok(spawns[0].prompt.includes(`diff ${OTHER_HEAD} ${HEAD}`));
  } finally {
    cleanup();
  }
});

test('a re-review whose earlier head cannot be fetched reviews the whole range', async () => {
  const { review, spawns, cleanup } = setup({ isPriorHeadFetchable: false });
  try {
    await review({ ...reviewArgs('full'), priorReview: PRIOR_REVIEW });
    assert.match(spawns[0].prompt, /most likely a force-push/);
    assert.ok(!spawns[0].prompt.includes(`diff ${OTHER_HEAD} ${HEAD}`));
  } finally {
    cleanup();
  }
});

test('a first review never fetches an earlier range', async () => {
  const { review, hydrations, spawns, cleanup } = setup();
  try {
    await review(reviewArgs('full'));
    assert.ok(hydrations.every((hydration) => !hydration.includes('..')));
    assert.doesNotMatch(spawns[0].prompt, /re-review/);
  } finally {
    cleanup();
  }
});
