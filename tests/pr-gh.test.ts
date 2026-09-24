import test from 'node:test';
import assert from 'node:assert/strict';

import { createPrGh } from '../server/pr-gh.ts';

const HEAD_SHA = 'a'.repeat(40);

function searchItem(number: number) {
  return {
    number, title: `PR ${number}`, html_url: `https://github.com/Acme/repo/pull/${number}`,
    repository_url: 'https://api.github.com/repos/Acme/repo',
    user: { login: 'alice', type: 'User' }, pull_request: {},
  };
}

function prDetail() {
  return {
    number: 7, title: 'Fix', body: 'Body', url: 'https://github.com/Acme/repo/pull/7',
    author: { login: 'alice' }, isDraft: false, isCrossRepository: false,
    baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefOid: HEAD_SHA,
    additions: 1, deletions: 0, files: [{ path: 'src/main.ts', additions: 1, deletions: 0 }],
  };
}

test('viewer and teamMembers use exact gh API arguments', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (command, args, cwd) => {
    assert.equal(command, 'gh');
    assert.equal(cwd, '/repo');
    calls.push(args);
    return { ok: true, out: calls.length === 1 ? 'alice' : 'alice\nbob', err: '' };
  });
  assert.equal(await gh.viewer(), 'alice');
  assert.deepEqual(await gh.teamMembers('Acme', 'docs'), ['alice', 'bob']);
  assert.deepEqual(calls, [
    ['api', 'user', '--jq', '.login'],
    ['api', '--paginate', 'orgs/Acme/teams/docs/members', '--jq', '.[].login'],
  ]);
});

test('search methods use raw search API and chunk twelve authors into three requests', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify({ items: [searchItem(calls.length)] }), err: '' };
  });
  assert.deepEqual((await gh.searchTeamRequested('Acme', 'docs')).map((item) => item.number), [1]);
  const logins = Array.from({ length: 12 }, (_unused, index) => `member${index}`);
  assert.deepEqual((await gh.searchAuthoredBy('Acme', logins)).map((item) => item.number), [2, 3, 4]);
  assert.deepEqual(calls, [
    ['api', '-X', 'GET', 'search/issues', '-f', 'q=is:pr is:open draft:false org:Acme team-review-requested:Acme/docs', '-f', 'per_page=100', '-f', 'page=1'],
    ['api', '-X', 'GET', 'search/issues', '-f', 'q=is:pr is:open draft:false org:Acme author:member0 author:member1 author:member2 author:member3 author:member4', '-f', 'per_page=100', '-f', 'page=1'],
    ['api', '-X', 'GET', 'search/issues', '-f', 'q=is:pr is:open draft:false org:Acme author:member5 author:member6 author:member7 author:member8 author:member9', '-f', 'per_page=100', '-f', 'page=1'],
    ['api', '-X', 'GET', 'search/issues', '-f', 'q=is:pr is:open draft:false org:Acme author:member10 author:member11', '-f', 'per_page=100', '-f', 'page=1'],
  ]);
});

function searchPageOf(firstNumber: number, count: number) {
  return JSON.stringify({ items: Array.from({ length: count }, (_unused, index) => searchItem(firstNumber + index)) });
}

test('search pages through full result pages until a short page', async () => {
  const calls: string[][] = [];
  const pageSizes = [100, 100, 3];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    const pageIndex = calls.length - 1;
    return { ok: true, out: searchPageOf(pageIndex * 100 + 1, pageSizes[pageIndex]), err: '' };
  });
  const numbers = (await gh.searchTeamRequested('Acme', 'docs')).map((item) => item.number);
  assert.deepEqual(numbers, Array.from({ length: 203 }, (_unused, index) => index + 1));
  const query = 'q=is:pr is:open draft:false org:Acme team-review-requested:Acme/docs';
  assert.deepEqual(calls, [1, 2, 3].map((page) => ['api', '-X', 'GET', 'search/issues', '-f', query, '-f', 'per_page=100', '-f', `page=${page}`]));
});

test('search stops paging at the page cap', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: searchPageOf((calls.length - 1) * 100 + 1, 100), err: '' };
  });
  assert.equal((await gh.searchTeamRequested('Acme', 'docs')).length, 500);
  assert.deepEqual(calls.map((args) => args.at(-1)), ['page=1', 'page=2', 'page=3', 'page=4', 'page=5']);
});

