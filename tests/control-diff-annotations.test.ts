import test from 'node:test';
import assert from 'node:assert/strict';

import type { GlimmervoidConfig } from '../server/config-store.ts';
import type { Session } from '../session/sessions.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import { plainSession } from './helpers/fake-session.ts';

interface AnnotationsFrame {
  type: string;
  requestId?: string | null;
  ok?: boolean;
  error?: string | null;
  pending?: boolean;
}

const NOTES = [
  { section: 'committed' as const, path: 'server/index.ts', line: 12, side: 'new' as const, note: 'this leaks the timer' },
  { section: 'uncommitted' as const, path: 'public/app.ts', line: 4, side: 'old' as const, note: 'dead branch' },
];

function harness({ paste = { ok: true, deferred: false } }: { paste?: { ok: boolean; deferred?: boolean; reason?: string } } = {}) {
  const config: GlimmervoidConfig = { projects: [{ id: 'p1', name: 'socket', path: '/repo/socket' }] };
  const sessions = new Map<string, Session>();
  const pastes: string[] = [];
  const session = plainSession('p1', 'socket');
  session.pasteTextWhenReady = (text: string) => {
    pastes.push(text);
    return paste;
  };
  sessions.set('p1', session);

  const server = createControlServer(controlDeps(config, { sessions }));
  const connection = connectControl<AnnotationsFrame>(server);
  connection.sent.length = 0;
  return { ...connection, pastes };
}

test('send-diff-annotations pastes one message carrying every sorted note', async () => {
  const h = harness();

  await h.send({ type: 'send-diff-annotations', requestId: 'r1', id: 'p1', annotations: NOTES });

  assert.equal(h.sent[0].type, 'send-diff-annotations-result');
  assert.equal(h.sent[0].ok, true);
  assert.equal(h.sent[0].pending, false);
  assert.equal(h.pastes.length, 1);
  assert.equal(h.pastes[0], [
    'Operator review notes on the current worktree diff:',
    '- public/app.ts:4 (uncommitted) (removed line) dead branch',
    '- server/index.ts:12 (committed) this leaks the timer',
    'Address each note, then reply with what changed.',
  ].join('\n'));
});

test('send-diff-annotations refuses an unknown session without pasting', async () => {
  const h = harness();

  await h.send({ type: 'send-diff-annotations', requestId: 'r1', id: 'missing', annotations: NOTES });

  assert.equal(h.sent[0].type, 'send-diff-annotations-result');
  assert.equal(h.sent[0].ok, false);
  assert.equal(h.sent[0].error, 'Session not found');
  assert.deepEqual(h.pastes, []);
});

test('send-diff-annotations reports a queued paste as pending', async () => {
  const h = harness({ paste: { ok: true, deferred: true } });

  await h.send({ type: 'send-diff-annotations', requestId: 'r1', id: 'p1', annotations: NOTES });

  assert.equal(h.sent[0].ok, true);
  assert.equal(h.sent[0].pending, true);
});

test('send-diff-annotations reports the refusal reason from a session that cannot take a paste', async () => {
  const h = harness({ paste: { ok: false, reason: 'destroyed' } });

  await h.send({ type: 'send-diff-annotations', requestId: 'r1', id: 'p1', annotations: NOTES });

  assert.equal(h.sent[0].ok, false);
  assert.equal(h.sent[0].error, 'Could not write to "socket" (destroyed)');
});

test('send-diff-annotations pastes a note stripped of the bracketed paste terminator', async () => {
  const h = harness();
  const escapeCharacter = String.fromCharCode(27);

  await h.send({
    type: 'send-diff-annotations',
    requestId: 'r1',
    id: 'p1',
    annotations: [{ section: 'uncommitted', path: 'public/app.ts', line: 9, side: 'new', note: `close${escapeCharacter}[201~rm -rf /` }],
  });

  assert.equal(h.sent[0].ok, true);
  assert.equal(h.pastes.length, 1);
  assert.equal(h.pastes[0].includes(escapeCharacter), false);
  assert.equal(h.pastes[0].includes('- public/app.ts:9 (uncommitted) close [201~rm -rf /'), true);
});

test('send-diff-annotations refuses a note whose path carries a control character', async () => {
  const h = harness();
  const escapeCharacter = String.fromCharCode(27);

  await h.send({
    type: 'send-diff-annotations',
    requestId: 'r1',
    id: 'p1',
    annotations: [{ section: 'committed', path: `public/app.ts${escapeCharacter}[201~`, line: 9, side: 'new', note: 'note' }],
  });

  assert.equal(h.sent[0].ok, false);
  assert.deepEqual(h.pastes, []);
});
