import { el } from './dom-helpers.ts';
import { clampTipText, TIP_DETAIL_MAX_CHARS, TIP_LABEL_MAX_CHARS } from './hover-tip-core.ts';

const TIP_ID = 'hover-tip';
const ANCHOR_SELECTOR = '[data-tip-label]';
const GAP_PX = 6;
const VIEWPORT_MARGIN_PX = 8;
const HOVER_INTENT_DELAY_MS = 500;
const WARM_SKIP_WINDOW_MS = 300;

let tipElement: HTMLElement | null = null;
let shownAnchor: HTMLElement | null = null;
let pendingAnchor: HTMLElement | null = null;
let pendingShowTimer: ReturnType<typeof setTimeout> | undefined;
let lastHiddenAtMs = Number.NEGATIVE_INFINITY;

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
  text.append(el('b', 'hover-tip-label', clampTipText(anchor.dataset.tipLabel ?? '', TIP_LABEL_MAX_CHARS)));
  const detail = anchor.dataset.tipDetail;
  if (detail) text.append(el('span', 'hover-tip-detail', clampTipText(detail, TIP_DETAIL_MAX_CHARS)));
  tip.replaceChildren(text);
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

function cancelPendingShow() {
  clearTimeout(pendingShowTimer);
  pendingShowTimer = undefined;
  pendingAnchor = null;
}

function hideTip() {
  cancelPendingShow();
  if (!shownAnchor) return;
  shownAnchor.removeAttribute('aria-describedby');
  shownAnchor = null;
  lastHiddenAtMs = performance.now();
  if (tipElement) tipElement.hidden = true;
}

function isWarm(): boolean {
  return shownAnchor !== null || performance.now() - lastHiddenAtMs < WARM_SKIP_WINDOW_MS;
}

function showTipAfterHoverIntent(anchor: HTMLElement) {
  if (anchor === shownAnchor || anchor === pendingAnchor) return;
  if (isWarm()) { showTip(anchor); return; }
  cancelPendingShow();
  pendingAnchor = anchor;
  pendingShowTimer = setTimeout(() => {
    cancelPendingShow();
    if (anchor.isConnected && anchor.dataset.tipLabel) showTip(anchor);
  }, HOVER_INTENT_DELAY_MS);
}

function isLeavingAnchor(anchor: HTMLElement | null, event: PointerEvent): boolean {
  if (!anchor) return false;
  return !(event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget));
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
    if (anchor) { showTipAfterHoverIntent(anchor); return; }
    hideTip();
  });
  document.addEventListener('pointerout', (event) => {
    if (!isLeavingAnchor(shownAnchor ?? pendingAnchor, event)) return;
    hideTip();
  });
  document.addEventListener('focusin', (event) => {
    const anchor = anchorOf(event.target);
    if (!anchor) { hideTip(); return; }
    if (!anchor.matches(':focus-visible')) return;
    cancelPendingShow();
    showTip(anchor);
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('pointerdown', hideTip);
  document.addEventListener('scroll', hideTip, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTip();
  });
}
