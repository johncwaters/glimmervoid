import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFactoryCheckEnv, checkFence, decideCloseOut, inheritedSecretValues, listDirtyPaths, listUncommittedWorkPaths, findForbiddenLedgerWrites, parseCheckCommand, parseFactoryReviewerOutput, buildFactoryReviewerPrompt, redactSecretLines, FACTORY_REVIEW_DIFF_MAX_CHARS } from '../server/core/factory-core.ts';
import { DEFAULT_FACTORY_PROTECTED_PATHS } from '../shared/contracts/browser-config.ts';

const fenceInput = { writeScopes: ['src'], protectedPaths: DEFAULT_FACTORY_PROTECTED_PATHS };

test('factory fence admits contained paths and rejects scope siblings and traversal', () => {
  assert.deepEqual(checkFence({ ...fenceInput, changedPaths: ['src/index.ts', 'src/nested/a.ts'] }), { ok: true });
  assert.deepEqual(checkFence({ ...fenceInput, changedPaths: ['src-other/a.ts', '../src/a.ts', 'src/../a.ts'] }), {
    ok: false, outside: ['src-other/a.ts', '../src/a.ts', 'src/../a.ts'], protected: [],
  });
});

test('factory fence protects directories and basenames at every depth', () => {
  assert.deepEqual(checkFence({ ...fenceInput, writeScopes: ['.'], changedPaths: ['.github/ci.yml', '.claude/settings.json', 'src/AGENTS.md', 'src/nested/CLAUDE.md', 'AGENTS.md', 'package.json', 'CLAUDE.local.md', 'src/nested/CLAUDE.local.md'] }), {
    ok: false, outside: [], protected: ['.github/ci.yml', '.claude/settings.json', 'src/AGENTS.md', 'src/nested/CLAUDE.md', 'AGENTS.md', 'package.json', 'CLAUDE.local.md', 'src/nested/CLAUDE.local.md'],
  });
  assert.deepEqual(checkFence({ ...fenceInput, writeScopes: ['.'], changedPaths: ['.github-other/a.ts', 'src/AGENTS.md.backup'] }), { ok: true });
});

test('factory fence refuses every coherence change, including the owning worker session traces', () => {
  assert.deepEqual(checkFence({ ...fenceInput, writeScopes: ['.'], protectedPaths: [], changedPaths: ['.coherence/activity/worker-session.jsonl', '.coherence/decisions/worker-session.jsonl', '.coherence/work/order.jsonl'] }), {
    ok: false, outside: [], protected: ['.coherence/activity/worker-session.jsonl', '.coherence/decisions/worker-session.jsonl', '.coherence/work/order.jsonl'],
  });
});

test('factory fence matches protected paths case-insensitively on both sides', () => {
  const changedPaths = ['server/claude.md', '.Claude/settings.json', '.GITHUB/workflows/ci.yml', 'Package.JSON', '.Coherence/work/order.jsonl', 'src/Agents.Md'];
  assert.deepEqual(checkFence({ ...fenceInput, writeScopes: ['.'], changedPaths }), { ok: false, outside: [], protected: changedPaths });
  assert.deepEqual(checkFence({ ...fenceInput, writeScopes: ['.'], protectedPaths: ['SRC/Generated/'], changedPaths: ['src/generated/a.ts'] }), {
    ok: false, outside: [], protected: ['src/generated/a.ts'],
  });
});

test('factory checks split whitespace and refuse shell operators and quoting', () => {
  assert.deepEqual(parseCheckCommand(' npm\trun typecheck  '), ['npm', 'run', 'typecheck']);
  assert.deepEqual(parseCheckCommand('node check.js --strict'), ['node', 'check.js', '--strict']);
  for (const command of ['', '  ', 'npm test; echo bad', 'npm test && echo bad', 'cat file | tee out', 'cat < file', 'echo > file', 'echo $HOME', 'echo `pwd`', 'echo "hi"', "echo 'hi'", `node${String.fromCharCode(0)}check`]) {
    assert.equal(parseCheckCommand(command), null, command);
  }
});

