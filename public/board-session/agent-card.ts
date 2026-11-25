import type { Rect } from '#shared/whiteboard-layout-core.ts';
import { createChatActivity } from '../chat/chat-activity.ts';
import { stringDetailOf } from '../chat/chat-page.ts';
import type { ActivityBeat, ChatPhase } from '../chat/chat-activity-core.ts';
import { el } from '../dom-helpers.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { createLineIcon, createSvgShape } from '../svg-dom.ts';
import { menuButton } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import type { Camera } from '../whiteboard/board-gl-renderer.ts';
import { cardPlacementAreaOf, cardSpotOf } from './agent-card-place-core.ts';
import type { CardSide } from './agent-card-place-core.ts';
import { rectsOverlap } from '#shared/whiteboard-route-core.ts';

const FACE_SIZE_PX = 28;
const UNPLACED_MAIN_LEFT_PX = 16;
const UNPLACED_MAIN_TOP_PX = 64;
const MENU_TEXT = 'Agent menu';
const RESTART_TEXT = 'Restart';
const ACCOUNT_TEXT = 'Model and account';
const CARET_ICON_PATH = 'M4 6l4 4 4-4';
const BUSY_PHASES: ReadonlySet<ChatPhase> = new Set(['starting', 'working', 'monitoring']);

export interface AgentCardModel {
  sessionId: string;
  name: string;
  agentId: string | null;
  isMain: boolean;
  repoLabel: string | null;
  isBranch: boolean;
  boxIds: readonly string[];
  phase: ChatPhase;
  beat: ActivityBeat | null;
  digest: string | null;
  approvals: HTMLElement;
  isAsking: boolean;
  isOpened: boolean;
}

interface AgentCardActions {
  address(model: AgentCardModel): void;
  restart(sessionId: string): void;
  switchAccount(sessionId: string): void;
  toggleOpened(sessionId: string): void;
  toggleRepoMenu(card: HTMLElement, repoButton: HTMLButtonElement): void;
  answer(sessionId: string, cardId: string, action: string, value: string): void;
}

export interface AgentCards {
  element: HTMLElement;
  paint(models: readonly AgentCardModel[], boundsOf: (boxId: string) => Rect | null, mapBounds: readonly Rect[], camera: Camera, fixedAreasOf: () => readonly Rect[]): void;
  place(camera: Camera): void;
}

interface ShownCard {
  card: HTMLElement;
  shrunkFace: HTMLElement;
  wire: SVGElement;
  placement: CardPlacement | null;
  boxRect: Rect | null;
  isCardShrunk: boolean;
  cardSize: { width: number; height: number };
  setModel(model: AgentCardModel): void;
}

interface CardPlacement {
  key: string;
  offsetX: number;
  offsetY: number;
  side: CardSide;
  isClearWhenPlaced: boolean;
}

export function isBusyPhase(phase: ChatPhase): boolean {
  return BUSY_PHASES.has(phase);
}

function isShrunk(model: AgentCardModel): boolean {
  return model.isBranch && !model.isOpened && !isBusyPhase(model.phase) && !model.isAsking;
}

function faceOf(model: AgentCardModel, classNames: readonly string[]): HTMLButtonElement {
  const face = createPressable(['bs-face', model.isMain ? 'bs-face-main' : '', model.isBranch ? 'bs-face-branch' : '', ...classNames].filter(Boolean).join(' '));
  paintAgentMark(face, model.agentId, model.name);
  return face;
}

function stopBoardGestures(element: HTMLElement): void {
  element.addEventListener('pointerdown', (event) => event.stopPropagation());
  element.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
}

function menuItemOf(label: string, action: string, onPick: () => void): HTMLButtonElement {
  const item = createPressable('bs-menu-item');
  item.setAttribute('role', 'menuitem');
  item.dataset.action = action;
  item.append(el('span', 'bs-menu-name', label));
  item.addEventListener('click', onPick);
  return item;
}

