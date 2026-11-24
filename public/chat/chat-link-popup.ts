import { packNameOfApprovalUrl } from '#shared/pack-approval.ts';
import { createLinkPopup } from '../session-card/terminal-link-popup.ts';
import type { AnchorBox } from '../session-card/terminal-link-popup-core.ts';
import { copyButton } from '../ui/copy-button.ts';

const CHAT_LINK_SELECTOR = 'a.plan-link[href]';

function chatLinkOf(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  const link = target.closest(CHAT_LINK_SELECTOR);
  return link instanceof HTMLAnchorElement ? link : null;
}

function anchorBoxOf(link: HTMLAnchorElement): AnchorBox | null {
  const lineBoxes = link.getClientRects();
  const firstLine = lineBoxes[0];
  const lastLine = lineBoxes[lineBoxes.length - 1];
  if (!firstLine || !lastLine) return null;
  return { topPx: firstLine.top, bottomPx: lastLine.bottom, leftPx: firstLine.left };
}

function hoveredLinkOf(link: HTMLAnchorElement) {
  return { url: link.href, linkText: link.textContent, anchor: link };
}

function visibleLogBoxOf(scroller: HTMLElement, dock: HTMLElement): DOMRect {
  const scrollerBox = scroller.getBoundingClientRect();
  const visibleBottomPx = Math.min(scrollerBox.bottom, dock.getBoundingClientRect().top);
  return new DOMRect(scrollerBox.left, scrollerBox.top, scrollerBox.width, Math.max(0, visibleBottomPx - scrollerBox.top));
}

export function attachChatLinkPopup(host: HTMLElement, scroller: HTMLElement, dock: HTMLElement): void {
  const linkPopup = createLinkPopup<HTMLAnchorElement>({
    host,
    boundsBoxOf: () => visibleLogBoxOf(scroller, dock),
    anchorBoxOf,
    copyControlOf: (url) => copyButton({ text: () => url, label: 'Copy link', size: 'small' }).element,
  });
  let linkUnderPointer: HTMLAnchorElement | null = null;
  scroller.addEventListener('mousemove', (event) => {
    const link = chatLinkOf(event.target);
    if (link === linkUnderPointer) return;
    if (linkUnderPointer) linkPopup.leaveLink();
    linkUnderPointer = link;
    if (link) linkPopup.enterLink(hoveredLinkOf(link));
  });
  scroller.addEventListener('mouseout', (event) => {
    if (!linkUnderPointer || chatLinkOf(event.relatedTarget) === linkUnderPointer) return;
    linkUnderPointer = null;
    linkPopup.leaveLink();
  });
  scroller.addEventListener('click', (event) => {
    const link = chatLinkOf(event.target);
    if (!link || packNameOfApprovalUrl(link.href, location.host) === null) return;
    event.preventDefault();
    linkPopup.pinLink(hoveredLinkOf(link));
  });
  scroller.addEventListener('scroll', () => {
    linkUnderPointer = null;
    linkPopup.close();
  }, { passive: true });
}
