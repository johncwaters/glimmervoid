import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNT_TEXT,
  CARET_ICON_PATH,
  CLOSE_TEXT,
  FLAG_ICON_PATH,
  INITIAL_AGENT_CARDS_STATE,
  MENU_TEXT,
  PICK_AGENT_TEXT,
  RESTART_TEXT,
  cardDisplayOf,
  closeCardMenu,
  faceAriaLabelOf,
  faceClassNamesOf,
  isBusyPhase,
  isShrunk,
  parseChatCardAnswer,
  pruneAgentCardsState,
  resolvePaintedCards,
  setCardRefusal,
  shouldCloseMenuOnEscape,
  shrunkAriaLabelOf,
  toggleCardMenu,
  updateCardSize,
} from '../public/board-session/agent-card-core.ts';
import type { AgentCardCoreModel } from '../public/board-session/agent-card-core.ts';
import {
  FACE_SIZE_PX,
  UNPLACED_MAIN_LEFT_PX,
  UNPLACED_MAIN_TOP_PX,
  computeCardLayouts,
  screenRectOf,
  wirePathOf,
} from '../public/board-session/agent-card-place-core.ts';
import { classifyWaitsOutgoingMessage } from '../public/board-session/agent-waits-core.ts';

function sampleCard(overrides: Partial<AgentCardCoreModel> = {}): AgentCardCoreModel {
  return {
    sessionId: 'sess-1',
    name: 'Branch A',
    agentId: 'claude-code',
    isMain: false,
    repoLabel: null,
    isBranch: true,
    boxIds: ['box-1'],
    phase: 'quiet',
    beat: null,
    digest: null,
    misfit: null,
    failure: null,
    canPickAgent: false,
    isAsking: false,
    isOpened: false,
    ...overrides,
  };
}

test('agent-card-core shrinks idle closed branches and keeps busy, asking, failed, or main cards expanded', () => {
  assert.equal(isBusyPhase('working'), true);
  assert.equal(isBusyPhase('starting'), true);
  assert.equal(isBusyPhase('monitoring'), true);
  assert.equal(isBusyPhase('quiet'), false);

  assert.equal(isShrunk(sampleCard()), true);
  assert.equal(isShrunk(sampleCard({ isOpened: true })), false);
  assert.equal(isShrunk(sampleCard({ phase: 'working' })), false);
  assert.equal(isShrunk(sampleCard({ isAsking: true })), false);
  assert.equal(isShrunk(sampleCard({ failure: 'stopped' })), false);
  assert.equal(isShrunk(sampleCard({ isBranch: false, isMain: true })), false);
});

test('agent-card-core resolves painted cards, display flags, menu transitions, refusal state, and pruning', () => {
  const mainCard = sampleCard({ sessionId: 'main', name: 'Orchestrator', isMain: true, isBranch: false, repoLabel: 'Orchestrator', boxIds: [], canPickAgent: true });
  const placedBranch = sampleCard({ sessionId: 'b1', boxIds: ['missing', 'box-1'] });
  const unplacedBranch = sampleCard({ sessionId: 'b2', boxIds: ['missing'] });
  const bounds = new Map([['box-1', { x: 100, y: 120, width: 160, height: 80 }]]);

  const painted = resolvePaintedCards([mainCard, placedBranch, unplacedBranch], (id) => bounds.get(id) ?? null);
  assert.deepEqual(painted.map((entry) => entry.sessionId), ['main', 'b1']);
  assert.equal(painted[0]?.boxRect, null);
  assert.equal(painted[0]?.isWireHidden, true);
  assert.equal(painted[1]?.isCardShrunk, true);
  assert.equal(painted[1]?.isWireHidden, true);

  const flags = cardDisplayOf(mainCard, false, null);
  assert.equal(flags.isNameHidden, true);
  assert.equal(flags.isRepoButtonHidden, false);
  assert.equal(flags.isMoreButtonHidden, true);
  assert.equal(flags.isCloseItemHidden, true);
  assert.equal(flags.isPickAgentHidden, false);
  assert.equal(faceClassNamesOf(mainCard), 'bs-face bs-face-main');
  assert.equal(faceAriaLabelOf('Orchestrator'), 'Message Orchestrator');
  assert.equal(shrunkAriaLabelOf('Branch A'), 'Open Branch A');
  assert.equal(shouldCloseMenuOnEscape('Escape', true), true);
  assert.equal(shouldCloseMenuOnEscape('Escape', false), false);
  assert.deepEqual(parseChatCardAnswer('c1', 'decide', 'allow'), { cardId: 'c1', action: 'decide', value: 'allow' });
  assert.equal(parseChatCardAnswer(null, 'decide', 'allow'), null);
  assert.ok([MENU_TEXT, RESTART_TEXT, ACCOUNT_TEXT, CLOSE_TEXT, PICK_AGENT_TEXT, CARET_ICON_PATH, FLAG_ICON_PATH].every((label) => label.length > 0));

  let state = INITIAL_AGENT_CARDS_STATE;
  state = toggleCardMenu(state, 'b1');
  assert.equal(state.openMenuSessionId, 'b1');
  state = closeCardMenu(state, 'other');
  assert.equal(state.openMenuSessionId, 'b1');
  state = setCardRefusal(state, 'b1', 'Unlanded changes');
  assert.equal(state.refusalBySessionId.b1, 'Unlanded changes');
  state = updateCardSize(state, 'b1', { width: 250, height: 120 });
  assert.deepEqual(state.cardSizeBySessionId.b1, { width: 250, height: 120 });
  state = pruneAgentCardsState(state, new Set(['main']));
  assert.equal(state.openMenuSessionId, null);
  assert.equal(state.refusalBySessionId.b1, undefined);
  assert.equal(state.cardSizeBySessionId.b1, undefined);
});