function createShownCard(sessionId: string, actions: AgentCardActions, wires: SVGElement): ShownCard {
  const card = el('section', 'bs-card');
  card.dataset.sessionId = sessionId;
  const head = el('div', 'bs-card-head');
  const faceSlot = el('span', 'bs-card-face-slot');
  const name = el('span', 'bs-card-name');
  const menu = el('div', 'bs-menu bs-card-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const closeMenu = () => {
    menu.hidden = true;
    moreButton.setAttribute('aria-expanded', 'false');
  };
  const moreButton = menuButton({
    label: MENU_TEXT,
    action: 'board-session-agent-menu',
    onClick: () => {
      menu.hidden = !menu.hidden;
      moreButton.setAttribute('aria-expanded', String(!menu.hidden));
    },
  });
  moreButton.setAttribute('aria-haspopup', 'menu');
  moreButton.setAttribute('aria-expanded', 'false');
  menu.append(
    menuItemOf(RESTART_TEXT, 'board-session-agent-restart', () => {
      closeMenu();
      actions.restart(sessionId);
    }),
    menuItemOf(ACCOUNT_TEXT, 'board-session-agent-account', () => {
      closeMenu();
      actions.switchAccount(sessionId);
    }),
  );
  const repoButton = createPressable('bs-card-repo');
  repoButton.dataset.action = 'board-session-repo';
  repoButton.setAttribute('aria-haspopup', 'menu');
  repoButton.setAttribute('aria-expanded', 'false');
  const repoName = el('span', 'bs-card-repo-name');
  repoButton.append(repoName, createLineIcon(CARET_ICON_PATH, '1.5'));
  repoButton.addEventListener('click', () => actions.toggleRepoMenu(card, repoButton));
  head.append(faceSlot, name, repoButton, moreButton);
  const activity = createChatActivity();
  const digest = el('p', 'bs-card-digest');
  const approvals = el('div', 'bs-card-approvals-slot');
  card.append(head, activity.element, digest, approvals, menu);
  card.addEventListener('chat-card', (event) => {
    const cardId = stringDetailOf(event, 'cardId');
    const action = stringDetailOf(event, 'action');
    const value = stringDetailOf(event, 'value');
    if (cardId !== null && action !== null && value !== null) actions.answer(sessionId, cardId, action, value);
  });
  stopBoardGestures(card);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) closeMenu();
  });
  card.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
    closeMenu();
  });
  const shrunkFace = el('div', 'bs-card-shrunk');
  shrunkFace.dataset.sessionId = sessionId;
  stopBoardGestures(shrunkFace);
  const wire = createSvgShape('path', { class: 'bs-card-wire' });
  wires.append(wire);
  let shownModel: AgentCardModel | null = null;
  let shownBeat: ActivityBeat | null = null;

  return {
    card,
    shrunkFace,
    wire,
    placement: null,
    boxRect: null,
    isCardShrunk: false,
    cardSize: { width: 0, height: 0 },
    setModel: (model) => {
      const previous = shownModel;
      shownModel = model;
      card.dataset.phase = model.phase;
      card.toggleAttribute('data-main', model.isMain);
      card.toggleAttribute('data-branch', model.isBranch);
      wire.toggleAttribute('data-branch', model.isBranch);
      if (previous?.agentId !== model.agentId || previous?.name !== model.name || previous?.isMain !== model.isMain) {
        const face = faceOf(model, []);
        face.dataset.action = 'board-session-address-face';
        face.setAttribute('aria-label', `Message ${model.name}`);
        face.addEventListener('click', () => {
          if (shownModel) actions.address(shownModel);
        });
        faceSlot.replaceChildren(face);
        const shrunkButton = faceOf(model, ['bs-card-shrunk-face']);
        shrunkButton.dataset.action = 'board-session-open-card';
        shrunkButton.setAttribute('aria-label', `Open ${model.name}`);
        shrunkButton.addEventListener('click', () => actions.toggleOpened(sessionId));
        shrunkFace.replaceChildren(shrunkButton);
      }
      name.textContent = model.name;
      name.hidden = model.repoLabel !== null;
      repoName.textContent = model.repoLabel ?? '';
      repoButton.hidden = model.repoLabel === null;
      moreButton.hidden = model.repoLabel !== null;
      card.setAttribute('aria-label', model.name);
      activity.setPhase(model.phase);
      if (model.beat !== null && model.beat !== shownBeat) activity.beat([model.beat]);
      shownBeat = model.beat;
      digest.textContent = model.digest ?? '';
      digest.hidden = model.digest === null;
      card.toggleAttribute('data-asking', model.isAsking);
      if (approvals.firstElementChild !== model.approvals) approvals.replaceChildren(model.approvals);
    },
  };
}

