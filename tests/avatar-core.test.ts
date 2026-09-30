import test from 'node:test';
import assert from 'node:assert/strict';

import { avatarUrlForLogin, monogramFor } from '../public/avatar-core.ts';

test('avatar URLs request double resolution and encode logins', () => {
  assert.equal(avatarUrlForLogin('alice', 16), 'https://avatars.githubusercontent.com/alice?s=32');
  assert.equal(avatarUrlForLogin('a/b', 20), 'https://avatars.githubusercontent.com/a%2Fb?s=40');
});

test('bot and empty logins use the monogram fallback', () => {
  assert.equal(avatarUrlForLogin('dependabot[bot]', 16), null);
  assert.equal(avatarUrlForLogin('', 16), null);
  assert.equal(monogramFor('-x1'), 'X');
  assert.equal(monogramFor(''), '?');
});
