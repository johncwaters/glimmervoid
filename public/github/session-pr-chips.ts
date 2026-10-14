import { SessionPrLinks } from '#shared/contracts/my-prs.ts';
import type { LinkedPr, MyPr, MyPrStage, MyPrsStatus } from '#shared/contracts/my-prs.ts';
import { attentionSignature, createAttentionAck } from '../attention-ack-core.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el, externalLink } from '../dom-helpers.ts';
import { openExternalUrl } from '../external-link.ts';
import { setSessionPrAttention } from '../session-card/lifecycle.ts';
import { uiState } from '../ui-state-core.ts';
import { latestMyPrsStatus, setMyPrsSessionLinks } from './my-prs-panel.ts';
import { createPrStatusIcon } from './pr-status-icon.ts';
import { buildSessionPrChips, nextMyPrsByKey } from './session-pr-chips-core.ts';
import type { MyPrsByKey, SessionPrChip } from './session-pr-chips-core.ts';

const ATTENTION_STAGES: ReadonlySet<MyPrStage> = new Set<MyPrStage>(['checks-failing', 'changes-requested', 'unresolved-threads', 'conflicts', 'merged']);

const linksBySessionId = new Map<string, readonly LinkedPr[]>();
const acknowledgedSignatureBySessionId = new Map<string, string>();
const prAttentionBySessionId = new Map<string, ReturnType<typeof createAttentionAck>>();
let prsByKey: MyPrsByKey = new Map();
let indexedStatus: MyPrsStatus | null = null;
let hasStageBaseline = false;
let paintRevision = 0;

function attentionPrsFor(sessionId: string): MyPr[] {
  const attentionPrs: MyPr[] = [];
  for (const link of linksBySessionId.get(sessionId) ?? []) {
    const pr = prsByKey.get(`${link.repo}#${link.number}`);
    if (pr && ATTENTION_STAGES.has(pr.stage)) attentionPrs.push(pr);
  }
  return attentionPrs;
}

function prAttentionSignatureFor(sessionId: string): string {
  return attentionSignature(attentionPrsFor(sessionId).map((pr) => `${pr.key}@${pr.stage}`));
}

function isSessionFocused(sessionId: string): boolean {
  const { focusedSessionId, selectedSessionId } = uiState.snapshot();
  return focusedSessionId === sessionId || selectedSessionId === sessionId;
}

function prAttentionFor(sessionId: string): ReturnType<typeof createAttentionAck> {
  const existing = prAttentionBySessionId.get(sessionId);
  if (existing) return existing;
  const created = createAttentionAck({
    getAck: () => acknowledgedSignatureBySessionId.get(sessionId) ?? '',
    setAck: (next) => acknowledgedSignatureBySessionId.set(sessionId, next),
    signature: () => prAttentionSignatureFor(sessionId),
    isLooking: () => isSessionFocused(sessionId),
  });
  prAttentionBySessionId.set(sessionId, created);
  return created;
}

function refreshPrAttention(sessionId: string): void {
  if (!hasStageBaseline) return;
  setSessionPrAttention(sessionId, prAttentionFor(sessionId).refresh());
}

function acknowledgeStagesBroughtByLinks(sessionId: string, signatureBeforeLinkChange: string): void {
  if (!hasStageBaseline) return;
  const acknowledgedBeforeLinkChange = acknowledgedSignatureBySessionId.get(sessionId);
  const wasBadged = acknowledgedBeforeLinkChange !== undefined && acknowledgedBeforeLinkChange !== signatureBeforeLinkChange;
  if (wasBadged) return;
  const existingAttention = prAttentionBySessionId.get(sessionId);
  if (existingAttention) { existingAttention.acknowledge(); return; }
  acknowledgedSignatureBySessionId.set(sessionId, prAttentionSignatureFor(sessionId));
}

function seedStageBaseline(status: MyPrsStatus | null): void {
  if (hasStageBaseline || !status?.configured || status.error) return;
  hasStageBaseline = true;
  for (const sessionId of linksBySessionId.keys()) acknowledgedSignatureBySessionId.set(sessionId, prAttentionSignatureFor(sessionId));
}

uiState.subscribe((state, changedKeys) => {
  if (!changedKeys.includes('focusedSessionId') && !changedKeys.includes('selectedSessionId')) return;
  for (const sessionId of new Set([state.focusedSessionId, state.selectedSessionId])) {
    if (sessionId && prAttentionBySessionId.has(sessionId)) refreshPrAttention(sessionId);
  }
});