test('search keeps gathered pages when a later page fails', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    if (calls.length === 2) return { ok: false, out: '', err: 'rate limited' };
    return { ok: true, out: searchPageOf(1, 100), err: '' };
  });
  assert.equal((await gh.searchTeamRequested('Acme', 'docs')).length, 100);
  assert.equal(calls.length, 2);
});

test('PR reads use exact argv and parse contract shapes', async () => {
  const calls: string[][] = [];
  const outputs = [JSON.stringify(prDetail()), 'diff --git a/file b/file', HEAD_SHA];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: outputs[calls.length - 1], err: '' };
  });
  assert.deepEqual(await gh.viewPr('Acme/repo', 7), prDetail());
  assert.equal(await gh.prDiff('Acme/repo', 7), outputs[1]);
  assert.equal(await gh.prHead('Acme/repo', 7), HEAD_SHA);
  assert.deepEqual(calls, [
    ['pr', 'view', '7', '-R', 'Acme/repo', '--json', 'number,title,body,url,author,isDraft,isCrossRepository,baseRefName,baseRefOid,headRefOid,additions,deletions,files'],
    ['pr', 'diff', '7', '-R', 'Acme/repo'],
    ['pr', 'view', '7', '-R', 'Acme/repo', '--json', 'headRefOid', '--jq', '.headRefOid'],
  ]);
});

test('invalid inputs and malformed contract payloads fail closed', async () => {
  let calls = 0;
  const invalid = createPrGh('/repo', async () => {
    calls += 1;
    return { ok: true, out: '{}', err: '' };
  });
  assert.deepEqual(await invalid.teamMembers('Acme/bad', 'docs'), []);
  assert.deepEqual(await invalid.searchTeamRequested('Acme', '../docs'), []);
  assert.deepEqual(await invalid.searchAuthoredBy('Acme', ['good', 'bad/login']), []);
  assert.equal(await invalid.viewPr('../repo', 7), null);
  assert.equal(await invalid.prDiff('Acme/repo', 0), null);
  assert.equal(await invalid.prHead('Acme/repo', 0), null);
  assert.equal(calls, 0);
  assert.equal(await invalid.viewer(), null);
  assert.deepEqual(await invalid.teamMembers('Acme', 'docs'), []);
  assert.deepEqual(await invalid.searchTeamRequested('Acme', 'docs'), []);
  assert.deepEqual(await invalid.searchAuthoredBy('Acme', ['alice']), []);
  assert.equal(await invalid.viewPr('Acme/repo', 7), null);
  assert.equal(await invalid.prHead('Acme/repo', 7), null);
  const oversized = createPrGh('/repo', async () => ({ ok: true, out: 'x'.repeat(2 * 1024 * 1024 + 1), err: '' }));
  assert.equal(await oversized.prDiff('Acme/repo', 7), null);
});

test('postReview sends one JSON request through stdin', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const gh = createPrGh('/repo', async (_command, args, _cwd, input) => {
    calls.push({ args, input });
    return { ok: true, out: '{}', err: '' };
  });
  assert.deepEqual(await gh.postReview({
    repo: 'Acme/repo', number: 7, commitId: HEAD_SHA, event: 'COMMENT', body: 'Review',
    comments: [{ path: 'src/main.ts', line: 3, side: 'RIGHT', body: 'Please check this' }],
  }), { ok: true, err: '' });
  assert.deepEqual(calls, [{
    args: ['api', '-X', 'POST', 'repos/Acme/repo/pulls/7/reviews', '--input', '-'],
    input: JSON.stringify({ commit_id: HEAD_SHA, event: 'COMMENT', body: 'Review', comments: [{ path: 'src/main.ts', line: 3, side: 'RIGHT', body: 'Please check this' }] }),
  }]);
  assert.deepEqual(await gh.postReview({ repo: 'Acme/../repo', number: 7, commitId: HEAD_SHA, event: 'COMMENT', body: '', comments: [] }), { ok: false, err: 'invalid repository or pull request number' });
  assert.equal(calls.length, 1);
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
