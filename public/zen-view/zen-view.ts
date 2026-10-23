import { STATES } from '#shared/states.ts';
import { borrowCard, getBorrowedCardId, releaseCard } from '../card-host.ts';
import { el } from '../dom-helpers.ts';
import { buildFlyingAnimalPreview } from '../flying-animal-preview.ts';
import { hasUnseenOutcomeAttention, orderAttentionQueue, orderRoster, pickNextAttention, pickStagedSession } from '../focus-view/attention-core.ts';
import { basename } from '../focus-view/roster-groups-core.ts';
import { readSessionRows } from '../session-actions.ts';
import type { ActivityRenderKind } from '../session-card/activity.ts';
import { addActivityRenderer } from '../session-card/activity.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { markSessionSeen } from '../session-card/lifecycle.ts';
import { onSessionTick } from '../session-card/session-tick.ts';
import { setTerminalActiveViewer } from '../session-card/terminal.ts';
import { buildNextAttentionKeys } from '../shortcuts.ts';
import { paintStatusIcon } from '../status-icon.ts';
import { getFlyingAnimalsOptions } from '../ui-prefs.ts';
import { isPetState, petBubbleIcon, petMood, petSpot, pickPetAnimal, stageReasonWords } from './zen-pets-core.ts';

const WORKING_STATES: ReadonlySet<string> = new Set([STATES.RUNNING, STATES.STARTING, STATES.INITIALIZING]);

interface ZenElements {
  calm: HTMLElement;
  workingCount: HTMLElement;
  meadow: HTMLElement;
  stage: HTMLElement;
  stagedNeed: HTMLElement;
  queuedBehind: HTMLElement;
  petStrip: HTMLElement;
  cardSlot: HTMLElement;
}

interface ZenPet {
  root: HTMLButtonElement;
  hopper: HTMLElement;
  bubble: HTMLElement;
  name: HTMLElement;
}

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

let zenElements: ZenElements | null = null;
let isActive = false;
let stagedSessionId: string | null = null;
let heldPeekSessionId: string | null = null;
const petBySessionId = new Map<string, ZenPet>();

export function mountZenView(panel: HTMLElement) {
  const calm = el('div', 'zen-calm');
  const statusLine = el('div', 'zen-status-line');
  statusLine.setAttribute('role', 'status');
  const workingCount = el('span', 'zen-working-count');
  statusLine.append(el('h2', 'zen-all-clear', 'ALL CLEAR'), workingCount);
  const meadow = el('div', 'zen-meadow');
  meadow.setAttribute('aria-label', 'Sessions');
  calm.append(statusLine, meadow);

  const stage = el('div', 'zen-stage');
  const reasonLine = el('div', 'zen-reason-line');
  reasonLine.setAttribute('role', 'status');
  const stagedNeed = el('span', 'zen-staged-need');
  const queuedBehind = el('span', 'zen-queued-behind');
  reasonLine.append(stagedNeed, queuedBehind);
  const petStrip = el('div', 'zen-pet-strip');
  petStrip.setAttribute('aria-label', 'Other sessions');
  const nextButton = el('button', 'btn-dialog', 'Next');
  nextButton.type = 'button';
  nextButton.addEventListener('click', stageNextAttention);
  const stageBar = el('div', 'zen-stage-bar');
  stageBar.append(reasonLine, petStrip, nextButton, buildNextAttentionKeys());
  const cardSlot = el('div', 'zen-card-slot');
  stage.append(stageBar, cardSlot);
  stage.hidden = true;

  panel.append(calm, stage);
  zenElements = { calm, workingCount, meadow, stage, stagedNeed, queuedBehind, petStrip, cardSlot };
}

export function isZenActive() { return isActive; }

export function activateZenView() {
  if (!zenElements) return;
  isActive = true;
  for (const pet of petBySessionId.values()) pet.root.remove();
  petBySessionId.clear();
  refreshZenView();
}

export function deactivateZenView() {
  if (!isActive) return;
  releaseStage();
  heldPeekSessionId = null;
  isActive = false;
}