test('factory close-out merges only all-pass results including the third attempt', () => {
  for (const attempt of [1, 3]) assert.deepEqual(decideCloseOut({ fence: { ok: true }, checks: [{ command: 'npm test', pass: true, output: 'pass' }], review: { pass: true, findings: [] }, attempt }), { action: 'merge' });
});

test('factory close-out retries every failure with bounded concrete feedback', () => {
  const decision = decideCloseOut({ fence: { ok: false, outside: ['outside.ts'], protected: ['package.json'] },
    checks: [{ command: 'npm test', pass: false, output: 'test failed' }], review: { pass: false, findings: ['criterion unmet'] }, attempt: 2 });
  assert.equal(decision.action, 'retry');
  if (decision.action !== 'retry') throw new Error('Expected retry');
  for (const failure of ['outside.ts', 'package.json', 'npm test', 'test failed', 'criterion unmet']) assert.ok(decision.feedback.includes(failure));
  const bounded = decideCloseOut({ fence: { ok: true }, checks: [], review: { pass: false, findings: ['x'.repeat(8000)] }, attempt: 1 });
  assert.equal(bounded.action, 'retry');
  if (bounded.action === 'retry') assert.ok(bounded.feedback.length < 4000);
});

test('factory close-out blocks the third failure and refuses missing verdicts', () => {
  assert.deepEqual(decideCloseOut({ fence: { ok: true }, checks: [], review: null, attempt: 1 }), { action: 'retry', feedback: 'Reviewer verdict is missing' });
  assert.deepEqual(decideCloseOut({ fence: { ok: true }, checks: [], review: { pass: false, findings: [] }, attempt: 3 }), { action: 'block', reason: 'Reviewer failed: No findings returned' });
});


test('reviewer output parses only a successful structured result and rejects malformed envelopes', () => {
  const verdict = { pass: true, findings: [] };
  const envelope = { type: 'result', subtype: 'success', is_error: false, structured_output: verdict };
  assert.deepEqual(parseFactoryReviewerOutput(JSON.stringify(envelope)), verdict);
  const escapeCharacter = String.fromCharCode(27);
  assert.deepEqual(parseFactoryReviewerOutput(`${escapeCharacter}[0m${JSON.stringify(envelope)}\r\n`), verdict);
  assert.deepEqual(parseFactoryReviewerOutput(`Stop hook error: HTTP 403\r\n${escapeCharacter}[?25l${JSON.stringify(envelope)}\r\n${escapeCharacter}[?25h`), verdict);
  for (const invalid of ['', 'not json', JSON.stringify(verdict), JSON.stringify({ ...envelope, is_error: true }), JSON.stringify({ ...envelope, subtype: 'error' }), JSON.stringify({ ...envelope, structured_output: { pass: 'true', findings: [] } })]) {
    assert.equal(parseFactoryReviewerOutput(invalid), null);
  }
});

test('bounded retry feedback names every failed check before including long output', () => {
  const decision = decideCloseOut({ fence: { ok: true }, review: null, attempt: 1, checks: [
    { command: 'npm run typecheck', pass: false, output: 'x'.repeat(8000) },
    { command: 'npm run lint', pass: false, output: 'lint failed' },
  ] });
  assert.equal(decision.action, 'retry');
  if (decision.action !== 'retry') throw new Error('Expected retry');
  assert.match(decision.feedback, /Check failed: npm run typecheck/);
  assert.match(decision.feedback, /Check failed: npm run lint/);
  assert.ok(decision.feedback.length < 4000);
});

test('reviewer prompt caps an oversized diff and says it was truncated', () => {
  const prompt = buildFactoryReviewerPrompt({ workId: 'order', objective: 'Ship retries', criteria: [], baseSha: 'a'.repeat(40) }, 'b'.repeat(40), '/tmp/verdict.json', 'x'.repeat(FACTORY_REVIEW_DIFF_MAX_CHARS + 5000));
  assert.match(prompt, /truncated/);
  assert.ok(prompt.length < FACTORY_REVIEW_DIFF_MAX_CHARS + 5000);
});

