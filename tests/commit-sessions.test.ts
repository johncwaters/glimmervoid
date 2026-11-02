import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasGit, git } from './helpers/git-fixture.ts';
import { createCommitSessions } from '../server/commit-sessions.ts';
import { runWhyCli } from '../server/why-cli.ts';
import type { GitRunner } from '../server/commit-sessions.ts';
import { runGit } from '../server/git/git-exec.ts';
import { CommitSessionRecord } from '../shared/contracts/commit-session.ts';

function countingGit(): { runGitFn: GitRunner; subcommands: string[] } {
  const subcommands: string[] = [];
  const runGitFn: GitRunner = (args, options) => {
    subcommands.push(args[0] ?? '');
    return runGit(args, options);
  };
  return { runGitFn, subcommands };
}

function commitFile(worktreeDir: string, fileName: string): string {
  fs.writeFileSync(path.join(worktreeDir, fileName), `${fileName}\n`);
  git(['add', fileName], worktreeDir);
  git(['commit', '-q', '-m', `add ${fileName}`], worktreeDir);
  return git(['rev-parse', 'HEAD'], worktreeDir).trim();
}

async function askWhy(targetArgument: string, cwd: string, configPath: string): Promise<{ answer: string; subcommands: string[] }> {
  const { runGitFn, subcommands } = countingGit();
  const outputs: string[] = [];
  const exitCode = await runWhyCli({ targetArgument, cwd, configPath, runGitFn, writeOutput: (text) => outputs.push(text), writeError: (text) => outputs.push(text) });
  assert.equal(exitCode, 0, outputs.join('\n'));
  return { answer: outputs.join('\n'), subcommands };
}

function unrelatedStoreRows(rowCount: number): string {
  const rows: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const sha = index.toString(16).padStart(40, 'a');
    rows.push(JSON.stringify({ sha, patchId: sha.replace(/^a/, 'b'), sessionId: 'session-other', sessionName: 'other', agent: 'codex', taskTitle: null, committedAt: 0, recordedAt: 0 }));
  }
  return `${rows.join('\n')}\n`;
}

function storedRecords(storeRoot: string): CommitSessionRecord[] {
  const [storeFile] = fs.readdirSync(storeRoot);
  assert.ok(storeFile);
  return fs.readFileSync(path.join(storeRoot, storeFile), 'utf8').trim().split('\n').map((line) => CommitSessionRecord.parse(JSON.parse(line)));
}

