import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravityLoginOf, antigravityPlaceholderLogin } from '../server/sandbox/core/keyring-login-core.ts';

const REAL_ACCESS_TOKEN = 'ya29.real-access-token';
const REAL_REFRESH_TOKEN = '1//real-refresh-token';
const NOW_MS = Date.parse('2026-11-23T18:00:00Z');

function keyringLoginText(authMethod: string): string {
  return JSON.stringify({ token: { access_token: REAL_ACCESS_TOKEN, token_type: 'Bearer', refresh_token: REAL_REFRESH_TOKEN, expiry: '2026-11-23T18:54:43.17-07:00', expires_in: 3599 }, auth_method: authMethod, id_token_email: 'seat@example.com' });
}

test('the Antigravity placeholder login carries neither real token and still reads as a live consumer login', () => {
  const placed = antigravityPlaceholderLogin(keyringLoginText('consumer'), NOW_MS);
  assert.ok('placeholder' in placed);
  assert.ok(!placed.placeholder.includes(REAL_ACCESS_TOKEN));
  assert.ok(!placed.placeholder.includes(REAL_REFRESH_TOKEN));
  const login = antigravityLoginOf(placed.placeholder);
  assert.equal(login?.authMethod, 'consumer');
  assert.equal(login?.email, 'seat@example.com');
  assert.ok((login?.expiresAtMs ?? 0) > NOW_MS + 300 * 24 * 60 * 60 * 1000);
});

test('an Antigravity login other than a personal Google sign-in gets no placeholder', () => {
  assert.ok('refusal' in antigravityPlaceholderLogin(keyringLoginText('gcp'), NOW_MS));
  assert.ok('refusal' in antigravityPlaceholderLogin('not json', NOW_MS));
});
