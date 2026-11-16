import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameReader, encodeFrame, modelTokenFrom, verdictFor } from '../server/sandbox/core/credential-decider-core.ts';
import type { ProxyFrame } from '../server/sandbox/core/credential-decider-core.ts';

const tokens = { agent: 'codex', modelToken: 'model-secret', githubToken: 'github-secret' };

function requestTo(host: string) {
  return { t: 'req' as const, id: 7, method: 'GET', host, port: 443, path: '/' };
}

test('the decider places only the login matching the host and the session agent', () => {
  assert.deepEqual(verdictFor(requestTo('chatgpt.com'), tokens), { t: 'verdict', id: 7, action: 'allow', cred: 'codex', credential: 'model-secret' });
  assert.deepEqual(verdictFor(requestTo('github.com'), tokens), { t: 'verdict', id: 7, action: 'allow', cred: 'github', credential: 'github-secret' });
  assert.deepEqual(verdictFor(requestTo('api.github.com'), tokens), { t: 'verdict', id: 7, action: 'allow', cred: 'api', credential: 'github-secret' });
  assert.deepEqual(verdictFor(requestTo('api.anthropic.com'), tokens), { t: 'verdict', id: 7, action: 'allow' });
  assert.deepEqual(verdictFor(requestTo('github.com'), { ...tokens, githubToken: null }), { t: 'verdict', id: 7, action: 'allow' });
});

test('the frame reader reassembles split frames and breaks on an oversized one', () => {
  const frames: ProxyFrame[] = [];
  const violations: string[] = [];
  const read = createFrameReader((frame) => frames.push(frame), (reason) => violations.push(reason));
  const wire = Buffer.concat([encodeFrame({ t: 'hello', proto: 1 }), encodeFrame(requestTo('github.com'))]);
  for (let offset = 0; offset < wire.length; offset += 5) read(wire.subarray(offset, offset + 5));
  assert.deepEqual(frames.map((frame) => frame.t), ['hello', 'req']);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(2 * 1024 * 1024);
  read(oversized);
  read(encodeFrame({ t: 'hello', proto: 1 }));
  assert.equal(violations.length, 1);
  assert.equal(frames.length, 2);
});

test('each agent login file yields its access token', () => {
  assert.equal(modelTokenFrom('claude-code', JSON.stringify({ claudeAiOauth: { accessToken: 'claude-access' } })), 'claude-access');
  assert.equal(modelTokenFrom('codex', JSON.stringify({ tokens: { access_token: 'codex-access' } })), 'codex-access');
  assert.equal(modelTokenFrom('kimi', JSON.stringify({ access_token: 'kimi-access' })), 'kimi-access');
  assert.equal(modelTokenFrom('opencode', JSON.stringify({ access_token: 'unused' })), null);
  assert.equal(modelTokenFrom('codex', 'not json'), null);
});
