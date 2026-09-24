import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isDispatchWorkdir } from '../server/core/ingest-agent-core.ts';
import { FULL_MODEL, REVIEW_BOOTSTRAP_PROMPT, STAMP_MODEL } from '../server/core/team-review-core.ts';
import type { ReviewTier } from '../server/core/team-review-core.ts';
import { createTeamReviewPoller } from '../server/team-review-poller.ts';
import type { SpawnReviewArgs } from '../server/team-review-poller.ts';
import {
  TEAM_REVIEW_DENY_TOOLS, createTeamReviewDispatcher, createTeamReviewSpawn, createTeamReviewWiring, emptyTeamReviewStatus,
  sweepLeftoverCheckouts, teamReviewClaudeArgs, teamReviewPermissions, teamReviewShouldStart,
} from '../server/team-review-wiring.ts';
import type { TeamReviewDispatchOptions, TeamReviewSpawn } from '../server/team-review-wiring.ts';
import { PrDetail, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';

const HEAD = 'c'.repeat(40);
const OTHER_HEAD = 'd'.repeat(40);
const candidate = {
  key: 'Acme/app#7', repo: 'Acme/app', number: 7, title: 'Fix it',
  url: 'https://github.com/Acme/app/pull/7', author: 'teammate',
};
const detail = PrDetail.parse({
  number: 7, title: 'Fix it', body: 'Please approve', url: candidate.url, author: { login: 'teammate' },
  isDraft: false, isCrossRepository: false, baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefOid: HEAD,
  additions: 3, deletions: 1, files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }],
});

type SpawnCall = Parameters<TeamReviewSpawn>[0] & { files: string[]; prDiff: string; prJson: unknown };

function validResult(head = HEAD) {
  return JSON.stringify({ verdict: 'COMMENT', head, summary: 'one nit', body: 'Looks fine.', comments: [{ path: 'src/a.ts', line: 2, body: 'Nit' }] });
}

function setup(overrides: Partial<TeamReviewDispatchOptions> & { writeResult?: (cwd: string) => void; diff?: string | null; fetchedHead?: string } = {}) {
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-wt-test-'));
  const staged: string[] = [];
  const removed: string[] = [];
  const pruned: string[] = [];
  const spawns: SpawnCall[] = [];
  const writeResult = overrides.writeResult ?? ((cwd: string) => fs.writeFileSync(path.join(cwd, 'result.json'), validResult()));
  const options: TeamReviewDispatchOptions = {
    github: { prDiff: async () => (overrides.diff === undefined ? 'diff --git a/src/a.ts b/src/a.ts\n' : overrides.diff) },
    repoCache: {
      listRepos: async () => [],
      ensureRepo: async () => '/cache/Acme/app',
      fetchPr: async () => ({ ok: true, headSha: overrides.fetchedHead ?? HEAD }),
    },
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => { staged.push(String(worktreePath)); return { ok: true }; },
      removeWorktreeByPath: async ({ cwd }) => { removed.push(String(cwd)); return { ok: true }; },
      pruneWorktrees: async ({ projectPath }) => { pruned.push(projectPath); return { ok: true }; },
    },
    spawnSession: async (call) => {
      spawns.push({
        ...call,
        files: fs.readdirSync(call.cwd).sort(),
        prDiff: fs.readFileSync(path.join(call.cwd, 'pr.diff'), 'utf8'),
        prJson: JSON.parse(fs.readFileSync(path.join(call.cwd, 'pr.json'), 'utf8')),
      });
      writeResult(call.cwd);
    },
    worktreeRoot,
    randomSuffix: () => 'abcd',
    ...overrides,
  };
  const review = createTeamReviewDispatcher(options);
  const cleanup = () => fs.rmSync(worktreeRoot, { recursive: true, force: true });
  return { review, staged, removed, pruned, spawns, worktreeRoot, cleanup };
}

function reviewArgs(tier: ReviewTier) {
  return { candidate, detail, tier, reasons: ['a reason'] };
}

