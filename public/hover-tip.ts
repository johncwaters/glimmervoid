import { el } from './dom-helpers.ts';

const TIP_ID = 'hover-tip';
const ANCHOR_SELECTOR = '[data-tip-label]';
const GAP_PX = 6;
const VIEWPORT_MARGIN_PX = 8;

let tipElement: HTMLElement | null = null;
let shownAnchor: HTMLElement | null = null;

function anchorOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(ANCHOR_SELECTOR);
}

function ensureTipElement(): HTMLElement {
  if (tipElement) return tipElement;
  tipElement = el('div', 'hover-tip');
  tipElement.id = TIP_ID;
  tipElement.setAttribute('role', 'tooltip');
  tipElement.hidden = true;
  document.body.append(tipElement);
  return tipElement;
}

function fillTip(tip: HTMLElement, anchor: HTMLElement) {
  const text = el('span', 'hover-tip-text');
  text.append(el('b', 'hover-tip-label', anchor.dataset.tipLabel ?? ''));
  const detail = anchor.dataset.tipDetail;
  if (detail) text.append(el('span', 'hover-tip-detail', detail));
  const icon = anchor.querySelector('svg')?.cloneNode(true);
  tip.replaceChildren(...(icon ? [icon] : []), text);
}

function placeTip(tip: HTMLElement, anchor: HTMLElement) {
  const anchorRect = anchor.getBoundingClientRect();
  const tipWidth = tip.offsetWidth;
  const maxLeft = window.innerWidth - tipWidth - VIEWPORT_MARGIN_PX;
  const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(anchorRect.right - tipWidth, maxLeft));
  tip.style.left = `${left}px`;
  tip.style.top = `${anchorRect.bottom + GAP_PX}px`;
}

function showTip(anchor: HTMLElement) {
  const tip = ensureTipElement();
  if (shownAnchor && shownAnchor !== anchor) shownAnchor.removeAttribute('aria-describedby');
  shownAnchor = anchor;
  fillTip(tip, anchor);
  tip.hidden = false;
  placeTip(tip, anchor);
  anchor.setAttribute('aria-describedby', TIP_ID);
}

function hideTip() {
  if (!shownAnchor) return;
  shownAnchor.removeAttribute('aria-describedby');
  shownAnchor = null;
  if (tipElement) tipElement.hidden = true;
}

export function refreshHoverTip(anchor: HTMLElement) {
  if (shownAnchor !== anchor) return;
  if (!anchor.dataset.tipLabel || !anchor.isConnected) { hideTip(); return; }
  showTip(anchor);
}

let isInstalled = false;

export function installHoverTips() {
  if (isInstalled) return;
  isInstalled = true;
  document.addEventListener('pointerover', (event) => {
    const anchor = anchorOf(event.target);
    if (anchor) { showTip(anchor); return; }
    hideTip();
  });
  document.addEventListener('pointerout', (event) => {
    if (!shownAnchor) return;
    if (event.relatedTarget instanceof Node && shownAnchor.contains(event.relatedTarget)) return;
    hideTip();
  });
  document.addEventListener('focusin', (event) => {
    const anchor = anchorOf(event.target);
    if (anchor) { showTip(anchor); return; }
    hideTip();
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('pointerdown', hideTip);
  document.addEventListener('scroll', hideTip, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTip();
  });
}