export function refreshZenView() {
  if (!isActive) return;
  const queuedIds = queuedSessionIds();
  if (heldPeekSessionId !== null && !isPetSessionLive(heldPeekSessionId)) heldPeekSessionId = null;
  const stagedId = heldPeekSessionId ?? pickStagedSession(queuedIds, stagedSessionId);
  showStage(stagedId, queuedIds);
}

export function stageNextAttention() {
  if (!isActive) return;
  heldPeekSessionId = null;
  const leavingId = stagedSessionId;
  const leavingUi = leavingId === null ? undefined : sessionUIs.get(leavingId);
  const isLeavingUnseenOutcome = leavingUi !== undefined && hasUnseenOutcomeAttention({ state: leavingUi.currentState, unseenOutcome: leavingUi.unseenOutcome });
  if (leavingId !== null && isLeavingUnseenOutcome) markSessionSeen(leavingId);
  const queuedIds = queuedSessionIds().filter((id) => !isLeavingUnseenOutcome || id !== leavingId);
  const nextId = pickNextAttention(queuedIds, leavingId);
  showStage(nextId, queuedIds);
}

function peekSession(sessionId: string) {
  if (!isActive || !isPetSessionLive(sessionId)) return;
  heldPeekSessionId = sessionId;
  showStage(sessionId, queuedSessionIds());
}

function isPetSessionLive(sessionId: string) {
  const ui = sessionUIs.get(sessionId);
  return ui !== undefined && isPetState(ui.currentState);
}

function queuedSessionIds() {
  return orderAttentionQueue(orderRoster(readSessionRows()));
}

function showStage(sessionId: string | null, queuedIds: readonly string[]) {
  if (!zenElements) return;
  const ui = sessionId === null ? undefined : sessionUIs.get(sessionId);
  if (sessionId === null || !ui) {
    releaseStage();
    paintCalm(zenElements);
    return;
  }
  const isNewlyStaged = stagedSessionId !== sessionId;
  stagedSessionId = sessionId;
  zenElements.calm.hidden = true;
  zenElements.stage.hidden = false;
  paintReasonLine(zenElements, ui, queuedIds.filter((id) => id !== sessionId).length);
  reconcilePets(zenElements.petStrip, sessionId);
  if (getBorrowedCardId() === sessionId && ui.card.parentElement === zenElements.cardSlot) return;
  borrowCard(ui, sessionId, zenElements.cardSlot, { className: 'zen-staged' });
  setTerminalActiveViewer(ui, sessionId, true);
  if (isNewlyStaged) focusTerminalAfterSettle(ui, sessionId);
}

function releaseStage() {
  if (stagedSessionId !== null && getBorrowedCardId() === stagedSessionId) releaseCard();
  stagedSessionId = null;
}

function paintReasonLine(elements: ZenElements, ui: SessionUi, queuedBehindCount: number) {
  elements.stagedNeed.textContent = stageReasonWords(ui.currentState, ui.pendingPromptKind);
  elements.stagedNeed.dataset.state = ui.currentState;
  elements.queuedBehind.textContent = `${queuedBehindCount} more waiting`;
  elements.queuedBehind.hidden = queuedBehindCount === 0;
}

function paintCalm(elements: ZenElements) {
  elements.stage.hidden = true;
  elements.calm.hidden = false;
  const workingCount = readSessionRows().filter((row) => WORKING_STATES.has(row.state)).length;
  elements.workingCount.textContent = `${workingCount} working`;
  reconcilePets(elements.meadow, null);
}

function reconcilePets(container: HTMLElement, excludedSessionId: string | null) {
  const petRows = orderRoster(readSessionRows()).filter((row) => isPetState(row.state) && row.id !== excludedSessionId);
  const shownIds = new Set(petRows.map((row) => row.id));
  for (const [sessionId, pet] of petBySessionId) {
    if (shownIds.has(sessionId)) continue;
    pet.root.remove();
    if (!sessionUIs.has(sessionId)) petBySessionId.delete(sessionId);
  }
  for (const row of petRows) {
    const pet = petBySessionId.get(row.id) ?? buildPet(row.id);
    if (pet.root.parentElement !== container) container.append(pet.root);
    paintPet(pet, row.ui, row.name);
  }
}

