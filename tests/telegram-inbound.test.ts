import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { createTelegramInbound } from '../server/telegram-inbound.ts';
import { sessionTagFor } from '../server/core/telegram-inbound-core.ts';

function replyUpdate(updateId: number, chat: { id: number; type: string }, senderId: number, text: string, repliedTo: string) {
  return { update_id: updateId, message: { chat, from: { id: senderId }, text, reply_to_message: { text: repliedTo } } };
}

test('a Telegram reply reaches only the tagged session, and only from the operator in their private chat', async () => {
  const session = new Session({ id: 'abcdef12-0000-4000-8000-000000000000', name: 'fixer', path: process.cwd(), ptySpawn: () => fakePty(), spawnCommand: { path: process.execPath, kind: 'exe' } });
  const deliveredTexts: string[] = [];
  session.deliver = (text) => { deliveredTexts.push(text); return { ok: true, kind: 'pasted' }; };
  const alert = `fixer needs attention ${sessionTagFor(session.id)}`;
  const operatorChat = { id: 42, type: 'private' };
  const groupChat = { id: 42, type: 'group' };
  const pages: unknown[][] = [[], [
    replyUpdate(10, { id: 999, type: 'private' }, 999, 'rm -rf everything', alert),
    replyUpdate(11, groupChat, 777, 'approve everything', alert),
    replyUpdate(12, groupChat, 42, 'approve from the group', alert),
    replyUpdate(13, operatorChat, 42, 'ship it', alert),
  ]];
  const offsets: number[] = [];
  const chatReplies: string[] = [];
  let finishPolling = () => {};
  const polledTwice = new Promise<void>((resolve) => { finishPolling = resolve; });
  const inbound = createTelegramInbound({
    readConfig: () => ({ botToken: 'token', chatId: '42', isAcceptingReplies: true }),
    liveSessions: () => [session],
    replyInChat: (text) => { chatReplies.push(text); },
    onLastingRefusal: () => {},
    logger: console,
    fetchUpdates: async (_token, { offset }) => {
      offsets.push(offset);
      const page = pages.shift();
      if (page) return page;
      finishPolling();
      return new Promise(() => {});
    },
  });
  inbound.start();
  await polledTwice;
  inbound.stop();
  assert.deepEqual(offsets, [-1, 0, 14]);
  assert.deepEqual(deliveredTexts, ['ship it']);
  assert.deepEqual(chatReplies, [`Sent to fixer. ${sessionTagFor(session.id)}`]);
  session.destroy();
});
