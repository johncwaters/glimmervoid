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

test('teamProfile passes validated variables to graphql and rejects malformed responses', async () => {
  const calls: string[][] = [];
  const profile = { name: 'Core', avatarUrl: 'https://avatars.githubusercontent.com/t/1' };
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify({ data: { organization: { team: profile } } }), err: '' };
  });
  assert.deepEqual(await gh.teamProfile('Acme', 'core'), { org: 'Acme', slug: 'core', ...profile });
  assert.deepEqual(calls, [['api', 'graphql', '-f', 'query=query($org: String!, $slug: String!) { organization(login: $org) { team(slug: $slug) { name avatarUrl } } }', '-f', 'org=Acme', '-f', 'slug=core']]);
  assert.equal(await gh.teamProfile('Acme/bad', 'core'), null);
  assert.equal(calls.length, 1);
  const invalid = createPrGh('/repo', async () => ({ ok: true, out: '{"data":{"organization":{"team":{"name":12}}}}', err: '' }));
  assert.equal(await invalid.teamProfile('Acme', 'core'), null);
  const failed = createPrGh('/repo', async () => ({ ok: false, out: '', err: 'failure' }));
  assert.equal(await failed.teamProfile('Acme', 'core'), null);
});

test('search methods use raw search API and chunk twelve authors into three requests', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify({ items: [searchItem(calls.length)] }), err: '' };
  });
  const requested = await gh.searchTeamRequested('Acme', 'docs');
  assert.deepEqual(requested.items.map((item) => item.number), [1]);
  assert.equal(requested.complete, true);
  const logins = Array.from({ length: 12 }, (_unused, index) => `member${index}`);
  const authored = await gh.searchAuthoredBy('Acme', logins);
  assert.deepEqual(authored.items.map((item) => item.number), [2, 3, 4]);
  assert.equal(authored.complete, true);
  assert.deepEqual(calls, [
    ['api', '-X', 'GET', 'search/issues', '-f', 'q=is:pr is:open draft:false org:Acme team-review-requested:Acme/docs', '-f', 'per_page=100', '-f', 'page=1'],
    ['api', '-X', 'GET', 'search/issues', '-f', 'q=is:pr is:open draft:false org:Acme author:member0 author:member1 author:member2 author:member3 author:member4', '-f', 'per_page=100', '-f', 'page=1'],
    ['api', '-X', 'GET', 'search/issues', '-f', 'q=is:pr is:open draft:false org:Acme author:member5 author:member6 author:member7 author:member8 author:member9', '-f', 'per_page=100', '-f', 'page=1'],
    ['api', '-X', 'GET', 'search/issues', '-f', 'q=is:pr is:open draft:false org:Acme author:member10 author:member11', '-f', 'per_page=100', '-f', 'page=1'],
  ]);
});

test('team search retains the PR creation time when supplied', async () => {
  const createdAt = '2026-09-26T12:00:00Z';
  const gh = createPrGh('/repo', async () => ({ ok: true, out: JSON.stringify({ items: [{ ...searchItem(7), created_at: createdAt }] }), err: '' }));
  assert.equal((await gh.searchTeamRequested('Acme', 'docs')).items[0]?.created_at, createdAt);
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
  const requested = await gh.searchTeamRequested('Acme', 'docs');
  assert.deepEqual(requested.items.map((item) => item.number), Array.from({ length: 203 }, (_unused, index) => index + 1));
  assert.equal(requested.complete, true);
  const query = 'q=is:pr is:open draft:false org:Acme team-review-requested:Acme/docs';
  assert.deepEqual(calls, [1, 2, 3].map((page) => ['api', '-X', 'GET', 'search/issues', '-f', query, '-f', 'per_page=100', '-f', `page=${page}`]));
});

test('search stops paging at the page cap and reports the truncated result incomplete', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: searchPageOf((calls.length - 1) * 100 + 1, 100), err: '' };
  });
  const requested = await gh.searchTeamRequested('Acme', 'docs');
  assert.equal(requested.items.length, 500);
  assert.equal(requested.complete, false);
  assert.deepEqual(calls.map((args) => args.at(-1)), ['page=1', 'page=2', 'page=3', 'page=4', 'page=5']);
});