function wirePathOf(box: Rect, card: Rect, side: CardSide): string {
  if (side === 'right' || side === 'left') {
    const boxEdgeX = side === 'right' ? box.x + box.width : box.x;
    const cardEdgeX = side === 'right' ? card.x : card.x + card.width;
    const boxMiddleY = box.y + box.height / 2;
    const cardEndY = card.y + Math.min(card.height / 2, FACE_SIZE_PX);
    const bendX = (boxEdgeX + cardEdgeX) / 2;
    return `M${boxEdgeX} ${boxMiddleY} C ${bendX} ${boxMiddleY}, ${bendX} ${cardEndY}, ${cardEdgeX} ${cardEndY}`;
  }
  const boxEdgeY = side === 'below' ? box.y + box.height : box.y;
  const cardEdgeY = side === 'below' ? card.y : card.y + card.height;
  const boxMiddleX = box.x + box.width / 2;
  const cardEndX = card.x + Math.min(card.width / 2, FACE_SIZE_PX);
  const bendY = (boxEdgeY + cardEdgeY) / 2;
  return `M${boxMiddleX} ${boxEdgeY} C ${boxMiddleX} ${bendY}, ${cardEndX} ${bendY}, ${cardEndX} ${cardEdgeY}`;
}

function screenRectOf(rect: Rect, camera: Camera): Rect {
  return { x: (rect.x - camera.x) * camera.scale, y: (rect.y - camera.y) * camera.scale, width: rect.width * camera.scale, height: rect.height * camera.scale };
}

