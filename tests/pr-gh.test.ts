import test from 'node:test';
import assert from 'node:assert/strict';

import { threadNode } from './helpers/team-review-thread-fixture.ts';
import { createPrGh } from '../server/pr-gh.ts';
import type { CommandResult } from '../server/pr-gh.ts';
import type { MyPrMergeKind } from '../shared/contracts/my-prs.ts';

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
  return `${alias}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${number}) { headRefOid isDraft reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } latestReviews(first: 20) { nodes { author { login } state submittedAt commit { oid } } } latestOpinionatedReviews(first: 20, writersOnly: true) { nodes { state } } } }`;
}

test('review snapshots batch aliased GraphQL fields, null empty commits and drop ghost authors', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify({ data: {
      pr0: { pullRequest: { headRefOid: HEAD_SHA, reviewDecision: 'APPROVED', latestReviews: { nodes: [
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
  assert.deepEqual([...snapshots.entries()], [['Acme/repo#7', { head: HEAD_SHA, reviewDecision: 'APPROVED', reviews: [
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
    state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T00:00:00Z', baseRefName: 'main', headRefName: 'feature', isCrossRepository: false, headRefOid: HEAD_SHA, isInMergeQueue: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app', viewerDefaultMergeMethod: 'SQUASH' },
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
  assert.match(calls[0].find((arg) => arg.startsWith('query=')) ?? '', /repository \{ nameWithOwner viewerDefaultMergeMethod \}/);
  assert.match(calls[0].find((argument) => argument.startsWith('query=')) ?? '', /baseRefName headRefName isCrossRepository headRefOid/);
  assert.equal(searched.items[0]?.headRefName, 'feature');
  assert.equal(searched.items[0]?.isCrossRepository, false);
  assert.equal(searched.items[0]?.repository.viewerDefaultMergeMethod, 'SQUASH');
});

function mergeGh(prStateAfterMerge: CommandResult) {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (command, args) => {
    calls.push([command, ...args]);
    return args[1] === 'merge' ? { ok: true, out: '', err: '' } : prStateAfterMerge;
  });
  return { gh, calls };
}

function prStateJson(state: string, isInMergeQueue: boolean, autoMergeRequest: { enabledAt: string | null } | null): CommandResult {
  return { ok: true, out: JSON.stringify({ data: { repository: { pullRequest: { state, isInMergeQueue, autoMergeRequest } } } }), err: '' };
}

test('mergePr runs gh pr merge with each method flag pinned to the expected head, then reads back what GitHub did', async () => {
  const flagsByMethod = [['MERGE', '--merge'], ['SQUASH', '--squash'], ['REBASE', '--rebase']] as const;
  for (const [method, flag] of flagsByMethod) {
    const { gh, calls } = mergeGh(prStateJson('MERGED', false, null));
    assert.deepEqual(await gh.mergePr({ repo: 'Acme/app', number: 7, headSha: HEAD_SHA, method }), { ok: true, kind: 'merged' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ['gh', 'pr', 'merge', '7', '--repo', 'Acme/app', flag, '--match-head-commit', HEAD_SHA]);
    const [command, api, graphql, queryFlag, queryArg, ...variables] = calls[1] ?? [];
    assert.deepEqual([command, api, graphql, queryFlag], ['gh', 'api', 'graphql', '-f']);
    assert.match(String(queryArg), /^query=query\(\$owner: String!, \$name: String!, \$number: Int!\)/);
    assert.match(String(queryArg), /repository\(owner: \$owner, name: \$name\) \{ pullRequest\(number: \$number\) \{ state isInMergeQueue autoMergeRequest \{ enabledAt \} \} \}/);
    assert.deepEqual(variables, ['-f', 'owner=Acme', '-f', 'name=app', '-F', 'number=7']);
    assert.ok(!calls[1]?.includes('view'));
  }
});

test('mergePr reports a merge queue entry, an auto-merge request or an unconfirmed merge instead of claiming a merge', async () => {
  const cases: [CommandResult, MyPrMergeKind][] = [
    [prStateJson('OPEN', true, null), 'queued'],
    [prStateJson('OPEN', false, { enabledAt: '2026-10-02T00:00:00Z' }), 'auto-merge'],
    [prStateJson('OPEN', false, null), 'unconfirmed'],
    [prStateJson('CLOSED', true, { enabledAt: '2026-10-02T00:00:00Z' }), 'unconfirmed'],
    [{ ok: true, out: JSON.stringify({ data: { repository: { pullRequest: null } } }), err: '' }, 'unconfirmed'],
    [{ ok: true, out: JSON.stringify({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] }), err: '' }, 'unconfirmed'],
    [{ ok: true, out: JSON.stringify({ state: 'MERGED', isInMergeQueue: false, autoMergeRequest: null }), err: '' }, 'unconfirmed'],
    [{ ok: true, out: 'not json', err: '' }, 'unconfirmed'],
    [{ ok: false, out: '', err: 'rate limited' }, 'unconfirmed'],
  ];
  for (const [prStateAfterMerge, kind] of cases) {
    const { gh } = mergeGh(prStateAfterMerge);
    assert.deepEqual(await gh.mergePr({ repo: 'Acme/app', number: 7, headSha: HEAD_SHA, method: 'SQUASH' }), { ok: true, kind }, prStateAfterMerge.out || prStateAfterMerge.err);
  }
});

test('mergePr refuses invalid input without calling gh and reports gh failures', async () => {
  let calls = 0;
  const gh = createPrGh('/repo', async () => {
    calls += 1;
    return { ok: false, out: '', err: 'GraphQL: Head branch was modified\n' };
  });
  assert.equal((await gh.mergePr({ repo: 'Acme', number: 7, headSha: HEAD_SHA, method: 'MERGE' })).ok, false);
  assert.equal((await gh.mergePr({ repo: 'Acme/app', number: 0, headSha: HEAD_SHA, method: 'MERGE' })).ok, false);
  assert.equal((await gh.mergePr({ repo: 'Acme/app', number: 7, headSha: 'main', method: 'MERGE' })).ok, false);
  assert.equal(calls, 0);
  assert.deepEqual(await gh.mergePr({ repo: 'Acme/app', number: 7, headSha: HEAD_SHA, method: 'SQUASH' }), { ok: false, err: 'GraphQL: Head branch was modified' });
  assert.equal(calls, 1);
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

test('rateLimitWaitMs reads the free rate_limit endpoint and waits for the latest exhausted reset among the named resources', async () => {
  const calls: string[][] = [];
  let resources: unknown = { core: { remaining: 4000, reset: 2000 }, search: { remaining: 0, reset: 1100 }, graphql: { remaining: 0, reset: 1300 }, code_search: { remaining: 0, reset: 3000 } };
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify(resources), err: '' };
  });
  assert.equal(await gh.rateLimitWaitMs(1_000_000, ['search', 'graphql', 'core']), 300_000);
  assert.equal(await gh.rateLimitWaitMs(1_000_000, ['search']), 100_000);
  assert.deepEqual(calls[0], ['api', 'rate_limit', '--jq', '.resources']);
  resources = { core: { remaining: 10, reset: 2000 } };
  assert.equal(await gh.rateLimitWaitMs(1_000_000, ['core']), null);
  resources = 'not json';
  assert.equal(await gh.rateLimitWaitMs(1_000_000, ['core']), null);
});

test('reviewThreadsBatch reads first pages in one aliased query and pages only a pull request with more threads', async () => {
  const queries: string[] = [];
  const thread = (path: string) => ({
    isResolved: false, isOutdated: false, path, line: 3,
    firstComment: { totalCount: 1, nodes: [{ author: { login: 'bob' }, bodyText: 'Fix', url: 'https://github.com/Acme/app/pull/7#discussion_r1', createdAt: '2026-09-28T10:00:00Z' }] },
    lastComment: { nodes: [{ author: { login: 'bob' }, createdAt: '2026-09-28T10:00:00Z' }] },
  });
  const gh = createPrGh('/repo', async (_command, args) => {
    const query = String(args[3]);
    queries.push(query);
    if (query.includes('pr0:')) {
      return { ok: true, out: JSON.stringify({ data: {
        pr0: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [thread('a.ts'), { invalid: true }] } } },
        pr1: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [thread('ignored.ts')] } } },
      } }), err: '' };
    }
    return { ok: true, out: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [thread('b.ts'), thread('c.ts')] } } } } }), err: '' };
  });
  const threads = await gh.reviewThreadsBatch([{ repo: 'Acme/app', number: 7 }, { repo: 'Acme/app', number: 8 }, { repo: 'bad/repo/x', number: 9 }]);
  assert.deepEqual([...threads].map(([key, nodes]) => [key, nodes.map((node) => node.path)]), [['Acme/app#7', ['a.ts']], ['Acme/app#8', ['b.ts', 'c.ts']]]);
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[0] ?? '', /number: 9\)/);
});