test('search keeps gathered pages when a later page fails and reports the result incomplete', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    if (calls.length === 2) return { ok: false, out: '', err: 'rate limited' };
    return { ok: true, out: searchPageOf(1, 100), err: '' };
  });
  const requested = await gh.searchTeamRequested('Acme', 'docs');
  assert.equal(requested.items.length, 100);
  assert.equal(requested.complete, false);
  assert.equal(calls.length, 2);
});

test('an authored search with one failed author chunk reports the result incomplete', async () => {
  let calls = 0;
  const gh = createPrGh('/repo', async () => {
    calls += 1;
    if (calls === 2) return { ok: false, out: '', err: 'rate limited' };
    return { ok: true, out: searchPageOf(calls, 1), err: '' };
  });
  const logins = Array.from({ length: 12 }, (_unused, index) => `member${index}`);
  const authored = await gh.searchAuthoredBy('Acme', logins);
  assert.deepEqual(authored.items.map((item) => item.number), [1, 3]);
  assert.equal(authored.complete, false);
  assert.equal(calls, 3);
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

function reviewQueryField(alias: string, owner: string, name: string, number: number): string {
  return `${alias}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) { headRefOid latestReviews(first: 20) { nodes { author { login } state submittedAt commit { oid } } } } }`;
}

test('review snapshots batch aliased GraphQL fields, null empty commits and drop ghost authors', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify({ data: {
      pr0: { pullRequest: { headRefOid: HEAD_SHA, latestReviews: { nodes: [
        { author: { login: 'sarah' }, state: 'APPROVED', submittedAt: '2026-09-28T12:00:00Z', commit: { oid: HEAD_SHA } },
        { author: { login: 'copilot' }, state: 'COMMENTED', submittedAt: null, commit: { oid: '' } },
        { author: null, state: 'APPROVED', commit: { oid: HEAD_SHA } },
      ] } } },
      pr1: { pullRequest: null },
    } }), err: '' };
  });
  const snapshots = await gh.prReviewSnapshots([
    { repo: 'Acme/repo', number: 7 }, { repo: '../repo', number: 8 }, { repo: 'Acme/other', number: 9 }, { repo: 'Acme/repo', number: 0 },
  ]);
  assert.deepEqual([...snapshots.entries()], [['Acme/repo#7', { head: HEAD_SHA, reviews: [
    { login: 'sarah', state: 'APPROVED', commit: HEAD_SHA, submittedAt: '2026-09-28T12:00:00Z' },
    { login: 'copilot', state: 'COMMENTED', commit: null, submittedAt: null },
  ] }]]);
  assert.deepEqual(calls, [['api', 'graphql', '-f', `query=query { ${reviewQueryField('pr0', 'Acme', 'repo', 7)} ${reviewQueryField('pr1', 'Acme', 'other', 9)} }`]]);
});

test('review snapshots split into batches of 25 and keep partial data from a failed batch', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    const data = { pr0: { pullRequest: { headRefOid: HEAD_SHA, latestReviews: { nodes: [] } } }, pr1: null };
    return { ok: calls.length === 1, out: JSON.stringify({ data }), err: 'Could not resolve to a Repository' };
  });
  const prs = Array.from({ length: 27 }, (_unused, index) => ({ repo: 'Acme/repo', number: index + 1 }));
  const snapshots = await gh.prReviewSnapshots(prs);
  assert.equal(calls.length, 2);
  assert.deepEqual([...snapshots.keys()], ['Acme/repo#1', 'Acme/repo#26']);
  assert.equal((await gh.prReviewSnapshots([{ repo: 'bad/repo/path', number: 1 }])).size, 0);
  assert.equal(calls.length, 2);
});

test('invalid inputs and malformed contract payloads fail closed', async () => {
  let calls = 0;
  const invalid = createPrGh('/repo', async () => {
    calls += 1;
    return { ok: true, out: '{}', err: '' };
  });
  assert.deepEqual(await invalid.teamMembers('Acme/bad', 'docs'), []);
  assert.deepEqual(await invalid.searchTeamRequested('Acme', '../docs'), { items: [], complete: false });
  assert.deepEqual(await invalid.searchAuthoredBy('Acme', ['good', 'bad/login']), { items: [], complete: false });
  assert.equal(await invalid.viewPr('../repo', 7), null);
  assert.equal(await invalid.prDiff('Acme/repo', 0), null);
  assert.equal(await invalid.prHead('Acme/repo', 0), null);
  assert.equal(calls, 0);
  assert.equal(await invalid.viewer(), null);
  assert.deepEqual(await invalid.teamMembers('Acme', 'docs'), []);
  assert.deepEqual(await invalid.searchTeamRequested('Acme', 'docs'), { items: [], complete: false });
  assert.deepEqual(await invalid.searchAuthoredBy('Acme', ['alice']), { items: [], complete: false });
  assert.equal(await invalid.viewPr('Acme/repo', 7), null);
  assert.equal(await invalid.prHead('Acme/repo', 7), null);
  const oversized = createPrGh('/repo', async () => ({ ok: true, out: 'x'.repeat(2 * 1024 * 1024 + 1), err: '' }));
  assert.equal(await oversized.prDiff('Acme/repo', 7), null);
});

