import assert from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_COMMAND_TIMEOUT_MS, gitCommandFailure, runCommand, runGh, runGit } from '../server/git-exec.ts';
import type { ExecFileFn, ExecFileOptions } from '../server/git-exec.ts';

function recordingExec(outcome: { stdout?: string; stderr?: string; failure?: Record<string, unknown> }): { calls: { file: string; args: readonly string[]; options: ExecFileOptions }[]; execFileFn: ExecFileFn } {
  const calls: { file: string; args: readonly string[]; options: ExecFileOptions }[] = [];
  const execFileFn: ExecFileFn = async (file, args, options) => {
    calls.push({ file, args, options });
    if (outcome.failure) throw Object.assign(new Error(String(outcome.failure.message ?? 'Command failed')), outcome.failure);
    return { stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' };
  };
  return { calls, execFileFn };
}

test('runCommand trims stdout by default and keeps it raw with trim false', async () => {
  const { execFileFn } = recordingExec({ stdout: '  main\n', stderr: 'hint\n' });
  assert.deepEqual(await runCommand('git', ['branch'], { execFileFn }), { ok: true, out: 'main', err: '', stderr: 'hint\n' });
  const raw = await runCommand('git', ['branch'], { execFileFn, trim: false });
  assert.equal(raw.out, '  main\n');
});

test('runCommand applies the default timeout, utf8 encoding and only the options a caller set', async () => {
  const { calls, execFileFn } = recordingExec({ stdout: '' });
  await runCommand('git', ['status'], { execFileFn });
  assert.deepEqual(calls[0].options, { encoding: 'utf8', timeout: DEFAULT_COMMAND_TIMEOUT_MS });
  const signal = new AbortController().signal;
  await runCommand('gh', ['api'], { execFileFn, cwd: '/repo', timeoutMs: 5, maxBuffer: 7, signal, input: 'body' });
  assert.deepEqual(calls[1].options, { encoding: 'utf8', timeout: 5, cwd: '/repo', maxBuffer: 7, signal, input: 'body' });
});

test('a failure reports the message, or stderr first when preferStderr is set, and drops stdout unless kept', async () => {
  const failure = { message: 'Command failed: git fetch', stdout: 'partial\n', stderr: 'fatal: denied\n' };
  const { execFileFn } = recordingExec({ failure });
  const plain = await runCommand('git', ['fetch'], { execFileFn });
  assert.equal(plain.ok, false);
  assert.equal(plain.out, '');
  assert.equal(plain.err, 'Command failed: git fetch');
  assert.equal(plain.stderr, 'fatal: denied\n');
  assert.equal(plain.timedOut, false);
  assert.ok(plain.error instanceof Error);
  const preferred = await runCommand('git', ['fetch'], { execFileFn, preferStderr: true, keepStdoutOnFailure: true });
  assert.equal(preferred.err, 'fatal: denied\n');
  assert.equal(preferred.out, 'partial');
  const rawKept = await runCommand('git', ['fetch'], { execFileFn, keepStdoutOnFailure: true, trim: false });
  assert.equal(rawKept.out, 'partial\n');
});

test('preferStderr falls back to the message when stderr is empty', async () => {
  const { execFileFn } = recordingExec({ failure: { message: 'spawn git ENOENT', code: 'ENOENT' } });
  const result = await runCommand('git', ['status'], { execFileFn, preferStderr: true });
  assert.equal(result.err, 'spawn git ENOENT');
});

test('a timeout kill is flagged as timedOut', async () => {
  const { execFileFn } = recordingExec({ failure: { message: 'killed', killed: true, signal: 'SIGTERM' } });
  const result = await runCommand('git', ['log'], { execFileFn });
  assert.equal(result.timedOut, true);
});

test('gitCommandFailure names the git command and its timeout, keeping the kill as the cause', async () => {
  const { execFileFn } = recordingExec({ failure: { message: 'killed', killed: true, signal: 'SIGTERM' } });
  const result = await runCommand('git', ['diff', 'HEAD'], { execFileFn });
  const failure = gitCommandFailure(['diff', 'HEAD'], result, 15000);
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, 'git diff HEAD timed out after 15000ms');
  assert.equal(failure.cause, result.error);
  assert.equal((gitCommandFailure(['log'], result) as Error).message, `git log timed out after ${DEFAULT_COMMAND_TIMEOUT_MS}ms`);
});

test('gitCommandFailure passes any other failure through unchanged', async () => {
  const { execFileFn } = recordingExec({ failure: { message: 'Command failed: git status', code: 128 } });
  const result = await runCommand('git', ['status'], { execFileFn });
  assert.equal(gitCommandFailure(['status'], result, 15000), result.error);
});

test('runGit always sets GIT_TERMINAL_PROMPT=0 over the inherited, merged or replaced environment', async () => {
  const { calls, execFileFn } = recordingExec({ stdout: '' });
  await runGit(['status'], { execFileFn });
  assert.equal(calls[0].file, 'git');
  assert.equal(calls[0].options.env?.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls[0].options.env?.PATH, process.env.PATH);
  await runGit(['fetch'], { execFileFn, env: { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_TERMINAL_PROMPT: '1' } });
  assert.equal(calls[1].options.env?.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
  assert.equal(calls[1].options.env?.GIT_TERMINAL_PROMPT, '0');
  await runGit(['merge-tree'], { execFileFn, replaceEnv: { GIT_INDEX_FILE: '/tmp/index' } });
  assert.deepEqual(calls[2].options.env, { GIT_INDEX_FILE: '/tmp/index', GIT_TERMINAL_PROMPT: '0' });
  await runGit(['status'], { execFileFn, gitPath: '/opt/git/bin/git' });
  assert.equal(calls[3].file, '/opt/git/bin/git');
});

test('runGh runs the gh binary without touching the environment', async () => {
  const { calls, execFileFn } = recordingExec({ stdout: '{}' });
  await runGh(['api', 'graphql'], { execFileFn, cwd: '/repo' });
  assert.equal(calls[0].file, 'gh');
  assert.equal(calls[0].options.env, undefined);
});

test('runCommand drives a real child process through the safe wrapper', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok\\n"); process.stderr.write("warn")']);
  assert.deepEqual(result, { ok: true, out: 'ok', err: '', stderr: 'warn' });
  const failed = await runCommand(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(3)'], { preferStderr: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.err, 'boom');
});