function mergedPrNode(number: number) {
  return { number, title: `PR ${number}`, url: `https://github.com/Acme/repo/pull/${number}`, mergedAt: '2026-09-19T00:00:00Z', reviewThreads: { totalCount: 4 }, reviews: { totalCount: 1 } };
}

function mergedPrPage(numbers: number[], endCursor: string | null) {
  return JSON.stringify({ data: { search: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes: [...numbers.map(mergedPrNode), {}] } } });
}

test('listMergedPrs searches merged pull requests by cursor until the limit and drops non pull request nodes', async () => {
  const calls: string[][] = [];
  const pages = [mergedPrPage([1, 2], 'cursor-1'), mergedPrPage([3], null)];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: pages[calls.length - 1] ?? '', err: '' };
  });
  const listed = await gh.listMergedPrs('Acme/repo', 27);
  assert.deepEqual(listed.ok && listed.prs.map((pr) => pr.number), [1, 2, 3]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].includes('searchQuery=repo:Acme/repo is:pr is:merged sort:updated-desc'), true);
  assert.equal(calls[0].includes('first=27'), true);
  assert.equal(calls[0].includes('cursor=cursor-1'), false);
  assert.equal(calls[1].includes('first=25'), true);
  assert.equal(calls[1].includes('cursor=cursor-1'), true);
});