test('check output redaction drops every line carrying a scrubbed secret value and ignores unset keys', () => {
  const output = ['ok line', 'token=phc_secret_value here', 'another ok', 'bot 123:telegram-token'].join('\n');
  assert.equal(redactSecretLines(output, ['phc_secret_value', undefined, '', '123:telegram-token']), 'ok line\nanother ok');
  assert.equal(redactSecretLines(output, [undefined]), output);
});

test('dirty path listing reads every porcelain entry', () => {
  const porcelain = ['?? src/new.ts', ' M src/retry.ts', ''].join('\0');
  assert.deepEqual(listDirtyPaths(porcelain), ['src/new.ts', 'src/retry.ts']);
  assert.deepEqual(listDirtyPaths(''), []);
});

test('uncommitted work paths skip tracked and untracked coherence ledger paths at any case and keep everything else', () => {
  const porcelain = ['?? .coherence/activity/worker.jsonl', ' M .coherence/decisions/worker.jsonl', '?? .Coherence/read-traces/worker.jsonl',
    '?? .coherence', '?? src/.coherence/notes.md', '?? .coherence-notes.md', ' M src/retry.ts', ''].join('\0');
  assert.deepEqual(listUncommittedWorkPaths(porcelain), ['src/.coherence/notes.md', '.coherence-notes.md', 'src/retry.ts']);
});

