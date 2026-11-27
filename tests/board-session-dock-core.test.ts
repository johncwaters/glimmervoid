import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimPendingSends,
  computeSessionTurnAttribution,
  groupMentionChoices,
  insertProgressAnswersByTime,
  shownTextOfTurn,
} from '../public/board-session/dock-core.ts';
import type { PendingSend } from '../public/board-session/dock-core.ts';

test('computeSessionTurnAttribution attributes branch news and board changes in one sweep', () => {
  const attribution = computeSessionTurnAttribution(
    [
      { id: 't1', openedAt: 100 },
      { id: 't2', openedAt: 300 },
      { id: 't3', openedAt: 500 },
    ],
    [
      { at: 90, isRelayNews: false },
      { at: 290, isRelayNews: true },
      { at: 400, isRelayNews: false },
    ],
    [
      { at: 150, boardId: 'board-1' },
      { at: 180, boardId: 'board-1' },
      { at: 350, boardId: 'board-other' },
      { at: 420, boardId: 'board-1' },
      { at: 550, boardId: 'board-1' },
    ],
    'board-1',
  );

  assert.deepEqual([...attribution.branchNewsTurnIds], ['t2']);
  assert.equal(attribution.boardChangeByTurnId.get('t1')?.at, 180);
  assert.equal(attribution.boardChangeByTurnId.has('t2'), false);
  assert.equal(attribution.boardChangeByTurnId.get('t3')?.at, 550);
});

test('shownTextOfTurn hides branch turns without chat line and relay-news turns without chat line', () => {
  const finishedTurn = {
    isOver: true,
    segments: [{ kind: 'text' as const, text: 'Final answer.' }],
  };

  assert.deepEqual(shownTextOfTurn(finishedTurn, false, 'Digest line', true), { kind: 'chat-line', text: 'Digest line' });
  assert.deepEqual(shownTextOfTurn(finishedTurn, false, null, false), { kind: 'last-reply', text: 'Final answer.' });
  assert.equal(shownTextOfTurn(finishedTurn, false, null, true), null);
  assert.equal(shownTextOfTurn(finishedTurn, true, null, false), null);
});

test('claimPendingSends matches each new server outbox entry at most once', () => {
  const pendingSends: PendingSend[] = [
    { text: 'hello', entryIdsAtDispatch: new Set(['old-1']), isClaimed: false, isAwaitingOutboxEcho: false },
    { text: 'hello', entryIdsAtDispatch: new Set(['old-1']), isClaimed: false, isAwaitingOutboxEcho: false },
  ];
  const entries = [
    { entryId: 'old-1', text: 'hello', attachments: [], state: 'held' as const, failure: null, shouldOpenTerminal: false, origin: 'operator' as const },
    { entryId: 'new-1', text: 'hello', attachments: [], state: 'held' as const, failure: null, shouldOpenTerminal: false, origin: 'operator' as const },
  ];

  claimPendingSends(pendingSends, entries);

  assert.equal(pendingSends[0]?.isClaimed, true);
  assert.equal(pendingSends[1]?.isClaimed, false);
});

test('groupMentionChoices marks group headers only at repo boundaries and insertProgressAnswersByTime orders chronologically', () => {
  const grouped = groupMentionChoices([
    { boxId: 'b1', title: 'alpha', repoName: 'repo-a' },
    { boxId: 'b2', title: 'beta', repoName: 'repo-a' },
    { boxId: 'b3', title: 'gamma', repoName: 'repo-b' },
  ]);
  assert.deepEqual(grouped.map((item) => item.showGroupLabel), [true, false, true]);

  const merged = insertProgressAnswersByTime(
    [{ id: 'p1', at: 100 }, { id: 'p2', at: 300 }],
    [{ askedAt: 200, row: { id: 'q1', at: 200 } }],
  );
  assert.deepEqual(merged.map((row) => row.id), ['p1', 'q1', 'p2']);
});