test('listMergedPrs refuses a bad repository without calling gh and reports gh failures', async () => {
  let callCount = 0;
  const gh = createPrGh('/repo', async () => {
    callCount += 1;
    return { ok: false, out: '', err: 'rate limited' };
  });
  assert.deepEqual(await gh.listMergedPrs('--repo/evil', 10), { ok: false, reason: 'invalid repository' });
  assert.equal(callCount, 0);
  assert.deepEqual(await gh.listMergedPrs('Acme/repo', 10), { ok: false, reason: 'rate limited' });
});

function minedReviewData() {
  return {
    author: { __typename: 'User', login: 'alice' }, baseRefOid: 'b'.repeat(40),
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
    timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
  };
}

test('benchmarkReviewData reads ten pull requests per aliased query and drops malformed ones', async () => {
  const queries: string[] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    const query = args.find((arg) => arg.startsWith('query=')) ?? '';
    queries.push(query);
    const aliasCount = query.match(/pr\d+: repository/g)?.length ?? 0;
    const data = Object.fromEntries(Array.from({ length: aliasCount }, (_unused, index) => [`pr${index}`, { pullRequest: index === 1 ? { baseRefOid: 'bad' } : minedReviewData() }]));
    return { ok: true, out: JSON.stringify({ data }), err: '' };
  });
  const numbers = Array.from({ length: 12 }, (_unused, index) => index + 1);
  const dataByNumber = await gh.benchmarkReviewData('Acme/repo', numbers);
  assert.equal(queries.length, 2);
  assert.match(queries[0], /BASE_REF_FORCE_PUSHED_EVENT/);
  assert.match(queries[0], /originalCommit \{ oid \}/);
  assert.deepEqual([...dataByNumber.keys()], [1, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('compareCommits asks for the merge base and file names and flags a capped file list', async () => {
  const calls: string[][] = [];
  const base = 'b'.repeat(40);
  let fileCount = 2;
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify({ mergeBaseSha: 'c'.repeat(40), changedFiles: ['a.ts', 'b.ts'], fileCount }), err: '' };
  });
  assert.deepEqual(await gh.compareCommits('Acme/repo', base, HEAD_SHA), { mergeBaseSha: 'c'.repeat(40), changedFiles: ['a.ts', 'b.ts'], isFileListComplete: true });
  assert.deepEqual(calls[0].slice(0, 2), ['api', `repos/Acme/repo/compare/${base}...${HEAD_SHA}`]);
  fileCount = 300;
  assert.equal((await gh.compareCommits('Acme/repo', base, HEAD_SHA))?.isFileListComplete, false);
  assert.equal(await gh.compareCommits('Acme/repo', 'main', HEAD_SHA), null);
  assert.equal(calls.length, 2);
});