test('postReview sends one JSON request through stdin', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const gh = createPrGh('/repo', async (_command, args, _cwd, input) => {
    calls.push({ args, input });
    return { ok: true, out: '{"id":99,"state":"COMMENTED"}', err: '' };
  });
  assert.deepEqual(await gh.postReview({
    repo: 'Acme/repo', number: 7, commitId: HEAD_SHA, event: 'COMMENT', body: 'Review',
    comments: [{ path: 'src/main.ts', line: 3, side: 'RIGHT', body: 'Please check this' }],
  }), { ok: true, err: '', reviewId: 99 });
  assert.deepEqual(calls, [{
    args: ['api', '-X', 'POST', 'repos/Acme/repo/pulls/7/reviews', '--input', '-'],
    input: JSON.stringify({ commit_id: HEAD_SHA, event: 'COMMENT', body: 'Review', comments: [{ path: 'src/main.ts', line: 3, side: 'RIGHT', body: 'Please check this' }] }),
  }]);
  assert.deepEqual(await gh.postReview({ repo: 'Acme/../repo', number: 7, commitId: HEAD_SHA, event: 'COMMENT', body: '', comments: [] }), { ok: false, err: 'invalid repository or pull request number', reviewId: null });
  assert.equal(calls.length, 1);
});

test('postReview reports a null review id when gh returns no usable id', async () => {
  const gh = createPrGh('/repo', async () => ({ ok: true, out: '{}', err: '' }));
  assert.deepEqual(await gh.postReview({ repo: 'Acme/repo', number: 7, commitId: HEAD_SHA, event: 'APPROVE', body: '', comments: [] }), { ok: true, err: '', reviewId: null });
});

test('dismissReview sends one JSON dismissal through stdin and refuses bad segments', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const gh = createPrGh('/repo', async (_command, args, _cwd, input) => {
    calls.push({ args, input });
    return { ok: true, out: '{}', err: '' };
  });
  assert.deepEqual(await gh.dismissReview({ repo: 'Acme/repo', number: 7, reviewId: 99, message: 'Head moved' }), { ok: true, err: '' });
  assert.deepEqual(calls, [{
    args: ['api', '-X', 'PUT', 'repos/Acme/repo/pulls/7/reviews/99/dismissals', '--input', '-'],
    input: JSON.stringify({ message: 'Head moved', event: 'DISMISS' }),
  }]);
  assert.deepEqual(await gh.dismissReview({ repo: 'Acme/../repo', number: 7, reviewId: 99, message: 'x' }), { ok: false, err: 'invalid repository or pull request number' });
  assert.deepEqual(await gh.dismissReview({ repo: 'Acme/repo', number: 7, reviewId: 0, message: 'x' }), { ok: false, err: 'invalid review id' });
  assert.deepEqual(await gh.dismissReview({ repo: 'Acme/repo', number: 7, reviewId: 99, message: ' ' }), { ok: false, err: 'a dismissal needs a message' });
  assert.equal(calls.length, 1);
});

