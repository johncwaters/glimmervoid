import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRadarWiring, pushFixBranch } from '../server/radar/radar-wiring.ts';
import type { PosthogWorkspace } from '../server/radar/radar-wiring.ts';
import { createSpawnGate } from '../server/spawn-gate.ts';
import { execFileAsync } from '../server/child-process-safe.ts';
import { recordingSessionFactory } from './helpers/fake-session.ts';

interface CliResult {
  ok: boolean;
  out: string;
  err: string;
}

function inertWiringDeps() {
  return {
    investigationSessions: new Map<string, unknown>(),
    closeSessionDataClients() {},
    hookRouter: null,
    getHookPort: null,
    spawnGate: createSpawnGate(),
  };
}

test('an investigation with an omitted host receives the advertised cloud host in its prompt and environment', async () => {
  const { makeSession, constructed, created } = recordingSessionFactory();
  const wiring = createRadarWiring({
    config: { posthog: { enabled: true, apiKey: 'phx_secret' }, replayBufferKB: 256 },
    ...inertWiringDeps(), makeSession,
  });
  const controller = new AbortController();
  controller.abort();
  try {
    await wiring._investigationSpawn({
      key: 'us.posthog.com/1#iss-default-host', issue: { issueId: 'iss-default-host' }, projectId: 1, projectName: 'web',
      host: 'https://us.posthog.com', url: 'https://us.posthog.com/project/1/error_tracking/iss-default-host',
      mode: 'investigate', timeoutMs: 1000, signal: controller.signal,
    });
    assert.equal(constructed.length, 1);
    assert.equal(constructed[0].spawnEnv?.POSTHOG_HOST, 'https://us.posthog.com');
    assert.match(constructed[0].initialPrompt ?? '', /https:\/\/us\.posthog\.com/);
  } finally {
    for (const session of created) session.destroy();
    await wiring.stopPoller();
  }
});

const WORKSPACE: PosthogWorkspace = {
  cwd: '/wt', isGit: true, branch: 'glimmervoid/radar-fix/1-iss-1-abc', base: 'main', baseSha: 'deadbeef',
};

interface RunCall {
  cmd: string;
  args: string[];
  cwd: string;
  key: string;
}

function fakeRun(script: Record<string, CliResult> = {}) {
  const calls: RunCall[] = [];
  const run = async (cmd: string, args: string[], cwd: string): Promise<CliResult> => {
    calls.push({ cmd, args, cwd, key: `${cmd} ${args[0]}` });
    const hit = script[`${cmd} ${args[0]}`];
    if (!hit) return { ok: true, out: '', err: '' };
    return hit;
  };
  return { run, calls };
}

const CLEAN_SCRIPT: Record<string, CliResult> = {
  'git diff': { ok: true, out: 'src/app.js\0tests/app.test.js\0', err: '' },
  'git rev-list': { ok: true, out: '2', err: '' },
  'git push': { ok: true, out: '', err: '' },
  'gh repo': { ok: true, out: 'owner/repo', err: '' },
  'gh pr': { ok: true, out: 'https://github.com/owner/repo/pull/42', err: '' },
};

async function handoff(script: Record<string, CliResult>, over: { workspace?: PosthogWorkspace } = {}) {
  const { run, calls } = fakeRun(script);
  const res = await pushFixBranch({
    run, repoPath: '/repo', workspace: WORKSPACE, prTitle: 'fix: guard it', prBody: 'body', ...over,
  });
  return { res, calls };
}

test('pushFixBranch refuses a non-ASCII workflow path that unquoted name-only output would have C-quoted', async () => {
  const { res, calls } = await handoff({
    ...CLEAN_SCRIPT,
    'git diff': { ok: true, out: 'src/app.js\0.github/workflows/\u00e9 \t"x".yml\0', err: '' },
  });
  assert.equal(res.verdict, 'NEEDS_HUMAN');
  assert.equal(calls.some((c) => c.key === 'git push'), false);
});

test('pushFixBranch refuses a real commit that renames a workflow out of .github/workflows', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-ph-rename-'));
  const runGit = async (args: string[]) => (await execFileAsync('git', args, { cwd: repoDir, encoding: 'utf8' })).stdout.trim();
  try {
    await runGit(['init', '--quiet', '-b', 'main']);
    await runGit(['config', 'user.email', 'radar@example.test']);
    await runGit(['config', 'user.name', 'Radar']);
    await runGit(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(repoDir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.github', 'workflows', 'ci.yml'), 'name: ci\non: push\njobs: {}\n');
    await runGit(['add', '-A']);
    await runGit(['commit', '--quiet', '-m', 'base']);
    const baseSha = await runGit(['rev-parse', 'HEAD']);
    await runGit(['mv', '.github/workflows/ci.yml', 'ci.yml']);
    await runGit(['commit', '--quiet', '-m', 'move the workflow away']);
    const outsideCalls: string[] = [];
    const run = async (cmd: string, args: string[], cwd: string): Promise<CliResult> => {
      if (cmd !== 'git' || args[0] === 'push') {
        outsideCalls.push(`${cmd} ${args[0]}`);
        return { ok: true, out: '', err: '' };
      }
      try {
        const { stdout } = await execFileAsync(cmd, args, { cwd, encoding: 'utf8' });
        return { ok: true, out: stdout.trim(), err: '' };
      } catch (error) {
        return { ok: false, out: '', err: error instanceof Error ? error.message : String(error) };
      }
    };
    const res = await pushFixBranch({ run, repoPath: repoDir, workspace: { ...WORKSPACE, cwd: repoDir, baseSha }, prTitle: 'fix', prBody: 'body' });
    assert.equal(res.verdict, 'NEEDS_HUMAN');
    assert.match(res.summary ?? '', /\.github\/workflows\/ci\.yml/);
    assert.deepEqual(outsideCalls, []);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('pushFixBranch refuses a diff that replaces .github with a bare entry such as a symlink', async () => {
  const { res, calls } = await handoff({ ...CLEAN_SCRIPT, 'git diff': { ok: true, out: '.github\0', err: '' } });
  assert.equal(res.verdict, 'NEEDS_HUMAN');
  assert.equal(calls.some((c) => c.key === 'git push'), false);
});
