import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createChatOutbox } from '../session/chat-outbox.ts';
import type { ChatOutboxEntry } from '../shared/contracts/session.ts';

function outboxNotingTaken(nowMs: () => number) {
  const takenNotes: { origin: ChatOutboxEntry['origin']; submittedAtMs: number }[] = [];
  const outbox = createChatOutbox({
    canTakeMessage: () => true,
    reportsTurnStarts: () => true,
    isDeliveryInFlight: () => false,
    deliver: (_entry, onSettled) => {
      onSettled('submitted');
      return { ok: true };
    },
    noteSubmitted: () => {},
    noteTaken: (entry, submittedAtMs) => { takenNotes.push({ origin: entry.origin, submittedAtMs }); },
    nowMs,
    noteNotTaken: () => {},
    emitChange: () => {},
  });
  return { outbox, takenNotes };
}

test('a board answer the agent never takes is never noted as taken, so no later prompt is hidden as its answer', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { outbox, takenNotes } = outboxNotingTaken(() => 5_000);
    outbox.queue('Answer to your board question', [], 'board-answer');
    mock.timers.tick(60_000);
    assert.deepEqual(outbox.entries().map((entry) => entry.state), ['failed']);
    assert.deepEqual(takenNotes, []);
  } finally {
    mock.timers.reset();
  }
});

test('a board answer the agent takes is noted at the time it was submitted', () => {
  let nowMs = 5_000;
  const { outbox, takenNotes } = outboxNotingTaken(() => nowMs);
  outbox.queue('Answer to your board question', [], 'board-answer');
  nowMs = 9_000;
  outbox.noteTurnTaken();
  outbox.dispose();
  assert.deepEqual(takenNotes, [{ origin: 'board-answer', submittedAtMs: 5_000 }]);
});
