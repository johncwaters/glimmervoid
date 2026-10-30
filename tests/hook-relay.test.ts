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
} from '../session/core/hook-relay-core.ts';

interface IngressRequest {
  method: string | undefined;
  url: string | undefined;
  body: string;
  contentType: string | undefined;
  proxyAuthorization: string | undefined;
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
      received.push({ method: req.method, url: req.url, body, contentType: req.headers['content-type'], proxyAuthorization: req.headers['proxy-authorization'] });
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
    const refusals: [string[], Record<string, string>, string][] = [
      [['Stop'], {}, 'no-hook-url'],
      [[], { [HOOK_URL_ENV]: `http://127.0.0.1:${port}/hook/s?t=t` }, 'bad-event'],
      [['Stop'], { [HOOK_URL_ENV]: `http://127.0.0.1:${port}/upload/s?t=t` }, 'not-hook-path'],
      [['Stop'], { [HOOK_URL_ENV]: 'https://example.com/hook/s?t=t' }, 'not-http'],
      [['Stop'], { [HOOK_URL_ENV]: 'http://0.0.0.0:1/hook/s?t=t' }, 'not-loopback'],
    ];
    for (const [argv, env, expectedReason] of refusals) {
      const result = await main(argv, fakeStdin('{}'), env);
      assert.equal(result.code, 0);
      assert.equal(result.reason, expectedReason);
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
