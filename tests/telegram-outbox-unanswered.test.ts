import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTelegramOutbox } from '../notifications/telegram-outbox.ts';
import { sendTelegramMessage } from '../server/telegram-transport.ts';

const SEND_TIMEOUT_MS = 100;
const RETRY_INTERVAL_MS = 50;
const SLOW_ANSWER_MS = 400;

function outboxSendingTo(apiBaseUrl: string) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-outbox-'));
  return createTelegramOutbox({
    filePath: path.join(folder, 'telegram-outbox.json'),
    retryIntervalMs: RETRY_INTERVAL_MS,
    warn: () => {},
    send: (entry) => sendTelegramMessage({ botToken: 'token', chatId: 'chat', text: entry.text, apiBaseUrl, timeoutMs: SEND_TIMEOUT_MS }),
  });
}

function waitMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, delayMs); });
}

test('a ping Telegram received but answered late is sent once, not again on every retry', async (context) => {
  let receivedRequestCount = 0;
  const slowTelegram = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      receivedRequestCount += 1;
      setTimeout(() => { response.end('{"ok":true}'); }, SLOW_ANSWER_MS);
    });
  });
  await new Promise<void>((resolve) => { slowTelegram.listen(0, '127.0.0.1', resolve); });
  context.after(() => { slowTelegram.closeAllConnections(); slowTelegram.close(); });
  const { port } = slowTelegram.address() as AddressInfo;
  const outbox = outboxSendingTo(`http://127.0.0.1:${port}`);

  await outbox.deliver('fixer needs attention');
  await waitMs(SEND_TIMEOUT_MS + RETRY_INTERVAL_MS * 6);
  await outbox.idle();

  assert.equal(receivedRequestCount, 1);
  assert.deepEqual(outbox.pending(), []);
});

test('a ping that never reached Telegram stays queued for the retry', async () => {
  const closedPortServer = http.createServer();
  await new Promise<void>((resolve) => { closedPortServer.listen(0, '127.0.0.1', resolve); });
  const { port } = closedPortServer.address() as AddressInfo;
  await new Promise<void>((resolve) => { closedPortServer.close(() => resolve()); });
  const outbox = outboxSendingTo(`http://127.0.0.1:${port}`);

  await outbox.deliver('fixer needs attention');
  await outbox.idle();

  assert.equal(outbox.pending().length, 1);
});