function buildPet(sessionId: string): ZenPet {
  const root = el('button', 'zen-pet');
  root.type = 'button';
  root.dataset.sessionId = sessionId;
  const spot = petSpot(sessionId);
  root.style.setProperty('--zen-pet-left', `${spot.leftPercent}%`);
  root.style.setProperty('--zen-pet-top', `${spot.topPercent}%`);
  root.style.setProperty('--zen-pet-amble-distance', `${spot.ambleDistancePx}px`);
  root.style.setProperty('--zen-pet-amble-duration', `${spot.ambleSeconds}s`);
  root.addEventListener('click', () => peekSession(sessionId));
  const walker = el('span', 'zen-pet-walker');
  const bubble = el('span', 'zen-pet-bubble');
  bubble.setAttribute('aria-hidden', 'true');
  const facing = el('span', 'zen-pet-facing');
  const hopper = el('span', 'zen-pet-hopper');
  const animal = pickPetAnimal(sessionId, getFlyingAnimalsOptions().flyingAnimalsExcludedSprites);
  hopper.append(animal ? buildFlyingAnimalPreview(animal, 'zen-pet-sprite') : el('span', 'zen-pet-dot'));
  facing.append(hopper);
  const zzz = el('span', 'zen-pet-zzz', 'zzz');
  zzz.setAttribute('aria-hidden', 'true');
  const name = el('span', 'zen-pet-name');
  walker.append(bubble, facing, zzz, name);
  root.append(walker);
  const pet = { root, hopper, bubble, name };
  petBySessionId.set(sessionId, pet);
  return pet;
}

function paintPet(pet: ZenPet, ui: SessionUi, sessionName: string) {
  paintPetMood(pet, ui, performance.now());
  pet.root.dataset.state = ui.currentState;
  if (pet.name.textContent !== sessionName) pet.name.textContent = sessionName;
  pet.root.setAttribute('aria-label', sessionName);
  pet.root.title = `${basename(ui.path)}: ${stageReasonWords(ui.currentState, ui.pendingPromptKind)}`;
  const bubbleIcon = petBubbleIcon({ state: ui.currentState, unseenOutcome: ui.unseenOutcome });
  pet.bubble.hidden = bubbleIcon === null;
  if (bubbleIcon !== null) paintStatusIcon(pet.bubble, bubbleIcon);
}

function hopPet(pet: ZenPet) {
  if (reducedMotion?.matches || document.hidden || !pet.hopper.animate) return;
  pet.hopper.animate(
    [{ transform: 'translateY(0)' }, { transform: 'translateY(-6px)', offset: 0.4 }, { transform: 'translateY(0)' }],
    { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
}

function paintPetMood(pet: ZenPet, ui: SessionUi, nowMs: number) {
  pet.root.dataset.mood = petMood({ state: ui.currentState, activity: ui._activity, lastOutputAtMs: ui._lastOutputAt, nowMs });
}

function renderPetActivity(ui: SessionUi, kind: ActivityRenderKind) {
  if (!isActive) return;
  const sessionId = ui.card?.dataset.id;
  const pet = sessionId ? petBySessionId.get(sessionId) : undefined;
  if (!pet?.root.isConnected) return;
  paintPetMood(pet, ui, performance.now());
  if (kind === 'beat') hopPet(pet);
}
addActivityRenderer(renderPetActivity);

onSessionTick(() => {
  if (!isActive) return;
  const nowMs = performance.now();
  for (const [sessionId, pet] of petBySessionId) {
    const ui = sessionUIs.get(sessionId);
    if (ui && pet.root.isConnected) paintPetMood(pet, ui, nowMs);
  }
});

function focusTerminalAfterSettle(ui: SessionUi, sessionId: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!isActive || stagedSessionId !== sessionId) return;
    if (document.hidden || !document.hasFocus()) return;
    ui.term?.focus();
  }));
}
