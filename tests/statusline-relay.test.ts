import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { main, NO_CHAIN } from '../session/statusline-relay.ts';
function fakeStdin(text: string) {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

function fakeStdout() {
  const written: string[] = [];
  return { written, write: (chunk: string) => { written.push(String(chunk)); return true; } };
}

const PAYLOAD = {
  session_id: 'c1',
  model: { id: 'claude-opus-4-5', display_name: 'Opus 4.5' },
  cost: { total_cost_usd: 1.234 },
};

test('with nothing to chain and no server listening, the fallback line is still printed', async () => {
  const stdout = fakeStdout();
  const code = await main(['http://127.0.0.1:1/hook/x/statusline?t=t', NO_CHAIN], fakeStdin(JSON.stringify(PAYLOAD)), stdout);
  assert.equal(code, 0);
  assert.equal(stdout.written.join(''), 'Opus 4.5  $1.23\n');
});

test('a chained command runs, receives the payload on stdin, and its exit code is passed through', async () => {
  const stdout = fakeStdout();

  const chain = Buffer.from(
    `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write('CHAINED:'+JSON.parse(d).session_id)})"`,
    'utf8',
  ).toString('base64');
  const code = await main(['http://127.0.0.1:1/hook/x/statusline?t=t', chain], fakeStdin(JSON.stringify(PAYLOAD)), stdout);
  assert.equal(code, 0);
});

test('a chained command that fails does not take the relay down', async () => {
  const stdout = fakeStdout();
  const chain = Buffer.from('node -e "process.exit(3)"', 'utf8').toString('base64');
  const code = await main(['http://127.0.0.1:1/hook/x/statusline?t=t', chain], fakeStdin('{}'), stdout);
  assert.equal(code, 3, 'the chained command owns the exit code');
});

test('the POST reaches a listening local server with the raw body intact', async () => {
  const received: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/sess/statusline?t=tok`;
  const raw = JSON.stringify(PAYLOAD);
  await main([url, NO_CHAIN], fakeStdin(raw), fakeStdout());
  await new Promise<void>((resolve) => { server.close(() => resolve()); });

  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].url, '/hook/sess/statusline?t=tok');

  assert.equal(received[0].body, raw);
});
