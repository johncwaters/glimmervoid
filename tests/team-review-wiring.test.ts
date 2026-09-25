import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isDispatchWorkdir } from '../server/core/ingest-agent-core.ts';
import { AUTOMATED_REVIEW_NOTE, FULL_MODEL, REVIEW_BOOTSTRAP_PROMPT, REVIEW_POSTING_FILENAME, REVIEW_PROMPT_FILENAME, REVIEW_REPORT_FILENAME, STAMP_MODEL } from '../server/core/team-review-core.ts';
import type { ReviewProgressEvent, ReviewTier } from '../server/core/team-review-core.ts';
import { createTeamReviewPoller } from '../server/team-review-poller.ts';
import type { DraftPatch, SpawnReviewArgs } from '../server/team-review-poller.ts';
import type { PostedReview } from '../server/pr-gh.ts';
import {
  TEAM_REVIEW_DENY_RULES, createTeamReviewActions, createTeamReviewDispatcher, createTeamReviewSpawn, createTeamReviewWiring, emptyTeamReviewStatus,
  sweepLeftoverCheckouts, teamReviewClaudeArgs, teamReviewPermissions, teamReviewSandbox, teamReviewShouldStart, teamReviewSpawnEnv,
} from '../server/team-review-wiring.ts';
import type { TeamReviewActionGithub, TeamReviewDispatchOptions, TeamReviewSpawn } from '../server/team-review-wiring.ts';
import { PrDetail, ReviewDraft, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import type { ReviewComment, ReviewDraft as ReviewDraftType, TeamReviewActionRequest } from '../shared/contracts/team-review.ts';
import { SANDBOX_UNAPPLIED_ERROR, Session } from '../session/sessions.ts';
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
  writeReport?: (workDir: string) => void; diff?: string | null; fetchedHead?: string; hydrated?: boolean;
} = {}) {
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-review-wt-test-'));
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
      fetchPr: async () => ({ ok: true, headSha: overrides.fetchedHead ?? HEAD }),
      hydrateRange: async (repo, number, headSha) => {
        hydrations.push(`${repo}#${number}@${headSha}`);
        return { ok: overrides.hydrated ?? true };
      },
    },
    gitWorkspace: {
      stageDetachedWorktree: async ({ worktreePath }) => { staged.push(String(worktreePath)); return { ok: true }; },
      removeWorktreeByPath: async ({ cwd }) => { removed.push(String(cwd)); return { ok: true }; },
      pruneWorktrees: async ({ projectPath }) => { pruned.push(projectPath); return { ok: true }; },
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
    randomSuffix: () => 'abcd',
    ...overrides,
  };
  const review = createTeamReviewDispatcher(options);
  const cleanup = () => fs.rmSync(worktreeRoot, { recursive: true, force: true });
  return { review, staged, removed, pruned, hydrations, spawns, worktreeRoot, cleanup };
}

function reviewArgs(tier: ReviewTier) {
  return { candidate, detail, tier, reasons: ['a reason'] };
}

test('every tier runs pr-review from a throwaway work dir, and no argv entry names the staged checkout of the head', async () => {
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
      assert.match(spawns[0].prompt, /pr-review/);
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
    assert.match(draft.body, /^> \[!NOTE\]/);
    assert.match(draft.body, /Verdict: APPROVE WITH NITS/);
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
    assert.match(fallback.body, /Verdict: APPROVE WITH NITS/);
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
  const { review, staged, removed, spawns, cleanup } = setup({ hydrated: false });
  try {
    const draft = await review(reviewArgs('full'));
    assert.equal(draft.status, 'error');
    assert.match(draft.error ?? '', /could not fetch the file contents of Acme\/app#7/);
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
  });
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
    assert.equal(missingDraft.error, 'no pr-review report');
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
  assert.deepEqual(sandbox.filesystem.denyRead, ['~/.ssh', '~/.config/gh', '~/Library/Keychains', '~/.git-credentials']);
  assert.deepEqual(Object.keys(sandbox).sort(), ['allowUnsandboxedCommands', 'enableWeakerNetworkIsolation', 'enabled', 'failIfUnavailable', 'filesystem', 'network']);
  assert.deepEqual(Object.keys(sandbox.network).sort(), ['allowAllUnixSockets', 'allowLocalBinding', 'allowedDomains', 'strictAllowlist']);
  assert.deepEqual(Object.keys(sandbox.filesystem).sort(), ['allowWrite', 'denyRead']);
  assert.notEqual(teamReviewSandbox('/a').network.allowedDomains, teamReviewSandbox('/b').network.allowedDomains, 'each call hands out fresh arrays');
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
    id: 'team-review:Acme/app#7', name: 'Team review Acme/app#7', cwd: '/tmp/x', spawnEnv: teamReviewSpawnEnv('/tmp/x'),
    extraClaudeArgs: teamReviewClaudeArgs('stamp'), settingsPermissions: posture, settingsSandbox: teamReviewSandbox('/tmp/x'),
    signal: new AbortController().signal,
  });
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
      hydrateRange: async () => ({ ok: true }),
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

function actionHarness(options: ActionHarnessOptions = {}) {
  let draft = actionDraft(options.draft);
  const headReads = [...(options.headReads ?? [HEAD, HEAD])];
  const headLookups: string[] = [];
  const diffLookups: string[] = [];
  const posted: PostArgs[] = [];
  const dismissed: DismissArgs[] = [];
  const patches: DraftPatch[] = [];
  const actions = createTeamReviewActions({
    drafts: {
      getDraft: (key) => (key === draft.key ? draft : null),
      updateDraft: async (key, expected, patch) => {
        if (key !== draft.key || draft.reviewedHead !== expected.reviewedHead || draft.status !== expected.status) return null;
        patches.push(patch);
        draft = ReviewDraft.parse({ ...draft, ...patch });
        return draft;
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
    submit, posted, dismissed, patches, headLookups, diffLookups,
    currentDraft: () => draft,
    replaceDraft: (next: ReviewDraftType) => { draft = next; },
  };
}

test('approve posts an APPROVE review pinned to the reviewed head and marks the draft posted', async () => {
  const h = actionHarness();
  assert.deepEqual(await h.submit({ action: 'approve', body: 'Ship it', comments: [COMMENT_ON_ADDED_LINE] }), { ok: true });
  assert.deepEqual(h.posted, [{
    repo: 'Acme/app', number: 7, commitId: HEAD, event: 'APPROVE', body: 'Ship it', comments: [COMMENT_ON_ADDED_LINE],
  }]);
  assert.equal(h.currentDraft().status, 'posted');
  assert.equal(h.currentDraft().body, 'Ship it');
  assert.deepEqual(h.currentDraft().comments, [COMMENT_ON_ADDED_LINE]);
  assert.deepEqual(h.dismissed, []);
});

test('comment posts a COMMENT review without re-reading the head afterwards', async () => {
  const h = actionHarness();
  assert.equal((await h.submit({ action: 'comment', body: 'A few notes' })).ok, true);
  assert.equal(h.posted[0]?.event, 'COMMENT');
  assert.equal(h.headLookups.length, 1);
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