test('dismissReview reports the gh failure', async () => {
  const gh = createPrGh('/repo', async () => ({ ok: false, out: '', err: 'HTTP 403\n' }));
  assert.deepEqual(await gh.dismissReview({ repo: 'Acme/repo', number: 7, reviewId: 99, message: 'Head moved' }), { ok: false, err: 'HTTP 403' });
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

function myPrNode(number: number) {
  return {
    __typename: 'PullRequest', id: `PR_node${number}`, number, title: 'Fix', url: `https://github.com/Acme/app/pull/${number}`, isDraft: false,
    state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T00:00:00Z', baseRefName: 'main', headRefOid: HEAD_SHA, isInMergeQueue: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app' },
    commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
  };
}

test('my PR search uses one GraphQL call and drops invalid nodes', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify({ data: { open: { issueCount: 70, nodes: [myPrNode(1), { number: 2 }] }, merged: { issueCount: 3, nodes: [myPrNode(3)] } } }), err: '' };
  });
  const searched = await gh.searchMyPrs('Acme', '2026-09-27');
  assert.equal(searched.ok, true);
  assert.deepEqual(searched.items.map((item) => item.number), [1, 3]);
  assert.equal(searched.totalCount, 73);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'api');
  assert.equal(calls[0][1], 'graphql');
  assert.ok(calls[0].includes('openQuery=is:pr is:open author:@me org:Acme sort:updated-desc'));
  assert.ok(calls[0].includes('mergedQuery=is:pr is:merged author:@me org:Acme merged:>=2026-09-27 sort:updated-desc'));
  assert.equal(calls[0].find((arg) => arg.startsWith('query='))?.match(/issueCount/g)?.length, 2);
  assert.match(calls[0].find((arg) => arg.startsWith('query=')) ?? '', /\.\.\. on Team \{ slug avatarUrl organization \{ login \} \}/);
});

test('my PR search rejects invalid input and malformed whole responses', async () => {
  let calls = 0;
  const gh = createPrGh('/repo', async () => {
    calls += 1;
    return { ok: true, out: '{"data":{"open":{"nodes":[]}}}', err: '' };
  });
  assert.equal((await gh.searchMyPrs('Acme evil', '2026-09-27')).ok, false);
  assert.equal((await gh.searchMyPrs('Acme', 'yesterday')).ok, false);
  assert.equal(calls, 0);
  assert.equal((await gh.searchMyPrs('Acme', '2026-09-27')).ok, false);
  assert.equal(calls, 1);
});

test('my PR search refuses partial GraphQL data with errors', async () => {
  const gh = createPrGh('/repo', async () => ({
    ok: true, out: JSON.stringify({ data: { open: { issueCount: 1, nodes: [myPrNode(1)] }, merged: { issueCount: 0, nodes: [] } }, errors: [{ message: 'denied' }] }), err: '',
  }));
  assert.deepEqual(await gh.searchMyPrs('Acme', '2026-09-27'), { ok: false, items: [], totalCount: 0, error: 'gh graphql returned errors' });
});

test('reviewThreads queries one pull request and drops malformed threads', async () => {
  const calls: string[][] = [];
  const validThread = {
    isResolved: false, isOutdated: false, path: 'src/app.ts', line: 3,
    firstComment: { totalCount: 1, nodes: [{ author: { login: 'bob' }, bodyText: 'Rename', url: 'https://github.com/Acme/app/pull/7#discussion_r1', createdAt: '2026-09-28T00:00:00Z' }] },
    lastComment: { nodes: [{ author: null, createdAt: '2026-09-28T00:00:00Z' }] },
  };
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [validThread, { isResolved: false }] } } } } }), err: '' };
  });
  assert.deepEqual(await gh.reviewThreads('Acme/app', 7), [validThread]);
  assert.ok(!calls[0].some((arg) => arg.startsWith('cursor=')));
  assert.ok(calls[0].includes('owner=Acme'));
  assert.ok(calls[0].includes('name=app'));
  assert.ok(calls[0].includes('number=7'));
  assert.deepEqual(await gh.reviewThreads('Acme/app/extra', 7), []);
  assert.deepEqual(await gh.reviewThreads('Acme/app', 0), []);
  assert.equal(calls.length, 1);
});

function reviewThreadAt(path: string) {
  return {
    isResolved: false, isOutdated: false, path, line: 1,
    firstComment: { totalCount: 1, nodes: [{ author: { login: 'bob' }, bodyText: 'Rename', url: 'https://github.com/Acme/app/pull/7#discussion_r1', createdAt: '2026-09-28T00:00:00Z' }] },
    lastComment: { nodes: [{ author: null, createdAt: '2026-09-28T00:00:00Z' }] },
  };
}

function reviewThreadPage(path: string, nextCursor: string | null): string {
  const pageInfo = { hasNextPage: nextCursor !== null, endCursor: nextCursor };
  return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes: [reviewThreadAt(path)] } } } } });
}