test('direct review request search shares paging bounds and fails closed', async () => {
  const calls: string[][] = [];
  const github = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: searchPageOf((calls.length - 1) * 100 + 1, 100), err: '' };
  });
  const search = await github.searchDirectRequested('Acme');
  assert.equal(calls.length, 5);
  assert.equal(search.items.length, 500);
  assert.equal(search.complete, false);
  assert.ok(calls.every((args) => args.includes('q=is:pr is:open draft:false org:Acme user-review-requested:@me') && args.includes('per_page=100')));
  assert.deepEqual(await github.searchDirectRequested('../Acme'), { items: [], complete: false });
  assert.equal(calls.length, 5);
});

test('review snapshots carry validated draft and aggregate CI state', async () => {
  const github = createPrGh('/repo', async () => ({ ok: true, out: JSON.stringify({ data: { pr0: { pullRequest: {
    headRefOid: HEAD_SHA, isDraft: false, reviewDecision: 'REVIEW_REQUIRED', latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
  } } } }), err: '' }));
  const snapshots = await github.prReviewSnapshots([{ repo: 'Acme/repo', number: 7 }]);
  assert.deepEqual(snapshots.get('Acme/repo#7'), { head: HEAD_SHA, isDraft: false, reviewDecision: 'REVIEW_REQUIRED', reviews: [], checksState: 'FAILURE' });
});

test('a repository without required reviews reports the decision it would have if approval were required', async () => {
  const snapshotWith = async (opinionatedStates: string[] | undefined, latestStates: string[] = []) => {
    const github = createPrGh('/repo', async () => ({ ok: true, out: JSON.stringify({ data: { pr0: { pullRequest: {
      headRefOid: HEAD_SHA, reviewDecision: null,
      latestReviews: { nodes: latestStates.map((state, index) => ({ author: { login: `reviewer${index}` }, state, commit: { oid: HEAD_SHA } })) },
      ...(opinionatedStates ? { latestOpinionatedReviews: { nodes: opinionatedStates.map((state) => ({ state })) } } : {}),
    } } } }), err: '' }));
    return (await github.prReviewSnapshots([{ repo: 'Acme/repo', number: 7 }])).get('Acme/repo#7')?.reviewDecision;
  };
  assert.equal(await snapshotWith(['APPROVED']), 'APPROVED');
  assert.equal(await snapshotWith(['APPROVED', 'CHANGES_REQUESTED']), 'CHANGES_REQUESTED');
  assert.equal(await snapshotWith([]), 'REVIEW_REQUIRED');
  assert.equal(await snapshotWith(undefined), 'REVIEW_REQUIRED');
});