test('agent-card-place-core computes cached layouts, invalidates on revision or obstacle, and builds wires', () => {
  const box = { x: 200, y: 200, width: 140, height: 60 };
  const camera = { x: 0, y: 0, scale: 1 };
  assert.deepEqual(screenRectOf(box, { x: 10, y: 20, scale: 2 }), { x: 380, y: 360, width: 280, height: 120 });
  assert.ok(wirePathOf(box, { x: 400, y: 200, width: 250, height: 100 }, 'right').startsWith('M340 230'));
  assert.ok(wirePathOf(box, { x: 200, y: 310, width: 250, height: 100 }, 'below').startsWith('M270 260'));

  const first = computeCardLayouts({
    cards: [
      { sessionId: 'main', boxRect: null, isCardShrunk: false },
      { sessionId: 'b1', boxRect: box, isCardShrunk: false },
      { sessionId: 'b2', boxRect: box, isCardShrunk: true },
    ],
    placementBySessionId: {},
    cardSizeBySessionId: { b1: { width: 250, height: 100 } },
    mapBounds: [box],
    mapBoundsRevision: 1,
    viewSize: { width: 1280, height: 800 },
    camera,
    fixedAreas: [],
  });

  assert.equal(first.layoutsBySessionId.main?.cardTransform, `translate(${UNPLACED_MAIN_LEFT_PX}px, ${UNPLACED_MAIN_TOP_PX}px)`);
  assert.equal(first.layoutsBySessionId.b2?.shrunkTransform, `translate(${box.x + box.width - FACE_SIZE_PX / 2}px, ${box.y - FACE_SIZE_PX / 2}px)`);
  assert.ok(first.layoutsBySessionId.b1?.cardTransform?.startsWith('translate('));
  assert.ok(first.layoutsBySessionId.b1?.wirePath?.startsWith('M'));

  const second = computeCardLayouts({
    cards: [{ sessionId: 'b1', boxRect: box, isCardShrunk: false }],
    placementBySessionId: first.nextPlacementBySessionId,
    cardSizeBySessionId: { b1: { width: 250, height: 100 } },
    mapBounds: [box],
    mapBoundsRevision: 1,
    viewSize: { width: 1280, height: 800 },
    camera: { x: 50, y: 25, scale: 1 },
    fixedAreas: [],
  });
  assert.equal(second.nextPlacementBySessionId.b1, first.nextPlacementBySessionId.b1);
});

test('agent-waits-core classifies valid wire actions and rejects invalid payloads', () => {
  assert.deepEqual(
    classifyWaitsOutgoingMessage({ type: 'decide-approval', id: 's1', approvalRequestId: 'r1', decision: 'allow' }),
    { kind: 'decide-approval', input: { id: 's1', approvalRequestId: 'r1', decision: 'allow' } },
  );
  assert.deepEqual(
    classifyWaitsOutgoingMessage({ type: 'answer-approval', id: 's1', approvalRequestId: 'r1', answers: { Q: 'A' } }),
    { kind: 'answer-approval', input: { id: 's1', approvalRequestId: 'r1', answers: { Q: 'A' } } },
  );
  assert.deepEqual(
    classifyWaitsOutgoingMessage({ type: 'plan-decision', id: 's1', decision: 'approve', feedback: 'looks good' }),
    { kind: 'plan-decision', input: { id: 's1', decision: 'approve', feedback: 'looks good' } },
  );
  assert.equal(classifyWaitsOutgoingMessage({ type: 'unknown', id: 's1' }), null);
  assert.equal(classifyWaitsOutgoingMessage({ type: 'decide-approval', id: '', approvalRequestId: 'r1', decision: 'allow' }), null);
});
