import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_MENTION_STATE,
  MAIN_ADDRESS,
  applyPartsChanged,
  applySessionRebuilt,
  claimPendingSends,
  computeSessionTurnAttribution,
  createInitialLogState,
  createInitialQueueState,
  decideMentionKeydown,
  enqueuePendingSend,
  groupMentionChoices,
  insertProgressAnswersByTime,
  markPendingSendDispatched,
  markPendingSendOutcome,
  reconcileDockBranches,
  reconcileOutboxEcho,
  settleDockPendingSend,
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
    { id: 1, text: 'hello', entryIdsAtDispatch: new Set(['old-1']), isClaimed: false, isAwaitingOutboxEcho: false },
    { id: 2, text: 'hello', entryIdsAtDispatch: new Set(['old-1']), isClaimed: false, isAwaitingOutboxEcho: false },
  ];
  const entries = [
    { entryId: 'old-1', text: 'hello', attachments: [], state: 'held' as const, failure: null, shouldOpenTerminal: false, origin: 'operator' as const },
    { entryId: 'new-1', text: 'hello', attachments: [], state: 'held' as const, failure: null, shouldOpenTerminal: false, origin: 'operator' as const },
  ];

  const claimed = claimPendingSends(pendingSends, entries);

  assert.equal(claimed[0]?.isClaimed, true);
  assert.equal(claimed[1]?.isClaimed, false);
});

test('groupMentionChoices marks group headers only at repo boundaries and insertProgressAnswersByTime orders chronologically', () => {
  const grouped = groupMentionChoices([
    { boxId: 'b1', title: 'alpha', repoName: 'repo-a' },
    { boxId: 'b2', title: 'beta', repoName: 'repo-a' },
    { boxId: 'b3', title: 'gamma', repoName: 'repo-b' },
  ]);
  assert.deepEqual(grouped.map((item) => item.showGroupLabel), [true, false, true]);

  const merged = insertProgressAnswersByTime(
    [{ id: 'p1', at: 100 }, { id: 'null-row', at: null }, { id: 'p2', at: 300 }],
    [{ askedAt: 300, row: { id: 'q2', at: 300 } }, { askedAt: 200, row: { id: 'q1', at: 200 } }],
  );
  assert.deepEqual(merged.map((row) => row.id), ['p1', 'null-row', 'q1', 'p2', 'q2']);
});

test('applyPartsChanged compacts non-rendered replacements and counts only new live operator prompts', () => {
  const initial = createInitialLogState({ sessionId: 'main', name: 'Main', agentId: 'claude', branch: null });
  const first = applyPartsChanged(
    initial,
    'main',
    [
      { kind: 'prompt', id: 'p1', text: 'first', at: 10, attachments: [], isBoardAnswer: false },
      { kind: 'prompt', id: 'p2', text: 'board answer', at: 20, attachments: [], isBoardAnswer: true },
      { kind: 'system-line', id: 's1', label: 'relay', at: 30, isRelayNews: true },
    ],
    [],
    true,
  );
  assert.equal(first.newLivePromptCount, 1);
  assert.deepEqual(first.state.partEntries.map((entry) => entry.part.id), ['p1', 'p2']);

  const second = applyPartsChanged(
    first.state,
    'main',
    [{ kind: 'system-line', id: 'p1', label: 'replaced', at: 10, isRelayNews: false }],
    ['p2'],
    true,
  );
  assert.equal(second.newLivePromptCount, 0);
  assert.deepEqual(second.state.partEntries, []);

  const rebuilt = applySessionRebuilt(
    second.state,
    'main',
    [{ kind: 'prompt', id: 'p3', text: 'rebuilt', at: 40, attachments: [], isBoardAnswer: false }],
    [],
    [{ sessionId: 'main', askedAt: 50, question: 'status?', answer: 'working' }],
  );
  assert.equal(rebuilt.shownPromptPartIds.has('p3'), true);
  assert.equal(rebuilt.progressAnswers.length, 1);
});

test('reconcileDockBranches resets address to main when the addressed branch closes', () => {
  const initial = createInitialLogState({ sessionId: 'main', name: 'Main', agentId: 'claude', branch: null });
  const reconciled = reconcileDockBranches(
    initial,
    { kind: 'branch', sessionId: 'b1', aboutTitle: 'Box 1' },
    'main',
    new Set(['main', 'b1']),
    [{ sessionId: 'b2', name: 'Branch 2', workingDirectory: '/repo', agentId: 'claude', aboutTitle: 'Box 2' }],
  );

  assert.deepEqual(reconciled.sessionIdsToClose, ['b1']);
  assert.deepEqual(reconciled.branchesToOpen.map((branch) => branch.sessionId), ['b2']);
  assert.deepEqual(reconciled.nextAddress, MAIN_ADDRESS);
  assert.equal(reconciled.logState.speakersBySessionId.has('b1'), false);
  assert.equal(reconciled.logState.speakersBySessionId.has('b2'), true);
});

test('decideMentionKeydown distinguishes empty-backspace reset, new-branch escape, and mention wrap', () => {
  assert.deepEqual(
    decideMentionKeydown(EMPTY_MENTION_STATE, { kind: 'branch', sessionId: 'b1', aboutTitle: 'Box' }, 'Backspace', 0),
    { kind: 'address-main', preventDefault: false },
  );
  assert.deepEqual(
    decideMentionKeydown(EMPTY_MENTION_STATE, { kind: 'new-branch', aboutBoxId: 'x', aboutTitle: 'Box' }, 'Escape', 5),
    { kind: 'address-main', preventDefault: true },
  );
  const mention = {
    active: { start: 0, end: 2, query: 'a' },
    choices: [
      { boxId: 'b1', title: 'alpha', repoName: 'r' },
      { boxId: 'b2', title: 'apricot', repoName: 'r' },
    ],
    activeIndex: 0,
  };
  const stepped = decideMentionKeydown(mention, MAIN_ADDRESS, 'ArrowUp', 2);
  assert.equal(stepped.kind, 'step-mention');
  if (stepped.kind === 'step-mention') assert.equal(stepped.nextState.activeIndex, 1);
});

test('pending send stays visible until outbox echo clears awaiting state', () => {
  let state = createInitialQueueState();
  const enqueued = enqueuePendingSend(state, 'ship it');
  state = markPendingSendDispatched(enqueued.state, enqueued.pendingId, []);
  state = markPendingSendOutcome(state, enqueued.pendingId, null);
  state = settleDockPendingSend(state, enqueued.pendingId);
  assert.equal(state.pendingSends.length, 1);

  state = reconcileOutboxEcho(state, [
    { entryId: 'e1', text: 'ship it', attachments: [], state: 'held', failure: null, shouldOpenTerminal: false, origin: 'operator' },
  ]);
  assert.equal(state.pendingSends.length, 0);
});