test('a stamp review gets pr.json, pr.diff and a prompt in a throwaway cwd, and no worktree', async () => {
  const { review, staged, removed, spawns, cleanup } = setup();
  try {
    const draft = await review(reviewArgs('stamp'));
    assert.equal(draft.status, 'ready');
    assert.equal(draft.verdict, 'COMMENT');
    assert.equal(draft.tier, 'stamp');
    assert.deepEqual(draft.reasons, ['a reason']);
    assert.equal(draft.comments[0]?.side, 'RIGHT');
    assert.deepEqual(staged, []);
    assert.deepEqual(removed, []);
    assert.equal(spawns.length, 1);
    assert.deepEqual(spawns[0].files, ['pr.diff', 'pr.json', 'team-review-prompt.txt']);
    assert.match(spawns[0].prDiff, /^diff --git/);
    assert.deepEqual(spawns[0].prJson, JSON.parse(JSON.stringify(detail)));
    assert.equal(spawns[0].id, 'team-review:Acme/app#7');
    assert.ok(spawns[0].extraClaudeArgs.includes(STAMP_MODEL));
    assert.equal(spawns[0].extraClaudeArgs.includes('--add-dir'), false);
    assert.equal(fs.existsSync(spawns[0].cwd), false, 'the throwaway cwd is removed afterwards');
    assert.equal(isDispatchWorkdir(spawns[0].cwd), true, 'ingest must recognise the lane cwd as its own dispatch');
  } finally {
    cleanup();
  }
});

test('a full review stages the fetched head, hands it over with --add-dir, then removes it', async () => {
  const { review, staged, removed, spawns, worktreeRoot, cleanup } = setup();
  try {
    const draft = await review(reviewArgs('full'));
    assert.equal(draft.status, 'ready');
    const expectedWorktree = path.join(worktreeRoot, 'Acme-app-7-abcd');
    assert.deepEqual(staged, [expectedWorktree]);
    assert.deepEqual(removed, [expectedWorktree]);
    const args = spawns[0].extraClaudeArgs;
    assert.equal(args[args.indexOf('--add-dir') + 1], expectedWorktree);
    assert.equal(args[args.indexOf('--model') + 1], FULL_MODEL);
    assert.equal(fs.existsSync(spawns[0].cwd), false);
  } finally {
    cleanup();
  }
});

