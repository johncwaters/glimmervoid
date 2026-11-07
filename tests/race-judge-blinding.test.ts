import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { RaceRecord } from '../shared/contracts/race.ts';
import { contestantDiff } from '../server/race/race-diff.ts';
import { createRaceStore } from '../server/race/race-store.ts';
import { createRaceWiring } from '../server/race/race-wiring.ts';

const quietLog = { log: () => {}, warn: () => {} };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function contestantWorktree(mainRepo: string, root: string, name: string, edit: (dir: string) => void): string {
  const worktreeDir = path.join(root, name);
  git(mainRepo, 'worktree', 'add', '-q', worktreeDir, '-b', name);
  edit(worktreeDir);
  return worktreeDir;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

process.env.GIT_LITERAL_PATHSPECS = '1';

test('the race judge sees shuffled letter ids and no agent config folders, and its ranking maps back to real contestants', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'race-judge-blinding-'));
  const mainRepo = path.join(root, 'main');
  fs.mkdirSync(mainRepo);
  git(mainRepo, 'init', '-q', '-b', 'main');
  git(mainRepo, 'config', 'user.email', 'race@test');
  git(mainRepo, 'config', 'user.name', 'race');
  fs.writeFileSync(path.join(mainRepo, 'add.ts'), 'export const add = (a: number, b: number) => a - b;\n');
  git(mainRepo, 'add', '-A');
  git(mainRepo, 'commit', '-q', '-m', 'start');
  const startSha = git(mainRepo, 'rev-parse', 'HEAD');

  const worktreeByContestant: Record<string, string> = {
    opus: contestantWorktree(mainRepo, root, 'wt-x7f2', (dir) => {
      fs.writeFileSync(path.join(dir, 'add.ts'), 'export const add = (a: number, b: number) => a + b;\n');
      fs.mkdirSync(path.join(dir, '.claude'));
      fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"hooks":{}}\n');
      fs.mkdirSync(path.join(dir, 'packages', 'app', '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'packages', 'app', '.gemini', 'settings.json'), '{"model":"gemini"}\n');
    }),
    'codex-gpt5': contestantWorktree(mainRepo, root, 'wt-q9k1', (dir) => {
      fs.writeFileSync(path.join(dir, 'add.ts'), 'export const add = (a: number, b: number) => b + a;\n');
      fs.mkdirSync(path.join(dir, '.codex'));
      fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    }),
    'kimi-only-config': contestantWorktree(mainRepo, root, 'wt-m3p8', (dir) => {
      fs.mkdirSync(path.join(dir, '.kimi'));
      fs.writeFileSync(path.join(dir, '.kimi', 'config.json'), '{}\n');
    }),
  };
  const setup = { agent: 'claude-code', model: null, options: [], instructions: '' };
  const record: RaceRecord = {
    id: 'race-blind',
    spec: {
      version: 1, title: 'Fix add', prompt: 'Fix add.', repoPath: mainRepo, judge: { setup },
      contestants: Object.keys(worktreeByContestant).map((id) => ({ id, label: `Label ${id}`, setup })),
    },
    startSha, baseBranch: 'main', createdAt: 1, phase: 'running', diffStatsByContestant: {}, judge: null, judgeError: null, winnerContestantId: null,
    sessionIdByContestant: Object.fromEntries(Object.keys(worktreeByContestant).map((id) => [id, `session-${id}`])),
  };
  const store = createRaceStore({ directory: path.join(root, 'races'), log: quietLog });
  await store.write(record);

  let judgePromptText = '';
  let judgedFiles: Record<string, string> = {};
  const broadcasts: RaceRecord[][] = [];
  const wiring = createRaceWiring({
    store, git: { fetchOrigin: async () => ({ ok: true }), listIntegrationTips: async () => ({ ok: false }) },
    integrationBranch: () => null, broadcast: (frame) => broadcasts.push(frame.races), log: quietLog,
    sessionStateOf: () => 'complete', worktreeOf: (sessionId) => worktreeByContestant[sessionId.replace(/^session-/, '')] ?? null,
    diffOf: contestantDiff, judgeRoot: path.join(root, 'judges'), random: () => 0,
    spawnJudge: async ({ prompt, cwd }) => {
      judgePromptText = prompt;
      judgedFiles = Object.fromEntries(fs.readdirSync(cwd, { recursive: true, encoding: 'utf8' })
        .filter((name) => fs.statSync(path.join(cwd, name)).isFile())
        .map((name) => [name, fs.readFileSync(path.join(cwd, name), 'utf8')]));
      fs.writeFileSync(path.join(cwd, 'race-judge-result.json'), JSON.stringify({
        ranking: [{ contestantId: 'A', rank: 1, reason: 'clean' }, { contestantId: 'B', rank: 2, reason: 'fine' }],
        notes: { B: 'swap the operands back' },
      }));
    },
  });
  await wiring.loadRaces([record.id]);
  assert.deepEqual(await wiring.judge(record.id), { ok: true });
  await waitFor(() => wiring.status().races[0]?.phase === 'judged');

  for (const hidden of ['opus', 'codex', 'gpt', 'kimi', 'Label']) assert.ok(!judgePromptText.includes(hidden), `judge prompt leaks ${hidden}`);
  assert.deepEqual(Object.keys(judgedFiles).sort(), ['checkout-A/add.ts', 'checkout-B/add.ts', 'diff-A.patch', 'diff-B.patch']);
  assert.match(judgePromptText, /full checkout in \.\/checkout-A/);
  assert.ok(!judgePromptText.includes(root), 'judge prompt names a contestant worktree');
  assert.match(judgePromptText, /- id A: diff in \.\/diff-A\.patch \(1 files[^\n]*\n- id B: diff in \.\/diff-B\.patch \(1 files/);
  for (const judgedText of Object.values(judgedFiles)) assert.ok(!/\.claude|\.codex|\.kimi|\.gemini/.test(judgedText), 'judged file carries an agent config folder');
  assert.match(judgedFiles['diff-A.patch'], /b \+ a/, 'random () => 0 puts the second lineup contestant first');

  const judged = wiring.status().races[0];
  assert.equal(judged.judgeError, null);
  assert.deepEqual(judged.judge?.ranking.map((entry) => entry.contestantId), ['codex-gpt5', 'opus']);
  assert.deepEqual(judged.judge?.notes, { opus: 'swap the operands back' });
  assert.deepEqual(judged.diffStatsByContestant.opus, { filesChanged: 3, linesAdded: 3, linesRemoved: 1 });
  assert.deepEqual(judged.diffStatsByContestant['kimi-only-config'], { filesChanged: 1, linesAdded: 1, linesRemoved: 0 });
  const uiDiff = await wiring.contestantDiffText(record.id, 'opus');
  assert.ok(uiDiff.ok && uiDiff.diff.includes('.claude/settings.local.json'), 'the Arena diff view keeps agent config files');
  wiring.stopWatching();
  fs.rmSync(root, { recursive: true, force: true });
});