function slotsFor(sessionId: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>(`[data-pr-chips-for="${CSS.escape(sessionId)}"]`);
}

function openChip(event: MouseEvent, url: string): void {
  event.stopPropagation();
  if (event.defaultPrevented) return;
  event.preventDefault();
  openExternalUrl(url);
}

function createChip(chip: SessionPrChip, isInsideButton: boolean): HTMLElement {
  const chipElement = isInsideButton ? el('span', 'session-pr-chip') : externalLink('session-pr-chip', '', chip.url, chip.hoverText);
  chipElement.title = chip.hoverText;
  if (chip.stage) {
    chipElement.dataset.tone = chip.stage.tone;
    chipElement.append(createPrStatusIcon(chip.stage.icon, chip.stage.tone));
  }
  chipElement.append(chip.numberText);
  if (!isInsideButton) chipElement.setAttribute('aria-label', `Open pull request ${chip.key}`);
  chipElement.addEventListener('click', (event) => openChip(event, chip.url));
  return chipElement;
}

function createUnlinkableChip(chip: SessionPrChip, sessionId: string): HTMLElement {
  const unlinkButton = el('button', 'session-pr-chip-unlink', String.fromCharCode(0xd7));
  unlinkButton.type = 'button';
  unlinkButton.title = `Unlink ${chip.key} from this session`;
  unlinkButton.setAttribute('aria-label', `Unlink pull request ${chip.key}`);
  unlinkButton.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    sendControlMsg({ type: 'unlink-session-pr', id: sessionId, key: chip.key });
  });
  const chipItem = el('span', 'session-pr-chip-item');
  chipItem.append(createChip(chip, false), unlinkButton);
  return chipItem;
}

export function paintSessionPrChips(slot: HTMLElement, sessionId: string): void {
  const revision = String(paintRevision);
  if (slot.dataset.prChipsFor === sessionId && slot.dataset.prChipsRevision === revision) return;
  slot.dataset.prChipsFor = sessionId;
  slot.dataset.prChipsRevision = revision;
  const view = buildSessionPrChips(linksBySessionId.get(sessionId) ?? [], prsByKey);
  const isInsideButton = slot.closest('button') !== null;
  const chipElements = view.chips.map((chip) => isInsideButton ? createChip(chip, true) : createUnlinkableChip(chip, sessionId));
  if (view.overflowCount > 0) {
    const overflow = el('span', 'session-pr-chip-overflow', `+${view.overflowCount}`);
    overflow.title = view.overflowHoverText;
    chipElements.push(overflow);
  }
  slot.hidden = chipElements.length === 0;
  slot.replaceChildren(...chipElements);
}

function repaintSlots(slots: Iterable<HTMLElement>): void {
  paintRevision += 1;
  for (const slot of slots) {
    const sessionId = slot.dataset.prChipsFor;
    if (sessionId) paintSessionPrChips(slot, sessionId);
  }
}

export function setSessionLinkedPrs(sessionId: string, linkedPrs: unknown): void {
  const parsedLinks = SessionPrLinks.shape.links.safeParse(linkedPrs ?? []);
  const signatureBeforeLinkChange = prAttentionSignatureFor(sessionId);
  linksBySessionId.set(sessionId, parsedLinks.success ? parsedLinks.data : []);
  acknowledgeStagesBroughtByLinks(sessionId, signatureBeforeLinkChange);
  repaintSlots(slotsFor(sessionId));
  setMyPrsSessionLinks(linksBySessionId);
  refreshPrAttention(sessionId);
}

export function forgetSessionLinkedPrs(sessionId: string): void {
  linksBySessionId.delete(sessionId);
  acknowledgedSignatureBySessionId.delete(sessionId);
  prAttentionBySessionId.delete(sessionId);
  setMyPrsSessionLinks(linksBySessionId);
}

export function refreshSessionPrChipStages(): void {
  const status = latestMyPrsStatus();
  if (status === indexedStatus) return;
  indexedStatus = status;
  const nextPrsByKey = nextMyPrsByKey(prsByKey, status);
  if (nextPrsByKey === prsByKey) return;
  prsByKey = nextPrsByKey;
  repaintSlots(document.querySelectorAll<HTMLElement>('[data-pr-chips-for]'));
  seedStageBaseline(status);
  for (const sessionId of linksBySessionId.keys()) refreshPrAttention(sessionId);
}
