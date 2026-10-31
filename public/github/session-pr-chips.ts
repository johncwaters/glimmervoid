import { githubPrByKey, subscribeGithubPrs } from './github-prs-store.ts';
import { SessionPrLinks } from '#shared/contracts/my-prs.ts';
import type { LinkedPr } from '#shared/contracts/my-prs.ts';
import { el } from '../dom-helpers.ts';
import { openExternalUrl } from '../external-link.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { sendForSession } from '../session-actions.ts';
import { setMyPrsSessionLinks } from './my-prs-store.ts';
import { showPrInReviewQueue } from './review-queue-store.ts';
import { repaintSessionRowSignals, repaintSessionRowSignalsFor } from '../session-row.ts';
import { createSignal, paintSignalLine } from '../signal.ts';
import { CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import type { ActivatableSignal } from '../signal.ts';
import { sessionPrSignals } from './session-pr-chips-core.ts';
import type { SessionPrChip } from './session-pr-chips-core.ts';

const linksBySessionId = new Map<string, readonly LinkedPr[]>();

function slotsFor(sessionId: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>(`[data-pr-rows-for="${CSS.escape(sessionId)}"]`);
}

type PrSignal = SessionPrChip & ActivatableSignal;

export function sessionRowPrSignals(sessionId: string): PrSignal[] {
  return sessionPrSignals(linksBySessionId.get(sessionId) ?? [], githubPrByKey).map((chip) => ({
    ...chip,
    className: 'session-pr-chip',
    linkUrl: chip.url,
    ariaLabel: `Show pull request ${chip.key} in Reviews`,
    hoverText: `${chip.hoverText}. Show in Reviews; Cmd/Ctrl-click opens GitHub`,
    onActivate: () => {
      if (showPrInReviewQueue(chip.key)) return;
      openExternalUrl(chip.url);
    },
  }));
}

function createUnlinkButton(chip: PrSignal, sessionId: string): HTMLButtonElement {
  const unlinkButton = el('button', 'session-pr-chip-unlink');
  unlinkButton.append(createLineIcon(CLOSE_ICON_PATH));
  unlinkButton.type = 'button';
  unlinkButton.title = `Unlink ${chip.key} from this session`;
  unlinkButton.setAttribute('aria-label', `Unlink pull request ${chip.key}`);
  unlinkButton.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    openConfirmDialog({
      title: 'Unlink pull request',
      message: `Unlink ${chip.key} from this session? Its checks and reviews stop showing here until you link it again.`,
      confirmLabel: 'Unlink',
      danger: true,
      onConfirm: () => { sendForSession(sessionId, { type: 'unlink-session-pr', id: sessionId, key: chip.key }); },
    });
  });
  return unlinkButton;
}

function createLinkedPrRow(chip: PrSignal, sessionId: string): HTMLElement {
  const rowLink = createSignal({ ...chip, text: chip.key }, { ...chip, className: 'linked-pr-row-link' });
  if (chip.prTitle) rowLink.append(el('span', 'linked-pr-row-title', chip.prTitle));
  if (chip.stateText) rowLink.append(el('span', 'linked-pr-row-stage', chip.stateText));
  const row = el('li', 'linked-pr-row');
  row.append(rowLink, createUnlinkButton(chip, sessionId));
  return row;
}

export function paintSessionPrRows(list: HTMLElement, sessionId: string): void {
  list.dataset.prRowsFor = sessionId;
  const signals = sessionRowPrSignals(sessionId);
  paintSignalLine(list, signals, (chip) => createLinkedPrRow(chip, sessionId), { visibleCount: signals.length });
}

function repaintSlots(slots: Iterable<HTMLElement>): void {
  for (const slot of slots) {
    const sessionId = slot.dataset.prRowsFor;
    if (sessionId) paintSessionPrRows(slot, sessionId);
  }
}

export function setSessionLinkedPrs(sessionId: string, linkedPrs: unknown): void {
  const parsedLinks = SessionPrLinks.shape.links.safeParse(linkedPrs ?? []);
  linksBySessionId.set(sessionId, parsedLinks.success ? parsedLinks.data : []);
  repaintSlots(slotsFor(sessionId));
  repaintSessionRowSignalsFor(sessionId);
  setMyPrsSessionLinks(linksBySessionId);
}

export function forgetSessionLinkedPrs(sessionId: string): void {
  linksBySessionId.delete(sessionId);
  setMyPrsSessionLinks(linksBySessionId);
}

subscribeGithubPrs(() => {
  repaintSlots(document.querySelectorAll<HTMLElement>('[data-pr-rows-for]'));
  repaintSessionRowSignals();
});
