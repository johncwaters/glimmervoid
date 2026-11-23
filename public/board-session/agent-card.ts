import type { Rect } from '#shared/whiteboard-layout-core.ts';
import { createChatActivity } from '../chat/chat-activity.ts';
import { stringDetailOf } from '../chat/chat-page.ts';
import type { ActivityBeat, ChatPhase } from '../chat/chat-activity-core.ts';
import type { RunningSubagent } from '../chat/status-rail-core.ts';
import { el } from '../dom-helpers.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { createSvgShape } from '../svg-dom.ts';
import { menuButton } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import type { Camera } from '../whiteboard/board-gl-renderer.ts';

const CARD_OFFSET_PX = 48;
const CARD_STACK_GAP_PX = 10;
const FACE_SIZE_PX = 28;
const UNPLACED_MAIN_LEFT_PX = 16;
const UNPLACED_MAIN_TOP_PX = 64;
const MENU_TEXT = 'Agent menu';
const RESTART_TEXT = 'Restart';
const ACCOUNT_TEXT = 'Model and account';
const BUSY_PHASES: ReadonlySet<ChatPhase> = new Set(['starting', 'working', 'monitoring']);

export interface AgentCardModel {
  sessionId: string;
  name: string;
  agentId: string | null;
  isMain: boolean;
  isBranch: boolean;
  boxIds: readonly string[];
  phase: ChatPhase;
  beat: ActivityBeat | null;
  digest: string | null;
  subagents: readonly RunningSubagent[];
  approvals: HTMLElement;
  isAsking: boolean;
  isOpened: boolean;
}

interface AgentCardActions {
  address(model: AgentCardModel): void;
  restart(sessionId: string): void;
  switchAccount(sessionId: string): void;
  toggleOpened(sessionId: string): void;
  answer(sessionId: string, cardId: string, action: string, value: string): void;
}

export interface AgentCards {
  element: HTMLElement;
  paint(models: readonly AgentCardModel[], boundsOf: (boxId: string) => Rect | null, camera: Camera, keepClearOf: Rect | null): void;
}

interface ShownCard {
  card: HTMLElement;
  shrunkFace: HTMLElement;
  wire: SVGElement;
  setModel(model: AgentCardModel): void;
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
  const subagents = el('span', 'bs-card-subagents');
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
  head.append(faceSlot, name, subagents, moreButton);
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
      card.setAttribute('aria-label', model.name);
      subagents.replaceChildren(...model.subagents.map((subagent) => el('span', 'bs-face bs-face-sub', subagent.type.slice(0, 1).toUpperCase())));
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

function clearedTopOf(cardLeft: number, cardTop: number, card: HTMLElement, keepClearOf: Rect | null): number {
  if (keepClearOf === null) return cardTop;
  const isBesideClearArea = cardLeft + card.offsetWidth <= keepClearOf.x || cardLeft >= keepClearOf.x + keepClearOf.width;
  if (isBesideClearArea || cardTop + card.offsetHeight + CARD_STACK_GAP_PX <= keepClearOf.y) return cardTop;
  return Math.max(CARD_STACK_GAP_PX, keepClearOf.y - card.offsetHeight - CARD_STACK_GAP_PX);
}

export function createAgentCards(actions: AgentCardActions): AgentCards {
  const element = el('div', 'bs-cards');
  const wires = createSvgShape('svg', { class: 'bs-card-wires', 'aria-hidden': 'true' });
  element.append(wires);
  const shownBySessionId = new Map<string, ShownCard>();

  const shownCardOf = (sessionId: string): ShownCard => {
    const known = shownBySessionId.get(sessionId);
    if (known) return known;
    const created = createShownCard(sessionId, actions, wires);
    shownBySessionId.set(sessionId, created);
    element.append(created.card, created.shrunkFace);
    return created;
  };

  return {
    element,
    paint: (models, boundsOf, camera, keepClearOf) => {
      const stackedPxByBoxId = new Map<string, number>();
      const paintedIds = new Set<string>();
      for (const model of models) {
        const boxId = model.boxIds.find((candidate) => boundsOf(candidate) !== null);
        const rect = boxId === undefined ? null : boundsOf(boxId);
        if ((rect === null || boxId === undefined) && !model.isMain) continue;
        paintedIds.add(model.sessionId);
        const shown = shownCardOf(model.sessionId);
        shown.setModel(model);
        if (rect === null || boxId === undefined) {
          shown.card.hidden = false;
          shown.shrunkFace.hidden = true;
          shown.wire.toggleAttribute('data-hidden', true);
          shown.card.style.transform = `translate(${UNPLACED_MAIN_LEFT_PX}px, ${UNPLACED_MAIN_TOP_PX}px)`;
          continue;
        }
        const boxRight = (rect.x + rect.width - camera.x) * camera.scale;
        const boxTop = (rect.y - camera.y) * camera.scale;
        const boxMiddle = (rect.y + rect.height / 2 - camera.y) * camera.scale;
        const isCardShrunk = isShrunk(model);
        shown.card.hidden = isCardShrunk;
        shown.shrunkFace.hidden = !isCardShrunk;
        shown.wire.toggleAttribute('data-hidden', isCardShrunk);
        if (isCardShrunk) {
          shown.shrunkFace.style.transform = `translate(${boxRight - FACE_SIZE_PX / 2}px, ${boxTop - FACE_SIZE_PX / 2}px)`;
          continue;
        }
        const stackedPx = stackedPxByBoxId.get(boxId) ?? 0;
        const cardLeft = boxRight + CARD_OFFSET_PX;
        const cardTop = clearedTopOf(cardLeft, boxTop + stackedPx, shown.card, keepClearOf);
        stackedPxByBoxId.set(boxId, stackedPx + shown.card.offsetHeight + CARD_STACK_GAP_PX);
        shown.card.style.transform = `translate(${cardLeft}px, ${cardTop}px)`;
        const wireEndY = cardTop + Math.min(shown.card.offsetHeight / 2, FACE_SIZE_PX);
        const bendX = (boxRight + cardLeft) / 2;
        shown.wire.setAttribute('d', `M${boxRight} ${boxMiddle} C ${bendX} ${boxMiddle}, ${bendX} ${wireEndY}, ${cardLeft} ${wireEndY}`);
      }
      for (const [sessionId, shown] of shownBySessionId) {
        if (paintedIds.has(sessionId)) continue;
        shown.card.remove();
        shown.shrunkFace.remove();
        shown.wire.remove();
        shownBySessionId.delete(sessionId);
      }
    },
  };
}
