import assert from 'node:assert';
import { test } from 'node:test';
import { LOOPBACK_HOSTS, isLoopbackHostname } from '../shared/loopback-hosts.ts';

test('isLoopbackHostname admits exactly the four loopback spellings a URL hostname can carry', () => {
  assert.deepEqual([...LOOPBACK_HOSTS].sort(), ['127.0.0.1', '::1', '[::1]', 'localhost']);
  assert.equal(isLoopbackHostname(new URL('http://127.0.0.1:3000/hook').hostname), true);
  assert.equal(isLoopbackHostname(new URL('http://[::1]:3000/hook').hostname), true);
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('127.0.0.2'), false);
  assert.equal(isLoopbackHostname('0.0.0.0'), false);
  assert.equal(isLoopbackHostname('localhost.localdomain'), false);
  assert.equal(isLoopbackHostname(''), false);
});