test('a writer who requested changes and later only commented still blocks a repository without required reviews', async () => {
  const github = createPrGh('/repo', async () => ({ ok: true, out: JSON.stringify({ data: { pr0: { pullRequest: {
    headRefOid: HEAD_SHA, reviewDecision: null,
    latestReviews: { nodes: [{ author: { login: 'reviewer' }, state: 'COMMENTED', commit: { oid: HEAD_SHA } }] },
    latestOpinionatedReviews: { nodes: [{ state: 'CHANGES_REQUESTED' }] },
  } } } }), err: '' }));
  const snapshot = (await github.prReviewSnapshots([{ repo: 'Acme/repo', number: 7 }])).get('Acme/repo#7');
  assert.equal(snapshot?.reviewDecision, 'CHANGES_REQUESTED');
  assert.deepEqual(snapshot?.reviews.map((review) => review.state), ['COMMENTED']);
});

test('approvals visible only in latest reviews do not satisfy a repository without required reviews', async () => {
  const github = createPrGh('/repo', async () => ({ ok: true, out: JSON.stringify({ data: { pr0: { pullRequest: {
    headRefOid: HEAD_SHA, reviewDecision: null,
    latestReviews: { nodes: [{ author: { login: 'outsider' }, state: 'APPROVED', commit: { oid: HEAD_SHA } }] },
    latestOpinionatedReviews: { nodes: [] },
  } } } }), err: '' }));
  assert.equal((await github.prReviewSnapshots([{ repo: 'Acme/repo', number: 7 }])).get('Acme/repo#7')?.reviewDecision, 'REVIEW_REQUIRED');
});

function workflowNode(number: number) {
  return { ...myPrNode(number), author: { login: 'alice' }, labels: { nodes: [{ name: 'bug' }] }, comments: { totalCount: 2 } };
}

test('repo PR search asks one GraphQL call for open and recently merged pull requests with the workflow fields', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify({ data: { open: { issueCount: 1, nodes: [workflowNode(1)] }, merged: { issueCount: 1, nodes: [workflowNode(3)] } } }), err: '' };
  });
  const searched = await gh.searchRepoPrs('Acme/app', '2026-09-27');
  assert.deepEqual({ ok: searched.ok, isComplete: searched.isComplete, numbers: searched.items.map((item) => item.number) }, { ok: true, isComplete: true, numbers: [1, 3] });
  assert.equal(searched.items[0]?.author?.login, 'alice');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('openQuery=is:pr is:open repo:Acme/app sort:updated-desc'));
  assert.ok(calls[0].includes('mergedQuery=is:pr is:merged repo:Acme/app merged:>=2026-09-27 sort:updated-desc'));
  const query = calls[0].find((argument) => argument.startsWith('query=')) ?? '';
  assert.match(query, /nodes \{ \.\.\.myPrFields \.\.\.workflowPrFields \}/);
  assert.match(query, /fragment workflowPrFields on PullRequest \{\n\s+author \{ login \} labels\(first: 50\) \{ nodes \{ name \} \} comments \{ totalCount \}/);
  assert.match(query, /fragment myPrFields on PullRequest \{/);
});

test('repo PR search reports itself incomplete when a cap truncates it or a node is malformed', async () => {
  const truncated = createPrGh('/repo', async () => ({ ok: true, out: JSON.stringify({ data: { open: { issueCount: 80, nodes: [workflowNode(1)] }, merged: { issueCount: 0, nodes: [] } } }), err: '' }));
  assert.equal((await truncated.searchRepoPrs('Acme/app', '2026-09-27')).isComplete, false);
  const malformed = createPrGh('/repo', async () => ({ ok: true, out: JSON.stringify({ data: { open: { issueCount: 2, nodes: [workflowNode(1), myPrNode(2)] }, merged: { issueCount: 0, nodes: [] } } }), err: '' }));
  const searched = await malformed.searchRepoPrs('Acme/app', '2026-09-27');
  assert.deepEqual([searched.ok, searched.isComplete, searched.items.length], [true, false, 1]);
});

