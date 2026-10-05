import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';

import {
  COMMAND_HOOK_RELAY_PATH,
  DEFAULT_TIMEOUT_SEC,
  HOOK_EVENTS,
  buildHookSettings,
} from '../detection/settings-injector.ts';
import { main } from '../session/command-hook-relay.ts';
import { MAX_RESPONSE_BYTES } from '../session/core/hook-relay-core.ts';
import { postPayload } from '../session/loopback-post.ts';

test('SessionStart is command-only while every other built-in event stays http', () => {
  const settings = buildHookSettings({ port: 4321, glimmervoidId: 'sess-1', token: 'tok-abc' });
  const [sessionStart] = settings.hooks.SessionStart[0].hooks;
  assert.deepEqual(Object.keys(sessionStart).sort(), ['command', 'timeout', 'type']);
  assert.equal(sessionStart.type, 'command');
  assert.equal(sessionStart.timeout, DEFAULT_TIMEOUT_SEC);
  assert.match(String(sessionStart.command), /^node /);
  assert.match(String(sessionStart.command), /command-hook-relay\.ts/);
  assert.match(String(sessionStart.command), /\/hook\/sess-1\/sessionstart\?t=tok-abc/);

  for (const event of HOOK_EVENTS) {
    if (event === 'SessionStart') continue;
    const handlers = settings.hooks[event].flatMap((entry) => entry.hooks);
    assert.deepEqual(handlers.map((handler) => handler.type), ['http'], event);
  }
});

test('the command relay path resolves to a source asset', () => {
  assert.ok(fs.existsSync(COMMAND_HOOK_RELAY_PATH), `${COMMAND_HOOK_RELAY_PATH} exists`);
});

test('the command relay posts stdin unchanged with the settings bearer token', async () => {
  const received: { url: string | undefined; body: string }[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push({ url: request.url, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as AddressInfo).port;
  const raw = JSON.stringify({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'vendor-1' });
  try {
    const code = await main(
      [`http://127.0.0.1:${port}/hook/sess-1/sessionstart?t=tok-abc`],
      Readable.from([Buffer.from(raw, 'utf8')]),
    );
    assert.equal(code, 0);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
  assert.deepEqual(received, [{ url: '/hook/sess-1/sessionstart?t=tok-abc', body: raw }]);
});

const hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: 'Current task: "Fix relay".' };

for (const { name, responseBody, expectedOutput } of [
  { name: 'SessionStart context', responseBody: JSON.stringify({ ok: true, hookSpecificOutput }), expectedOutput: JSON.stringify({ hookSpecificOutput }) },
  { name: 'plain acknowledgement', responseBody: '{"ok":true}', expectedOutput: '' },
  { name: 'malformed JSON', responseBody: '{invalid', expectedOutput: '' },
  { name: 'oversized context', responseBody: JSON.stringify({ hookSpecificOutput: { ...hookSpecificOutput, additionalContext: 'x'.repeat(MAX_RESPONSE_BYTES) } }), expectedOutput: '' },
]) {
  test(`command relay outputs only validated context for ${name}`, async () => {
    const server = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => response.end(responseBody));
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as AddressInfo).port;
    const written: string[] = [];
    try {
      const code = await main(
        [`http://127.0.0.1:${port}/hook/sess-1/sessionstart`],
        Readable.from([Buffer.from('{"source":"compact"}')]),
        { write: (text) => { written.push(text); } },
      );
      assert.equal(code, 0);
      assert.equal(written.join(''), expectedOutput);
      const postedResponse = await postPayload(`http://127.0.0.1:${port}/hook/sess-1/sessionstart`, Buffer.from('{}'));
      assert.equal(postedResponse, name === 'oversized context' ? null : responseBody);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });
}