test('capture spends no git call on an unmoved HEAD, and why finds the session of a rebased line in one blame and one patch-id', { skip: !hasGit() }, async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-commit-sessions-'));
  const repoDir = path.join(sandbox, 'repo');
  const worktreeDir = path.join(sandbox, 'worktree');
  const storeRoot = path.join(sandbox, 'commit-sessions');
  try {
    fs.mkdirSync(repoDir);
    git(['init', '-q', '-b', 'main'], repoDir);
    git(['config', 'user.email', 'test@example.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    git(['config', 'commit.gpgsign', 'false'], repoDir);
    commitFile(repoDir, 'base.txt');
    git(['worktree', 'add', '-q', '-b', 'session-branch', worktreeDir], repoDir);
    const change = { sessionId: 'session-1', sessionName: 'demo', agent: 'claude', taskTitle: 'Add files', worktreeDir, baseRef: 'main' };

    const firstGit = countingGit();
    const captureWarnings: string[] = [];
    const writerId = '0f8e3c2a-1b4d-4e5f-8a9b-0c1d2e3f4a5b';
    const commitSessions = createCommitSessions({ storeRoot, runGitFn: firstGit.runGitFn, logger: { warn: (text: string) => captureWarnings.push(text) }, nowFn: () => 1, writerIdFn: () => Promise.resolve(writerId) });
    const firstSha = commitFile(worktreeDir, 'first.txt');
    fs.writeFileSync(storeRoot, 'a file where the store folder belongs');
    await commitSessions.noteHeadChange({ ...change, headSha: firstSha });
    assert.equal(captureWarnings.length, 1);
    fs.rmSync(storeRoot);
    firstGit.subcommands.length = 0;
    await commitSessions.noteHeadChange({ ...change, headSha: firstSha });
    assert.deepEqual(firstGit.subcommands, ['log', 'show', 'patch-id', 'notes', 'notes', 'notes', 'notes']);
    const firstPatch = git(['show', firstSha], worktreeDir);
    const expectedPatchId = (await runGit(['patch-id', '--stable'], { cwd: worktreeDir, input: firstPatch })).out.split(' ')[0];
    const [firstRecord] = storedRecords(storeRoot);
    assert.equal(firstRecord?.sha, firstSha);
    assert.equal(firstRecord?.sessionId, 'session-1');
    assert.equal(firstRecord?.taskTitle, 'Add files');
    assert.equal(firstRecord?.patchId, expectedPatchId);

    firstGit.subcommands.length = 0;
    await commitSessions.noteHeadChange({ ...change, headSha: firstSha });
    assert.deepEqual(firstGit.subcommands, []);

    const secondSha = commitFile(worktreeDir, 'second.txt');
    await commitSessions.noteHeadChange({ ...change, headSha: secondSha });
    assert.deepEqual(firstGit.subcommands, ['log', 'show', 'patch-id', 'notes', 'notes']);
    const sharedNoteTexts = git(['notes', '--ref', `refs/notes/glimmervoid/${writerId}`, 'list'], repoDir).trim().split('\n')
      .map((line) => git(['cat-file', 'blob', line.split(' ')[0] ?? ''], repoDir).trim());
    assert.equal(new Set(sharedNoteTexts).size, 1);
    assert.match(sharedNoteTexts[0] ?? '', /^\{"v":1,"sessionId":"[0-9a-f]{16}","agent":"custom"\}$/);
    assert.equal(sharedNoteTexts.length, 4);
    assert.deepEqual(storedRecords(storeRoot).map((record) => record.sha), [firstSha, secondSha]);

    const restartedGit = countingGit();
    const restarted = createCommitSessions({ storeRoot, runGitFn: restartedGit.runGitFn, logger: console });
    await restarted.noteHeadChange({ ...change, headSha: secondSha });
    assert.deepEqual(restartedGit.subcommands, ['rev-parse', 'log']);
    assert.equal(storedRecords(storeRoot).length, 2);

    const [storeFile] = fs.readdirSync(storeRoot);
    fs.appendFileSync(path.join(storeRoot, storeFile ?? ''), unrelatedStoreRows(100_000));
    fs.mkdirSync(path.join(sandbox, 'traces'));
    fs.writeFileSync(path.join(sandbox, 'traces', 'session-1.jsonl'), [
      { ts: 1000, uuid: null, parentUuid: null, vendorSessionId: 'vendor-1', kind: 'prompt', text: 'add the first file\nwith detail' },
      { ts: Date.now() + 3_600_000, uuid: null, parentUuid: null, vendorSessionId: 'vendor-1', kind: 'prompt', text: 'a later prompt' },
    ].map((record) => JSON.stringify(record)).join('\n'));
    commitFile(repoDir, 'main-moved.txt');
    git(['rebase', '-q', 'main'], worktreeDir);
    assert.notEqual(git(['rev-parse', 'HEAD~1'], worktreeDir).trim(), firstSha);
    const configPath = path.join(sandbox, 'config.json');
    const elsewhereConfigPath = path.join(sandbox, 'elsewhere', 'config.json');
    const sharedOnly = await askWhy('first.txt:1', worktreeDir, elsewhereConfigPath);
    const sharedSessionLine = /\nsession {2}custom {2}[0-9a-f]{8} {2}\(shared record; task and prompt stay on the machine that made it\)$/.exec(sharedOnly.answer)?.[0];
    assert.ok(sharedSessionLine, sharedOnly.answer);
    git(['switch', '-q', '-c', 'backport', 'main~1'], repoDir);
    git(['cherry-pick', '-x', firstSha], repoDir);
    await commitSessions.noteHeadChange({ ...change, sessionId: 'cherry-2', agent: 'codex', worktreeDir: repoDir, baseRef: 'backport~1', headSha: git(['rev-parse', 'HEAD'], repoDir).trim() });
    git(['switch', '-q', 'main'], repoDir);
    const rebasedAfterCherryPick = await askWhy('first.txt:1', worktreeDir, elsewhereConfigPath);
    assert.ok(rebasedAfterCherryPick.answer.endsWith(sharedSessionLine), rebasedAfterCherryPick.answer);
    await commitSessions.noteHeadChange({ ...change, sessionId: 'session-3', agent: 'codex', baseRef: 'main~1', headSha: secondSha });
    const originalAfterRecapture = await askWhy(firstSha, repoDir, elsewhereConfigPath);
    assert.ok(originalAfterRecapture.answer.endsWith(sharedSessionLine), originalAfterRecapture.answer);
    const missingStoreErrors: string[] = [];
    const missingStoreExit = await runWhyCli({ targetArgument: 'base.txt:1', cwd: worktreeDir, configPath: elsewhereConfigPath, writeOutput: (text) => missingStoreErrors.push(text), writeError: (text) => missingStoreErrors.push(text) });
    assert.equal(missingStoreExit, 1);
    assert.match(missingStoreErrors.join('\n'), /no commit-session records for this repository at .*elsewhere/);

    const rebasedLine = await askWhy('first.txt:1', worktreeDir, configPath);
    assert.deepEqual(rebasedLine.subcommands, ['rev-parse', 'blame', 'show', 'patch-id']);
    assert.match(rebasedLine.answer, /^first\.txt:1 {2}[0-9a-f]{7} {2}/);
    const sharedSessionIdPrefix = /[0-9a-f]{8}/.exec(sharedSessionLine)?.[0];
    assert.match(rebasedLine.answer, new RegExp(`\\nsession {2}demo \\(claude\\) {2}${sharedSessionIdPrefix}\\ntask {5}Add files\\nasked {4}"add the first file" \\(`));

    const directCommit = await askWhy(secondSha, repoDir, configPath);
    assert.deepEqual(directCommit.subcommands, ['rev-parse', 'log']);
    assert.match(directCommit.answer, /session {2}demo \(claude\)/);

    const unrelatedLine = await askWhy('base.txt:1', repoDir, configPath);
    assert.match(unrelatedLine.answer, /^base\.txt:1 {2}[0-9a-f]{7} {2}.*\nno Glimmervoid session made this commit$/);
    assert.equal(git(['status', '--porcelain'], repoDir), '');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