test('repo PR search refuses bad input without calling gh and fails closed on bad responses', async () => {
  let calls = 0;
  const gh = createPrGh('/repo', async () => {
    calls += 1;
    return { ok: true, out: JSON.stringify({ data: { open: { issueCount: 0, nodes: [] }, merged: { issueCount: 0, nodes: [] } }, errors: [{ message: 'x' }] }), err: '' };
  });
  assert.equal((await gh.searchRepoPrs('Acme', '2026-09-27')).ok, false);
  assert.equal((await gh.searchRepoPrs('Acme/app repo:Other/secret', '2026-09-27')).ok, false);
  assert.equal((await gh.searchRepoPrs('Acme/app', 'today')).ok, false);
  assert.equal(calls, 0);
  assert.deepEqual(await gh.searchRepoPrs('Acme/app', '2026-09-27'), { ok: false, items: [], isComplete: false, error: 'gh graphql returned errors' });
  const failed = createPrGh('/repo', async () => ({ ok: false, out: '', err: 'rate limited\n' }));
  assert.equal((await failed.searchRepoPrs('Acme/app', '2026-09-27')).error, 'rate limited');
});

test('addPrLabel runs gh pr edit with the label as one argument after its flag', async () => {
  const calls: { args: string[]; input: string | undefined }[] = [];
  const gh = createPrGh('/repo', async (_command, args, _cwd, input) => {
    calls.push({ args, input });
    return { ok: true, out: '', err: '' };
  });
  assert.deepEqual(await gh.addPrLabel({ repo: 'Acme/app', number: 7, name: 'needs review' }), { ok: true, err: '' });
  assert.deepEqual(calls, [{ args: ['pr', 'edit', '7', '--repo', 'Acme/app', '--add-label', 'needs review'], input: undefined }]);
});

test('commentOnPr passes the body on stdin through --body-file, never as an argument', async () => {
  const calls: { args: string[]; input: string | undefined }[] = [];
  const gh = createPrGh('/repo', async (_command, args, _cwd, input) => {
    calls.push({ args, input });
    return { ok: true, out: '', err: '' };
  });
  const body = '--repo Other/secret\nThanks for the fix';
  assert.deepEqual(await gh.commentOnPr({ repo: 'Acme/app', number: 7, body }), { ok: true, err: '' });
  assert.deepEqual(calls, [{ args: ['pr', 'comment', '7', '--repo', 'Acme/app', '--body-file', '-'], input: body }]);
});

test('label and comment helpers refuse bad input without calling gh and report gh failures', async () => {
  let calls = 0;
  const gh = createPrGh('/repo', async () => {
    calls += 1;
    return { ok: false, out: '', err: 'HTTP 403\n' };
  });
  assert.equal((await gh.addPrLabel({ repo: 'Acme', number: 7, name: 'bug' })).ok, false);
  assert.equal((await gh.addPrLabel({ repo: 'Acme/app', number: 0, name: 'bug' })).ok, false);
  assert.equal((await gh.addPrLabel({ repo: 'Acme/app', number: 7, name: '--remove-label' })).ok, false);
  assert.equal((await gh.addPrLabel({ repo: 'Acme/app', number: 7, name: 'bug,urgent' })).ok, false);
  assert.equal((await gh.commentOnPr({ repo: 'Acme/app', number: 1.5, body: 'hi' })).ok, false);
  assert.equal((await gh.commentOnPr({ repo: 'Acme/app', number: 7, body: '  ' })).ok, false);
  assert.equal(calls, 0);
  assert.deepEqual(await gh.addPrLabel({ repo: 'Acme/app', number: 7, name: 'bug' }), { ok: false, err: 'HTTP 403' });
  assert.deepEqual(await gh.commentOnPr({ repo: 'Acme/app', number: 7, body: 'hi' }), { ok: false, err: 'HTTP 403' });
  assert.equal(calls, 2);
});