test('check env keeps only allowlisted inherited keys, forces CI and never carries tokens or cloud credentials', () => {
  const baseEnv = { PATH: '/usr/bin', HOME: '/home/op', LANG: 'C', LC_ALL: 'C', TERM: 'xterm', CI: 'false', NODE_ENV: 'test',
    GH_TOKEN: 'ghp_secret_value', AWS_SECRET_ACCESS_KEY: 'aws-secret-value', NPM_TOKEN: 'npm-secret-value', SystemRoot: 'C:\\Windows', EDITOR: 'vim' };
  assert.deepEqual(buildFactoryCheckEnv(baseEnv, 'darwin'), { PATH: '/usr/bin', HOME: '/home/op', LANG: 'C', LC_ALL: 'C', TERM: 'xterm', NODE_ENV: 'test', CI: '1' });
  const windowsEnv = buildFactoryCheckEnv({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', PATHEXT: '.EXE', GH_TOKEN: 'ghp_secret_value' }, 'win32');
  assert.deepEqual(windowsEnv, { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', PATHEXT: '.EXE', CI: '1' });
});

test('inherited secret values come from token, key, password, credential and auth names, skipping short values', () => {
  assert.deepEqual(inheritedSecretValues({ GH_TOKEN: 'ghp_secret_value', AWS_SECRET_ACCESS_KEY: 'aws-secret-value', DB_PASSWORD: 'database-pass',
    GOOGLE_APPLICATION_CREDENTIALS: '/keys/gcp.json', NPM_AUTH: 'npm-auth-value', FEATURE_KEY: '1', PATH: '/usr/bin' }),
  ['ghp_secret_value', 'aws-secret-value', 'database-pass', '/keys/gcp.json', 'npm-auth-value']);
});

const openedRecord = JSON.stringify({ event: 'opened', session: 'orchestrator-session', work: 'wrk-1', parent: 'wrk-intent' });
const factoryRecord = JSON.stringify({ id: 'factory-close', event: 'closed', session: 'glimmervoid-factory', work: 'wrk-1' });

test('a trusted ledger landing admits work creation, decisions, traces and factory-authored records', () => {
  assert.deepEqual(findForbiddenLedgerWrites([
    { path: '.coherence/work/s-a.jsonl', previousText: `${factoryRecord}\n`, currentText: `${factoryRecord}\n${openedRecord}\n` },
    { path: '.coherence/work/s-b.jsonl', previousText: null, currentText: `${openedRecord}\n${factoryRecord}\n` },
    { path: '.coherence/decisions/s-c.jsonl', previousText: null, currentText: 'anything\n' },
    { path: '.coherence/activity/session.jsonl', previousText: null, currentText: '{}\n' },
    { path: '.coherence/consequences/s-d.jsonl', previousText: null, currentText: `${JSON.stringify({ id: 'factory-verification', session: 'glimmervoid-factory', relation: 'verifies' })}\n` },
  ], { trusted: true, intentId: 'wrk-intent', writtenRecordIds: new Set(['factory-close', 'factory-verification']) }), []);
});

test('an orchestrator ledger landing refuses any record that claims the factory session, even a decision or work creation', () => {
  const claimed = `${JSON.stringify({ event: 'opened', session: 'glimmervoid-factory', work: 'wrk-2' })}\n`;
  const refusals = findForbiddenLedgerWrites([
    { path: '.coherence/work/s-a.jsonl', previousText: null, currentText: claimed },
    { path: '.coherence/decisions/s-b.jsonl', previousText: null, currentText: `${JSON.stringify({ session: 'glimmervoid-factory', decision: 'x' })}\n` },
    { path: '.coherence/consequences/s-c.jsonl', previousText: null, currentText: `${JSON.stringify({ id: 'factory-verification', session: 'glimmervoid-factory', relation: 'verifies' })}\n` },
  ], { trusted: false });
  assert.equal(refusals.length, 3);
  for (const refusal of refusals) assert.match(refusal, /claims the glimmervoid-factory session/);
  assert.deepEqual(findForbiddenLedgerWrites([
    { path: '.coherence/work/s-d.jsonl', previousText: `${factoryRecord}\n`, currentText: `${factoryRecord}\n${openedRecord}\n` },
    { path: '.coherence/decisions/s-e.jsonl', previousText: null, currentText: 'anything\n' },
  ], { trusted: false, intentId: 'wrk-intent' }), []);
});

test('an orchestrator ledger landing refuses opening a root order or a child of any order but the active intent', () => {
  const opened = (parent: string | null) => `${JSON.stringify({ event: 'opened', session: 'orchestrator-session', work: 'wrk-9', parent, writeScopes: ['**'] })}\n`;
  const changes = [
    { path: '.coherence/work/s-root.jsonl', previousText: null, currentText: opened(null) },
    { path: '.coherence/work/s-other.jsonl', previousText: null, currentText: opened('wrk-other') },
  ];
  const refusals = findForbiddenLedgerWrites(changes, { trusted: false, intentId: 'wrk-intent' });
  assert.equal(refusals.length, 2);
  for (const refusal of refusals) assert.match(refusal, /opened work that is not a child of the active intent/);
  assert.equal(findForbiddenLedgerWrites([{ path: '.coherence/work/s-child.jsonl', previousText: null, currentText: opened('wrk-intent') }], { trusted: false }).length, 1);
  assert.equal(findForbiddenLedgerWrites(changes, { trusted: true, intentId: 'wrk-intent' }).length, 2);
});

test('ledger landing refuses orchestrator closes, transitions, consequences, defects, rewrites and unknown files', () => {
  const forged = (record: Record<string, unknown>) => `${JSON.stringify({ session: 'orchestrator-session', ...record })}\n`;
  const refusals = findForbiddenLedgerWrites([
    { path: '.coherence/work/s-a.jsonl', previousText: null, currentText: forged({ event: 'closed' }) },
    { path: '.coherence/work/s-b.jsonl', previousText: null, currentText: forged({ event: 'transitioned' }) },
    { path: '.coherence/work/s-h.jsonl', previousText: null, currentText: forged({ event: 'handed-off' }) },
    { path: '.coherence/consequences/s-c.jsonl', previousText: null, currentText: forged({ relation: 'verifies' }) },
    { path: '.coherence/defects/s-d.jsonl', previousText: null, currentText: forged({ summary: 'x' }) },
    { path: '.coherence/work/s-e.jsonl', previousText: `${factoryRecord}\n`, currentText: `${openedRecord}\n` },
    { path: '.coherence/work/s-f.jsonl', previousText: `${factoryRecord}\n`, currentText: null },
    { path: '.coherence/work/s-g.jsonl', previousText: null, currentText: 'not json\n' },
    { path: '.coherence/unknown.json', previousText: null, currentText: '{}' },
  ], { trusted: false });
  assert.equal(refusals.length, 9);
});
