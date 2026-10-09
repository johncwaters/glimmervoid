import assert from 'node:assert';
import { test } from 'node:test';
import { GH_SEGMENT, NODE_ID_RE, REPO_SLUG_RE, repoParts } from '../shared/contracts/github-ids.ts';

test('GH_SEGMENT accepts one owner or repo segment and rejects a leading dot or dash', () => {
  assert.equal(GH_SEGMENT.test('octo-cat.v2'), true);
  assert.equal(GH_SEGMENT.test('.hidden'), false);
  assert.equal(GH_SEGMENT.test('-dash'), false);
  assert.equal(GH_SEGMENT.test('owner/repo'), false);
  assert.equal(GH_SEGMENT.test(''), false);
});

test('REPO_SLUG_RE accepts exactly owner/name', () => {
  assert.equal(REPO_SLUG_RE.test('octo/repo.js'), true);
  assert.equal(REPO_SLUG_RE.test('octo/repo/extra'), false);
  assert.equal(REPO_SLUG_RE.test('octo'), false);
  assert.equal(REPO_SLUG_RE.test('octo/-repo'), false);
});

test('NODE_ID_RE accepts GraphQL node ids and rejects anything outside the base64url alphabet', () => {
  assert.equal(NODE_ID_RE.test('PR_kwDOA1b2c3M5ZXJ0=='), true);
  assert.equal(NODE_ID_RE.test('PRR_kwDO-_x'), true);
  assert.equal(NODE_ID_RE.test(''), false);
  assert.equal(NODE_ID_RE.test('id with space'), false);
  assert.equal(NODE_ID_RE.test('id/slash'), false);
});

test('repoParts splits a valid slug and refuses anything else', () => {
  assert.deepEqual(repoParts('octo/repo'), ['octo', 'repo']);
  assert.equal(repoParts('octo'), null);
  assert.equal(repoParts('octo/repo/extra'), null);
  assert.equal(repoParts('/repo'), null);
  assert.equal(repoParts('octo/.repo'), null);
});
