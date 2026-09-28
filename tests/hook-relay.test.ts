import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { main } from '../session/hook-relay.ts';
import {
  HOOK_URL_ENV,
  MAX_PAYLOAD_BYTES,
  MAX_RESPONSE_BYTES,
  readHookUrl,
  normalizeEvent,
  resolveHookTarget,
  decideRelayPost,
} from '../session/core/hook-relay-core.ts';
const BASE = 'http://127.0.0.1:41234/hook/sess-1?t=deadbeef';

interface IngressRequest {
  method: string | undefined;
  url: string | undefined;
  body: string;
  contentType: string | undefined;
}

interface Ingress {
  server: http.Server;
  received: IngressRequest[];
  port: number;
}

function fakeStdin(text: string) {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

function startIngress({ status = 200, responseBody = JSON.stringify({ ok: true, reason: 'ok' }) }: {
  status?: number;
  responseBody?: string;
} = {}): Promise<Ingress> {
  const received: IngressRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body, contentType: req.headers['content-type'] });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(responseBody);
    });
  });
  return new Promise<Ingress>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: (server.address() as AddressInfo).port }));
  });
}

async function relayResponse(
  { event = 'UserPromptSubmit', status = 200, responseBody }: { event?: string; status?: number; responseBody?: string },
) {
  const { server, port } = await startIngress({ status, responseBody });
  try {
    return await main([event], fakeStdin('{}'), {
      [HOOK_URL_ENV]: `http://127.0.0.1:${port}/hook/s?t=t`,
    });
  } finally {
    server.close();
  }
}

test('readHookUrl reads only the spawn-env variable, trimmed, and nothing else', () => {
  assert.equal(HOOK_URL_ENV, 'GLIMMERVOID_HOOK_URL');
  assert.equal(readHookUrl({ [HOOK_URL_ENV]: `  ${BASE}  ` }), BASE);
  assert.equal(readHookUrl({}), null);
  assert.equal(readHookUrl({ [HOOK_URL_ENV]: '   ' }), null);
  assert.equal(readHookUrl({ [HOOK_URL_ENV]: 7 }), null);
  assert.equal(readHookUrl(null), null);
});

test('normalizeEvent lowercases the argv token and refuses anything that is not one', () => {
  assert.equal(normalizeEvent('Stop'), 'stop');
  assert.equal(normalizeEvent(' UserPromptSubmit '), 'userpromptsubmit');
  assert.equal(normalizeEvent('Pre_Tool-Use'), 'pre_tool-use');

  assert.equal(normalizeEvent('stop/../upload'), null);
  assert.equal(normalizeEvent('stop?t=x'), null);
  assert.equal(normalizeEvent('..'), null);
  assert.equal(normalizeEvent('1stop'), null);
  assert.equal(normalizeEvent(''), null);
  assert.equal(normalizeEvent(undefined), null);
});

test('resolveHookTarget appends the event segment and keeps the token query', () => {
  assert.equal(resolveHookTarget(BASE, 'stop').url, 'http://127.0.0.1:41234/hook/sess-1/stop?t=deadbeef');
  assert.equal(resolveHookTarget('http://localhost:3000/hook/s/', 'stop').url, 'http://localhost:3000/hook/s/stop');
});

test('resolveHookTarget refuses every target that is not the local hook ingress', () => {
  assert.deepEqual(resolveHookTarget('https://127.0.0.1/hook/s', 'stop'), { url: null, reason: 'not-http' });
  assert.deepEqual(resolveHookTarget('http://10.0.0.5/hook/s', 'stop'), { url: null, reason: 'not-loopback' });
  assert.deepEqual(resolveHookTarget('http://evil.example.com/hook/s', 'stop'), { url: null, reason: 'not-loopback' });
  assert.deepEqual(resolveHookTarget('http://127.0.0.1:41234/upload/s', 'stop'), { url: null, reason: 'not-hook-path' });
  assert.deepEqual(resolveHookTarget('not a url', 'stop'), { url: null, reason: 'bad-url' });
});