test('team thread batches request Markdown, viewer ownership, resolve permission and original commits', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify({ data: { pr0: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [threadNode()] } } } } }), err: '' };
  });
  assert.equal((await gh.teamReviewThreads([{ repo: 'Acme/app', number: 1 }])).get('Acme/app#1')?.[0].id, 'PRRT_acme_1');
  const query = calls[0].join(' ');
  for (const field of ['viewerCanResolve', 'viewerDidAuthor', 'body author', 'originalCommit { oid }', 'id path line isResolved']) assert.ok(query.includes(field));
  assert.ok(!query.includes('bodyText'));
});

test('thread resolution validates ids and requires a confirmed mutation result without GraphQL errors', async () => {
  const calls: string[][] = [];
  let isError = false;
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'PRRT_acme_1', isResolved: true } } }, ...(isError ? { errors: [{ message: 'denied' }] } : {}) }), err: '' };
  });
  assert.equal((await gh.resolveReviewThread('bad id')).ok, false);
  assert.equal(calls.length, 0);
  assert.equal((await gh.resolveReviewThread('PRRT_acme_1')).ok, true);
  assert.ok(calls[0].includes('id=PRRT_acme_1'));
  assert.match(calls[0].join(' '), /resolveReviewThread\(input: \{ threadId: \$id \}\)/);
  isError = true;
  assert.equal((await gh.resolveReviewThread('PRRT_acme_1')).ok, false);
});

test('team comparison fetches changed file patches through the validated compare endpoint', async () => {
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    return { ok: true, out: JSON.stringify({ merge_base_commit: { sha: 'b'.repeat(40) }, files: [{ filename: 'src/app.ts', patch: '+guard' }] }), err: '' };
  });
  assert.deepEqual(await gh.teamReviewCompare('Acme/app', 'b'.repeat(40), HEAD_SHA), { ok: true, comparison: { merge_base_commit: { sha: 'b'.repeat(40) }, files: [{ filename: 'src/app.ts', patch: '+guard' }] } });
  assert.deepEqual(calls[0], ['api', `repos/Acme/app/compare/${'b'.repeat(40)}...${HEAD_SHA}`]);
  assert.deepEqual(await gh.teamReviewCompare('Acme/app', 'bad', HEAD_SHA), { ok: true, comparison: null });
  assert.equal(calls.length, 1);
});

test('team thread pagination keeps the complete set and rejects a failed or partial GraphQL response', async () => {
  const calls: string[][] = [];
  const first = threadNode();
  const second = threadNode('LOW', { id: 'PRRT_acme_2' });
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    if (calls.length === 1) return { ok: true, out: JSON.stringify({ data: { pr0: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: 'next' }, nodes: [first] } } } } }), err: '' };
    return { ok: true, out: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [second] } } } } }), err: '' };
  });
  assert.equal((await gh.teamReviewThreads([{ repo: 'Acme/app', number: 1 }])).get('Acme/app#1')?.length, 2);
  assert.ok(calls[1].includes('cursor=next'));
  for (const isFailed of [true, false]) {
    const rejected = createPrGh('/repo', async () => ({ ok: !isFailed, out: JSON.stringify({ data: { pr0: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [first] } } } }, errors: [{ message: 'incomplete' }] }), err: '' }));
    assert.equal((await rejected.teamReviewThreads([{ repo: 'Acme/app', number: 1 }])).size, 0);
  }
});