test('reviewThreads follows the cursor across pages', async () => {
  const calls: string[][] = [];
  const pages = [reviewThreadPage('a.ts', 'c1'), reviewThreadPage('b.ts', 'c2'), reviewThreadPage('c.ts', null)];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: pages[calls.length - 1], err: '' };
  });
  assert.deepEqual((await gh.reviewThreads('Acme/app', 7)).map((thread) => thread.path), ['a.ts', 'b.ts', 'c.ts']);
  assert.equal(calls.length, 3);
  assert.ok(!calls[0].some((arg) => arg.startsWith('cursor=')));
  assert.ok(calls[1].includes('cursor=c1'));
  assert.ok(calls[2].includes('cursor=c2'));
});

test('reviewThreads stops at the page cap', async () => {
  let calls = 0;
  const gh = createPrGh('/repo', async () => {
    calls += 1;
    return { ok: true, out: reviewThreadPage(`page${calls}.ts`, `c${calls}`), err: '' };
  });
  assert.equal((await gh.reviewThreads('Acme/app', 7)).length, 5);
  assert.equal(calls, 5);
});

test('reviewThreads returns nothing when a later page fails', async () => {
  let calls = 0;
  const gh = createPrGh('/repo', async () => {
    calls += 1;
    if (calls === 1) return { ok: true, out: reviewThreadPage('a.ts', 'c1'), err: '' };
    return { ok: false, out: '', err: 'rate limited' };
  });
  assert.deepEqual(await gh.reviewThreads('Acme/app', 7), []);
  assert.equal(calls, 2);
});

test('reviewThreads returns nothing when GraphQL reports errors', async () => {
  const gh = createPrGh('/repo', async () => ({ ok: true, out: JSON.stringify({ data: { repository: null }, errors: [{ message: 'denied' }] }), err: '' }));
  assert.deepEqual(await gh.reviewThreads('Acme/app', 7), []);
});

test('rebasePr sends a REBASE branch update pinned to the expected head and reports GraphQL errors', async () => {
  const calls: string[][] = [];
  let output = JSON.stringify({ data: { updatePullRequestBranch: { pullRequest: { headRefOid: HEAD_SHA } } } });
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: output, err: '' };
  });
  assert.deepEqual(await gh.rebasePr('PR_kwDO1', HEAD_SHA), { ok: true, err: '' });
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]?.[3]), /updateMethod: REBASE/);
  assert.match(String(calls[0]?.[3]), /expectedHeadOid: \$head/);
  assert.deepEqual(calls[0]?.slice(4), ['-f', 'id=PR_kwDO1', '-f', `head=${HEAD_SHA}`]);
  output = JSON.stringify({ data: null, errors: [{ message: 'Head branch was modified' }] });
  assert.deepEqual(await gh.rebasePr('PR_kwDO1', HEAD_SHA), { ok: false, err: 'Head branch was modified' });
  assert.equal((await gh.rebasePr('bad id', HEAD_SHA)).ok, false);
  assert.equal((await gh.rebasePr('PR_kwDO1', 'bad')).ok, false);
  assert.equal(calls.length, 2);
});

test('behindCounts asks GitHub for every valid pull request in one aliased compare query', async () => {
  const queries: string[] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    queries.push(String(args[3]));
    return { ok: true, out: JSON.stringify({ data: {
      pr0: { pullRequest: { baseRef: { compare: { behindBy: 343 } } } },
      pr1: { pullRequest: { baseRef: null } },
    } }), err: '' };
  });
  const counts = await gh.behindCounts([
    { repo: 'Acme/app', number: 7, headSha: HEAD_SHA }, { repo: 'Acme/lib', number: 8, headSha: HEAD_SHA },
    { repo: 'Acme/app/extra', number: 9, headSha: HEAD_SHA }, { repo: 'Acme/app', number: 10, headSha: 'bad' },
  ]);
  assert.deepEqual([...counts], [['Acme/app#7', 343]]);
  assert.equal(queries.length, 1);
  assert.match(queries[0] ?? '', /pr0: repository\(owner: "Acme", name: "app"\) \{ pullRequest\(number: 7\) \{ baseRef \{ compare\(headRef: "[0-9a-f]{40}"\) \{ behindBy \} \} \} \}/);
  assert.match(queries[0] ?? '', /pr1: repository\(owner: "Acme", name: "lib"\)/);
  assert.doesNotMatch(queries[0] ?? '', /number: (9|10)\)/);
  assert.deepEqual([...await gh.behindCounts([])], []);
  assert.equal(queries.length, 1);
});