test('decideRelayPost: the whole verdict, refusal by refusal', () => {
  const env = { [HOOK_URL_ENV]: BASE };
  assert.deepEqual(decideRelayPost({ env, event: 'Stop', payloadBytes: 12 }), {
    post: true, url: 'http://127.0.0.1:41234/hook/sess-1/stop?t=deadbeef', reason: 'ok',
  });

  assert.deepEqual(decideRelayPost({ env: {}, event: 'Stop' }), { post: false, url: null, reason: 'no-hook-url' });
  assert.equal(decideRelayPost({ env, event: 'sto p' }).reason, 'bad-event');
  assert.equal(decideRelayPost({ env, event: 'Stop', payloadBytes: MAX_PAYLOAD_BYTES }).post, true);
  assert.equal(decideRelayPost({ env, event: 'Stop', payloadBytes: MAX_PAYLOAD_BYTES + 1 }).reason, 'payload-too-large');
  assert.equal(decideRelayPost({ env, event: 'Stop', payloadBytes: -1 }).reason, 'bad-payload');
  assert.equal(decideRelayPost({ env: { [HOOK_URL_ENV]: 'http://8.8.8.8/hook/s' }, event: 'Stop' }).reason, 'not-loopback');
  assert.equal(decideRelayPost().reason, 'no-hook-url');
});

test('an oversized response is cut off and the relay still exits 0', async () => {
  const result = await relayResponse({ responseBody: 'x'.repeat(MAX_RESPONSE_BYTES + 1) });
  assert.equal(result.code, 0);
  assert.equal(result.reason, 'response-too-large');
});

test('the relay POSTs the stdin bytes untouched to /hook/:glimmervoidId/:event', async () => {
  const { server, received, port } = await startIngress();
  try {
    const payload = '{"sessionId":"abc","backgroundTasks":[],"toolInput":{"file_path":"C:\\\\x"}}';
    const result = await main(['Stop'], fakeStdin(payload), {
      [HOOK_URL_ENV]: `http://127.0.0.1:${port}/hook/sess-42?t=tok123`,
    });
    assert.equal(result.code, 0);
    assert.equal(result.reason, 'status-200');
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/hook/sess-42/stop?t=tok123');
    assert.equal(received[0].contentType, 'application/json');
    assert.equal(received[0].body, payload);
  } finally {
    server.close();
  }
});

test('a refused target posts nothing and still exits 0', async () => {
  const { server, received, port } = await startIngress();
  try {
    const refusals: [string[], Record<string, string>][] = [
      [['Stop'], {}],
      [[], { [HOOK_URL_ENV]: `http://127.0.0.1:${port}/hook/s?t=t` }],
      [['Stop'], { [HOOK_URL_ENV]: `http://127.0.0.1:${port}/upload/s?t=t` }],
      [['Stop'], { [HOOK_URL_ENV]: 'https://example.com/hook/s?t=t' }],
    ];
    for (const [argv, env] of refusals) {
      const result = await main(argv, fakeStdin('{}'), env);
      assert.equal(result.code, 0);
    }
    assert.equal(received.length, 0);
  } finally {
    server.close();
  }
});

test('an oversize payload is dropped locally rather than cut off mid-JSON by the ingress', async () => {
  const { server, received, port } = await startIngress();
  try {
    const huge = `{"pad":"${'x'.repeat(MAX_PAYLOAD_BYTES)}"}`;
    const result = await main(['Stop'], fakeStdin(huge), { [HOOK_URL_ENV]: `http://127.0.0.1:${port}/hook/s?t=t` });
    assert.equal(result.code, 0);
    assert.equal(result.reason, 'payload-too-large');
    assert.equal(received.length, 0);
  } finally {
    server.close();
  }
});

test('nothing listening still exits 0', async () => {
  const result = await main(['Stop'], fakeStdin('{}'), { [HOOK_URL_ENV]: 'http://127.0.0.1:1/hook/s?t=t' });
  assert.equal(result.code, 0);
});
