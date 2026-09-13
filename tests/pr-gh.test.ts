import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyChecks, createPrGh, normalizePr } from '../server/pr-gh.ts';

test('classifyChecks: empty rollup is none (never green)', () => {
  assert.equal(classifyChecks([]), 'none');
  assert.equal(classifyChecks(null), 'none');
  assert.equal(classifyChecks(undefined), 'none');
});

test('classifyChecks: CheckRuns all completed+success -> green', () => {
  assert.equal(classifyChecks([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'COMPLETED', conclusion: 'SKIPPED' },
  ]), 'green');
});

test('classifyChecks: a not-yet-completed CheckRun -> pending', () => {
  assert.equal(classifyChecks([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'IN_PROGRESS', conclusion: '' },
  ]), 'pending');
});

test('classifyChecks: a completed failure -> failing', () => {
  assert.equal(classifyChecks([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'COMPLETED', conclusion: 'FAILURE' },
  ]), 'failing');
});

test('classifyChecks: StatusContext all SUCCESS -> green', () => {
  assert.equal(classifyChecks([
    { __typename: 'StatusContext', state: 'SUCCESS' },
    { __typename: 'StatusContext', state: 'SUCCESS' },
  ]), 'green');
});

test('classifyChecks: StatusContext PENDING -> pending', () => {
  assert.equal(classifyChecks([
    { __typename: 'StatusContext', state: 'SUCCESS' },
    { __typename: 'StatusContext', state: 'PENDING' },
  ]), 'pending');
});

test('classifyChecks: StatusContext FAILURE/ERROR -> failing', () => {
  assert.equal(classifyChecks([{ __typename: 'StatusContext', state: 'FAILURE' }]), 'failing');
  assert.equal(classifyChecks([{ __typename: 'StatusContext', state: 'ERROR' }]), 'failing');
});

test('classifyChecks: mixed CheckRun + StatusContext, all good -> green', () => {
  assert.equal(classifyChecks([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', state: 'SUCCESS' },
  ]), 'green');
});

test('normalizePr maps gh fields and coerces bot/fork flags', () => {
  const pr = normalizePr({
    number: 3,
    headRefOid: 'abc',
    headRefName: 'feat',
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    isDraft: false,
    isCrossRepository: false,
    headRepositoryOwner: { login: 'me' },
    author: { login: 'dependabot[bot]', is_bot: true },
    title: 'x',
  });
  assert.equal(pr.headOwner, 'me');
  assert.equal(pr.author.isBot, true);
  assert.equal(pr.author.login, 'dependabot[bot]');
  assert.equal(pr.mergeable, 'MERGEABLE');
});

test('listIssues asks gh for no body and drops any body gh still returns', async () => {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const listed = [{
    number: 17,
    title: 'Fix reconnect',
    body: 'The socket stalls.',
    labels: [{ name: 'bug', color: 'ff0000' }],
    url: 'https://github.test/acme/repo/issues/17',
    updatedAt: '2026-09-13T10:00:00Z',
  }];
  const gh = createPrGh('/repo', async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    return { ok: true, out: JSON.stringify(listed), err: '' };
  });

  assert.deepEqual(await gh.listIssues(), {
    ok: true,
    error: '',
    issues: [{
      number: 17,
      title: 'Fix reconnect',
      labels: [{ name: 'bug', color: 'ff0000' }],
      url: 'https://github.test/acme/repo/issues/17',
      updatedAt: '2026-09-13T10:00:00Z',
    }],
  });
  assert.deepEqual(calls, [{
    cmd: 'gh',
    args: ['issue', 'list', '--state', 'open', '-L', '50', '--search', 'sort:updated-desc', '--json', 'number,title,labels,url,updatedAt'],
    cwd: '/repo',
  }]);
});

test('listIssues normalizes label shapes and drops rows without a usable number', async () => {
  const gh = createPrGh('/repo', async () => ({
    ok: true,
    err: '',
    out: JSON.stringify([
      { number: 0, title: 'dropped' },
      { number: 8, title: ' Padded ', labels: ['help wanted', { name: 'bug', color: '#nope' }, { name: '', color: 'ff0000' }] },
    ]),
  }));

  assert.deepEqual(await gh.listIssues(), {
    ok: true,
    error: '',
    issues: [{ number: 8, title: 'Padded', labels: [{ name: 'bug', color: '' }], url: '', updatedAt: '' }],
  });
});

test('listIssues reports the gh failure instead of an empty list', async () => {
  const gh = createPrGh('/repo', async () => ({ ok: false, out: 'not json', err: 'gh: not authenticated\n' }));

  assert.deepEqual(await gh.listIssues(), { ok: false, issues: [], error: 'gh: not authenticated' });
});

test('listIssues names the failing command when gh reports no stderr', async () => {
  const gh = createPrGh('/repo', async () => ({ ok: false, out: '', err: '' }));

  assert.deepEqual(await gh.listIssues(), { ok: false, issues: [], error: 'gh issue list failed' });
});

test('viewIssue reads one issue with its body in a single gh call', async () => {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const gh = createPrGh('/repo', async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    return {
      ok: true,
      err: '',
      out: JSON.stringify({
        number: 17,
        title: ' Fix reconnect ',
        body: 'The socket stalls.',
        labels: [{ name: 'bug', color: 'ff0000' }, { name: '', color: 'ff0000' }],
        url: 'https://github.test/acme/repo/issues/17',
        updatedAt: '2026-09-13T10:00:00Z',
      }),
    };
  });

  assert.deepEqual(await gh.viewIssue(17), {
    ok: true,
    error: '',
    issue: {
      number: 17,
      title: 'Fix reconnect',
      body: 'The socket stalls.',
      labels: [{ name: 'bug', color: 'ff0000' }],
      url: 'https://github.test/acme/repo/issues/17',
      updatedAt: '2026-09-13T10:00:00Z',
    },
  });
  assert.deepEqual(calls, [{
    cmd: 'gh',
    args: ['issue', 'view', '17', '--json', 'number,title,body,labels,url,updatedAt'],
    cwd: '/repo',
  }]);
});

test('viewIssue reports the gh failure instead of an empty issue', async () => {
  const gh = createPrGh('/repo', async () => ({ ok: false, out: '', err: 'gh: issue not found\n' }));

  assert.deepEqual(await gh.viewIssue(17), { ok: false, issue: null, error: 'gh: issue not found' });
});

test('viewIssue refuses a payload without a usable issue number', async () => {
  const gh = createPrGh('/repo', async () => ({ ok: true, out: 'not json', err: '' }));

  assert.deepEqual(await gh.viewIssue(17), { ok: false, issue: null, error: 'gh issue view returned no issue' });
});
