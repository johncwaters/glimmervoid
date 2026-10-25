import { githubPrByKey, subscribeGithubPrs } from './github-prs-store.ts';
import { SessionPrLinks } from '#shared/contracts/my-prs.ts';
import type { LinkedPr } from '#shared/contracts/my-prs.ts';
import { el } from '../dom-helpers.ts';
import { openExternalUrl } from '../external-link.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { sendForSession } from '../session-actions.ts';
import { setMyPrsSessionLinks } from './my-prs-panel.ts';
import { showPrInReviewQueue } from './review-queue-panel.ts';
import { repaintSessionRowSignals } from '../session-row.ts';
import { createSignal, paintSignalLine } from '../signal.ts';
import { CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import type { ActivatableSignal } from '../signal.ts';
import { sessionPrSignals } from './session-pr-chips-core.ts';
import type { SessionPrChip } from './session-pr-chips-core.ts';

const linksBySessionId = new Map<string, readonly LinkedPr[]>();

function slotsFor(sessionId: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>(`[data-pr-chips-for="${CSS.escape(sessionId)}"]`);
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

function createUnlinkableChip(chip: PrSignal, sessionId: string): HTMLElement {
  const chipLink = createSignal(chip, chip);
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
  const chipItem = el('span', 'session-pr-chip-item');
  chipItem.append(chipLink, unlinkButton);
  return chipItem;
}

export function paintSessionPrChips(slot: HTMLElement, sessionId: string): void {
  slot.dataset.prChipsFor = sessionId;
  paintSignalLine(slot, sessionRowPrSignals(sessionId), (chip) => createUnlinkableChip(chip, sessionId));
}

function repaintSlots(slots: Iterable<HTMLElement>): void {
  for (const slot of slots) {
    const sessionId = slot.dataset.prChipsFor;
    if (sessionId) paintSessionPrChips(slot, sessionId);
  }
  repaintSessionRowSignals();
}

export function setSessionLinkedPrs(sessionId: string, linkedPrs: unknown): void {
  const parsedLinks = SessionPrLinks.shape.links.safeParse(linkedPrs ?? []);
  linksBySessionId.set(sessionId, parsedLinks.success ? parsedLinks.data : []);
  repaintSlots(slotsFor(sessionId));
  setMyPrsSessionLinks(linksBySessionId);
}

export function forgetSessionLinkedPrs(sessionId: string): void {
  linksBySessionId.delete(sessionId);
  setMyPrsSessionLinks(linksBySessionId);
}

subscribeGithubPrs(() => repaintSlots(document.querySelectorAll<HTMLElement>('[data-pr-chips-for]')));