export function createAgentCards(actions: AgentCardActions): AgentCards {
  const element = el('div', 'bs-cards');
  const wires = createSvgShape('svg', { class: 'bs-card-wires', 'aria-hidden': 'true' });
  element.append(wires);
  const shownBySessionId = new Map<string, ShownCard>();

  let paintedOrder: ShownCard[] = [];
  let shownMapBounds: readonly Rect[] = [];
  let shownFixedAreasOf: () => readonly Rect[] = () => [];
  let shownCamera: Camera | null = null;
  let viewSize = { width: 0, height: 0 };
  const shownByCard = new Map<Element, ShownCard>();
  const sizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const [borderBox] = entry.borderBoxSize;
      if (entry.target === element) viewSize = { width: entry.contentRect.width, height: entry.contentRect.height };
      const shown = shownByCard.get(entry.target);
      if (shown && borderBox && borderBox.inlineSize > 0) shown.cardSize = { width: borderBox.inlineSize, height: borderBox.blockSize };
    }
    if (shownCamera) place(shownCamera);
  });
  sizeObserver.observe(element);

  const shownCardOf = (sessionId: string): ShownCard => {
    const known = shownBySessionId.get(sessionId);
    if (known) return known;
    const created = createShownCard(sessionId, actions, wires);
    shownBySessionId.set(sessionId, created);
    shownByCard.set(created.card, created);
    sizeObserver.observe(created.card);
    element.append(created.card, created.shrunkFace);
    return created;
  };

  const place = (camera: Camera) => {
    shownCamera = camera;
    const placedCardRects: Rect[] = [...shownFixedAreasOf()];
    const view: Rect = { x: 0, y: UNPLACED_MAIN_TOP_PX, width: viewSize.width, height: Math.max(0, viewSize.height - UNPLACED_MAIN_TOP_PX) };
    const placementArea = cardPlacementAreaOf(shownMapBounds.map((rect) => screenRectOf(rect, camera)), view);
    const placementSignature = [view.width, view.height, camera.scale, ...shownMapBounds.flatMap((rect) => [rect.x, rect.y, rect.width, rect.height])].join(' ');
    for (const shown of paintedOrder) {
      const rect = shown.boxRect;
      if (rect === null) continue;
      const boxOnScreen = screenRectOf(rect, camera);
      if (shown.isCardShrunk) {
        shown.shrunkFace.style.transform = `translate(${boxOnScreen.x + boxOnScreen.width - FACE_SIZE_PX / 2}px, ${boxOnScreen.y - FACE_SIZE_PX / 2}px)`;
        continue;
      }
      const { cardSize } = shown;
      const placementKey = [rect.x, rect.y, rect.width, rect.height, cardSize.width, cardSize.height, placementSignature].join(' ');
      const cachedRect = shown.placement === null ? null : { x: boxOnScreen.x + shown.placement.offsetX, y: boxOnScreen.y + shown.placement.offsetY, ...cardSize };
      const isCachedSpotNewlyBlocked = cachedRect !== null && shown.placement?.isClearWhenPlaced === true && placedCardRects.some((placedRect) => rectsOverlap(cachedRect, placedRect));
      if (shown.placement?.key !== placementKey || isCachedSpotNewlyBlocked) {
        const spot = cardSpotOf(boxOnScreen, cardSize, placementArea, placedCardRects);
        const spotRect = { x: spot.x, y: spot.y, ...cardSize };
        const isClearWhenPlaced = !placedCardRects.some((placedRect) => rectsOverlap(spotRect, placedRect));
        shown.placement = { key: placementKey, offsetX: spot.x - boxOnScreen.x, offsetY: spot.y - boxOnScreen.y, side: spot.side, isClearWhenPlaced };
      }
      const cardRect = { x: boxOnScreen.x + shown.placement.offsetX, y: boxOnScreen.y + shown.placement.offsetY, ...cardSize };
      placedCardRects.push(cardRect);
      shown.card.style.transform = `translate(${cardRect.x}px, ${cardRect.y}px)`;
      shown.wire.setAttribute('d', wirePathOf(boxOnScreen, cardRect, shown.placement.side));
    }
  };

  return {
    element,
    paint: (models, boundsOf, mapBounds, camera, fixedAreasOf) => {
      shownMapBounds = mapBounds;
      shownFixedAreasOf = fixedAreasOf;
      const painted: ShownCard[] = [];
      for (const model of models) {
        const boxId = model.boxIds.find((candidate) => boundsOf(candidate) !== null);
        const rect = boxId === undefined ? null : boundsOf(boxId);
        if (rect === null && !model.isMain) continue;
        const shown = shownCardOf(model.sessionId);
        painted.push(shown);
        shown.setModel(model);
        shown.boxRect = rect;
        shown.isCardShrunk = rect !== null && isShrunk(model);
        shown.card.hidden = shown.isCardShrunk;
        shown.shrunkFace.hidden = !shown.isCardShrunk;
        shown.wire.toggleAttribute('data-hidden', rect === null || shown.isCardShrunk);
        if (rect === null) shown.card.style.transform = `translate(${UNPLACED_MAIN_LEFT_PX}px, ${UNPLACED_MAIN_TOP_PX}px)`;
      }
      const paintedSet = new Set(painted);
      for (const [sessionId, shown] of shownBySessionId) {
        if (paintedSet.has(shown)) continue;
        sizeObserver.unobserve(shown.card);
        shownByCard.delete(shown.card);
        shown.card.remove();
        shown.shrunkFace.remove();
        shown.wire.remove();
        shownBySessionId.delete(sessionId);
      }
      paintedOrder = painted;
      place(camera);
    },
    place,
  };
}