test('team thread comment pagination includes the actual latest reply before classification', async () => {
  const node = threadNode();
  node.comments.nodes.pop();
  node.comments.pageInfo = { hasNextPage: true, endCursor: 'comment-next' };
  const calls: string[][] = [];
  const gh = createPrGh('/repo', async (_command, args) => {
    calls.push(args);
    if (calls.length === 1) return { ok: true, out: JSON.stringify({ data: { pr0: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [node] } } } } }), err: '' };
    return { ok: true, out: JSON.stringify({ data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [threadNode().comments.nodes[1]] } } } }), err: '' };
  });
  const threads = (await gh.teamReviewThreads([{ repo: 'Acme/app', number: 1 }])).get('Acme/app#1');
  assert.equal(threads?.[0].comments.nodes.length, 2);
  assert.equal(threads?.[0].comments.pageInfo.hasNextPage, false);
  assert.ok(calls[1].includes('id=PRRT_acme_1'));
  assert.ok(calls[1].includes('cursor=comment-next'));
});

test('incomplete viewer comment pages omit the PR so saved attempts survive a failed refresh', async () => {
  for (const hasCursor of [true, false]) {
    const node = threadNode('LOW');
    node.comments.pageInfo = { hasNextPage: true, endCursor: hasCursor ? 'next' : null };
    let calls = 0;
    const github = createPrGh('/repo', async () => {
      calls += 1;
      if (calls > 1) return { ok: false, out: '', err: 'Unavailable' };
      return { ok: true, out: JSON.stringify({ data: { pr0: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [node] } } } } }), err: '' };
    });
    assert.equal((await github.teamReviewThreads([{ repo: 'Acme/app', number: 1 }])).size, 0);
    assert.equal(calls, hasCursor ? 2 : 1);
  }
});

test('thread comparison rejects a force-pushed base and preserves renamed file paths', async () => {
  const base = 'b'.repeat(40);
  let mergeBase = 'c'.repeat(40);
  const files = [{ filename: 'src/renamed.ts', previous_filename: 'src/app.ts', patch: '+guard' }];
  const github = createPrGh('/repo', async () => ({ ok: true, out: JSON.stringify({ merge_base_commit: { sha: mergeBase }, files }), err: '' }));
  assert.deepEqual(await github.teamReviewCompare('Acme/app', base, HEAD_SHA), { ok: true, comparison: null });
  mergeBase = base;
  assert.deepEqual(await github.teamReviewCompare('Acme/app', base, HEAD_SHA), { ok: true, comparison: { merge_base_commit: { sha: base }, files } });
});

test('thread comparison reports a failed or unreadable gh call as transient rather than rewritten history', async () => {
  const base = 'b'.repeat(40);
  const failing = createPrGh('/repo', async () => ({ ok: false, out: '', err: 'HTTP 403: API rate limit exceeded' }));
  assert.deepEqual(await failing.teamReviewCompare('Acme/app', base, HEAD_SHA), { ok: false, err: 'HTTP 403: API rate limit exceeded' });
  const throwing = createPrGh('/repo', async () => { throw new Error('network down'); });
  assert.deepEqual(await throwing.teamReviewCompare('Acme/app', base, HEAD_SHA), { ok: false, err: 'network down' });
  const unreadable = createPrGh('/repo', async () => ({ ok: true, out: 'not json', err: '' }));
  assert.equal((await unreadable.teamReviewCompare('Acme/app', base, HEAD_SHA)).ok, false);
});

test('a GraphQL error on one PR alias drops only that PR and keeps the rest of the batch', async () => {
  for (const isExitOk of [true, false]) {
    const repository = { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [threadNode()] } } };
    const gh = createPrGh('/repo', async () => ({
      ok: isExitOk,
      out: JSON.stringify({ data: { pr0: repository, pr1: repository, pr2: null }, errors: [{ message: 'timeout', path: ['pr1', 'pullRequest', 'reviewThreads'] }, { message: 'not found', path: ['pr2'] }] }),
      err: '',
    }));
    const threads = await gh.teamReviewThreads([{ repo: 'Acme/app', number: 1 }, { repo: 'Acme/app', number: 2 }, { repo: 'Acme/app', number: 3 }]);
    assert.deepEqual([...threads.keys()], ['Acme/app#1'], `exit ok: ${isExitOk}`);
  }
});