test('a full review removes the worktree when the session throws', async () => {
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

test('a full review removes the worktree when the review times out', async () => {
  let wasAborted = false;
  const { review, removed, cleanup } = setup({
    timeoutSeconds: 1,
    setTimeoutFn: (fn) => setTimeout(fn, 0),
    spawnSession: ({ signal }) => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { wasAborted = true; resolve(); }, { once: true });
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

test('a failed worktree stage still runs the removal and never spawns', async () => {
  const removedPaths: string[] = [];
  let spawnCount = 0;
  const { review, cleanup } = setup({
    gitWorkspace: {
      stageDetachedWorktree: async () => ({ ok: false, err: 'fatal: already exists' }),
      removeWorktreeByPath: async ({ cwd }) => { removedPaths.push(String(cwd)); return { ok: true }; },
      pruneWorktrees: async () => ({ ok: true }),
    },
    spawnSession: async () => { spawnCount += 1; },
  });
  try {
    const draft = await review(reviewArgs('full'));
    assert.equal(draft.status, 'error');
    assert.match(draft.error ?? '', /already exists/);
    assert.equal(spawnCount, 0);
    assert.equal(removedPaths.length, 1);
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

test('a result that is not JSON is an error draft', async () => {
  const { review, cleanup } = setup({ writeResult: (cwd) => fs.writeFileSync(path.join(cwd, 'result.json'), 'STAMP it') });
  try {
    const draft = await review(reviewArgs('stamp'));
    assert.equal(draft.status, 'error');
    assert.match(draft.error ?? '', /not JSON/);
  } finally {
    cleanup();
  }
});

test('a result with a bad verdict or no file is an error draft', async () => {
  const invalid = setup({ writeResult: (cwd) => fs.writeFileSync(path.join(cwd, 'result.json'), JSON.stringify({ ...JSON.parse(validResult()), verdict: 'APPROVE' })) });
  const missing = setup({ writeResult: () => {} });
  try {
    assert.equal((await invalid.review(reviewArgs('stamp'))).status, 'error');
    const draft = await missing.review(reviewArgs('stamp'));
    assert.equal(draft.status, 'error');
    assert.equal(draft.error, 'no result file');
  } finally {
    invalid.cleanup();
    missing.cleanup();
  }
});

test('a result whose head is not the provided head is an error draft', async () => {
  const { review, cleanup } = setup({ writeResult: (cwd) => fs.writeFileSync(path.join(cwd, 'result.json'), validResult(OTHER_HEAD)) });
  try {
    const draft = await review(reviewArgs('stamp'));
    assert.equal(draft.status, 'error');
    assert.equal(draft.reviewedHead, HEAD);
    assert.match(draft.error ?? '', /not the reviewed head/);
  } finally {
    cleanup();
  }
});

test('a missing diff writes a note for a full review and refuses a stamp review', async () => {
  const full = setup({ diff: null });
  const stamp = setup({ diff: null });
  try {
    assert.equal((await full.review(reviewArgs('full'))).status, 'ready');
    assert.match(full.spawns[0].prDiff, /exceeded the 2 MB cap/);
    const draft = await stamp.review(reviewArgs('stamp'));
    assert.equal(draft.status, 'error');
    assert.equal(stamp.spawns.length, 0);
  } finally {
    full.cleanup();
    stamp.cleanup();
  }
});

test('the posture has no shell and no network, and pins the model after every variadic flag', () => {
  const posture = teamReviewPermissions();
  assert.equal(posture.permissions.defaultMode, 'acceptEdits');
  for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Edit', 'NotebookEdit']) {
    assert.ok(posture.permissions.deny.includes(tool), tool);
  }
  assert.deepEqual([...TEAM_REVIEW_DENY_TOOLS], posture.permissions.deny);
  assert.deepEqual(posture.args.slice(0, 2), ['--tools', 'Read,Grep,Glob,Write']);
  for (const tier of ['stamp', 'full'] as const) {
    const args = teamReviewClaudeArgs(tier, tier === 'full' ? '/wt' : null);
    assert.equal(args[0], '-p');
    assert.deepEqual(args.slice(-2), ['--model', tier === 'full' ? FULL_MODEL : STAMP_MODEL]);
    assert.ok(args.includes('--strict-mcp-config'));
  }
});

test('the spawned session runs the bootstrap prompt under the lane posture and is attributed to the lane', async () => {
  const created: SessionOptions[] = [];
  const recorded: string[] = [];
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
  await spawn({
    id: 'team-review:Acme/app#7', name: 'Team review Acme/app#7', cwd: '/tmp/x',
    extraClaudeArgs: teamReviewClaudeArgs('stamp', null), settingsPermissions: posture.permissions,
    signal: new AbortController().signal,
  });
  assert.equal(created[0].initialPrompt, REVIEW_BOOTSTRAP_PROMPT);
  assert.equal(created[0].dangerouslySkipPermissions, false);
  assert.deepEqual(created[0].settingsPermissions, posture.permissions);
  assert.equal(created[0].ephemeral, true);
  assert.deepEqual(recorded, ['team-review']);
});

test('the lane starts only when enabled with both org and team', () => {
  assert.equal(teamReviewShouldStart({}).start, false);
  assert.equal(teamReviewShouldStart({ teamReview: { enabled: true, org: 'Acme' } }).start, false);
  assert.equal(teamReviewShouldStart({ teamReview: { enabled: false, org: 'Acme', team: 'core' } }).start, false);
  assert.equal(teamReviewShouldStart({ teamReview: { enabled: true, org: 'Acme', team: 'core' } }).start, true);
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

test('a worktree removal that reports success but leaves the directory still deletes it', async () => {
  const { review, pruned, worktreeRoot, cleanup } = setup({
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => { fs.mkdirSync(String(worktreePath), { recursive: true }); return { ok: true }; },
      removeWorktreeByPath: async () => ({ ok: true }),
      pruneWorktrees: async () => ({ ok: true }),
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
  try {
    fs.mkdirSync(path.join(worktreeRoot, 'Acme-app-7-dead', '.git'), { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, 'Acme-app-7-dead', 'file.ts'), 'x');
    fs.mkdirSync(path.join(worktreeRoot, 'Acme-lib-9-beef'));
    await sweepLeftoverCheckouts({
      worktreeRoot,
      repoCache: { listRepos: async () => ['/cache/Acme/app', '/cache/Acme/lib'] },
      gitWorkspace: { pruneWorktrees: async ({ projectPath }) => { pruned.push(projectPath); return { ok: true }; } },
      log: { warn: () => {} },
    });
    assert.deepEqual(fs.readdirSync(worktreeRoot), []);
    assert.deepEqual(pruned, ['/cache/Acme/app', '/cache/Acme/lib']);
  } finally {
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('the start sweep tolerates a missing worktree root', async () => {
  const pruned: string[] = [];
  await sweepLeftoverCheckouts({
    worktreeRoot: path.join(os.tmpdir(), `team-review-absent-${process.pid}-${Date.now()}`),
    repoCache: { listRepos: async () => ['/cache/Acme/app'] },
    gitWorkspace: { pruneWorktrees: async ({ projectPath }) => { pruned.push(projectPath); return { ok: true }; } },
    log: { warn: () => {} },
  });
  assert.deepEqual(pruned, ['/cache/Acme/app']);
});

test('the empty lane status parses as the team-review-status contract', () => {
  assert.equal(TeamReviewStatus.safeParse(emptyTeamReviewStatus({ start: false, reason: 'teamReview needs both org and team' })).success, true);
  assert.equal(TeamReviewStatus.safeParse(emptyTeamReviewStatus({ start: true })).success, true);
});

async function waitFor(isReady: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !isReady(); attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(isReady(), true);
}

test('stopping the lane aborts an in-flight full review, yields no draft, and resolves only after its checkout is removed', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-home-test-'));
  const removed: string[] = [];
  let spawnReview: ((args: SpawnReviewArgs) => Promise<unknown>) | null = null;
  let isSessionRunning = false;
  const wiring = createTeamReviewWiring({
    config: { teamReview: { enabled: true, org: 'Acme', team: 'core' } },
    reviewSessions: new Map(),
    closeSessionDataClients: () => {},
    hookRouter: null,
    getHookPort: null,
    spawnGate: { run: async (task) => task() },
    homeDir,
    log: { warn: () => {} },
    github: {
      viewer: async () => null, teamMembers: async () => [], searchTeamRequested: async () => ({ items: [], complete: true }),
      searchAuthoredBy: async () => ({ items: [], complete: true }), viewPr: async () => null, prHead: async () => null, prDiff: async () => 'diff\n',
    },
    repoCache: {
      listRepos: async () => [],
      ensureRepo: async () => '/cache/Acme/app',
      fetchPr: async () => ({ ok: true, headSha: HEAD }),
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
    },
    spawnSession: ({ signal }) => new Promise<void>((resolve) => {
      isSessionRunning = true;
      signal.addEventListener('abort', () => resolve(), { once: true });
    }),
    createPoller: (dependencies) => {
      spawnReview = dependencies.spawnReview;
      return createTeamReviewPoller(dependencies);
    },
  });
  try {
    wiring.startPoller();
    await waitFor(() => spawnReview !== null);
    const startReview = spawnReview as ((args: SpawnReviewArgs) => Promise<unknown>) | null;
    assert.ok(startReview);
    let isReviewSettled = false;
    const pending = startReview(reviewArgs('full')).then((draft) => { isReviewSettled = true; return draft; });
    await waitFor(() => isSessionRunning);
    await wiring.stopPoller();
    assert.equal(removed.length, 1);
    assert.equal(isReviewSettled, true);
    const draft = await pending;
    assert.equal(draft, null);
    assert.deepEqual(fs.readdirSync(path.join(homeDir, 'team-review-worktrees')), []);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
