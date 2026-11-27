import type { IBufferRange, Terminal } from '@xterm/xterm';
import type { LinkPreview } from '#shared/contracts/link-preview.ts';
import { packNameOfApprovalUrl } from '#shared/pack-approval.ts';
import { el } from '../dom-helpers.ts';
import { fetchLinkPreview } from '../external-link.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { buildPackApprovalContent } from '../packs/pack-approval-content.ts';
import { watchPacksCollection } from '../state/collections/packs.ts';
import { button } from '../ui/button.ts';
import { isModalOpen } from '../ui/modal-state.ts';
import type { SessionUi } from './card-registry.ts';
import { copyTextToClipboard } from './terminal-notices.ts';
import { decideHostMismatch, decidePopupPlacement, HIDDEN_POPUP, nextPopupState, roomBesideAnchorPx, splitUrlForDisplay } from './terminal-link-popup-core.ts';
import type { AnchorBox, PopupEffect, PopupEvent, PopupState } from './terminal-link-popup-core.ts';
import './terminal-link-popup.css';

const SHOW_DELAY_MS = 100;
const HIDE_DELAY_MS = 150;
const PREVIEW_DWELL_MS = 600;
const PREVIEW_ICON_SIZE_PX = 16;
const SWALLOWED_POINTER_EVENTS = ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'wheel'] as const;

type HoveredLink<Anchor> = { url: string; linkText: string | null; anchor: Anchor };

type LinkPopup<Anchor> = {
  enterLink(link: HoveredLink<Anchor>): void;
  leaveLink(): void;
  pinLink(link: HoveredLink<Anchor>): void;
  close(): void;
};

export type TerminalLinkPopup = LinkPopup<IBufferRange>;

type LinkPopupHost<Anchor> = {
  host: HTMLElement;
  boundsBoxOf(): DOMRect;
  anchorBoxOf(anchor: Anchor): AnchorBox | null;
  copyControlOf(url: string): HTMLElement;
  extraClassName?: string;
  signal?: AbortSignal;
};

type LoadedPreview = { url: string; preview: LinkPreview };

let isLinkPreviewEnabled = false;

export function setLinkPreviewsEnabled(isEnabled: boolean) {
  isLinkPreviewEnabled = isEnabled;
}

function buildUrlRow(url: string) {
  const row = el('div', 'terminal-link-popup-url');
  const parts = splitUrlForDisplay(url);
  if (!parts) {
    row.textContent = url;
    return row;
  }
  row.append(el('span', 'terminal-link-popup-url-dim', parts.scheme), el('strong', 'terminal-link-popup-host', parts.host), el('span', 'terminal-link-popup-url-dim', parts.rest));
  return row;
}

function buildMismatchRow(link: HoveredLink<unknown>) {
  if (link.linkText === null) return null;
  const mismatch = decideHostMismatch(link.linkText, link.url);
  if (!mismatch) return null;
  const row = el('div', 'terminal-link-popup-mismatch');
  row.append('Text says ', el('strong', null, mismatch.textHost), ', goes to ', el('strong', null, mismatch.targetHost));
  return row;
}

function buildPreviewRow(loadedPreview: LoadedPreview | null, url: string) {
  if (!loadedPreview || loadedPreview.url !== url) return null;
  const { title, iconDataUrl } = loadedPreview.preview;
  if (!title && !iconDataUrl) return null;
  const row = el('div', 'terminal-link-popup-preview');
  if (iconDataUrl) {
    const icon = el('img', 'terminal-link-popup-icon');
    icon.src = iconDataUrl;
    icon.alt = '';
    icon.width = PREVIEW_ICON_SIZE_PX;
    icon.height = PREVIEW_ICON_SIZE_PX;
    row.append(icon);
  }
  if (title) row.append(el('span', 'terminal-link-popup-title', title));
  return row;
}

export function createLinkPopup<Anchor>(popupHost: LinkPopupHost<Anchor>): LinkPopup<Anchor> {
  const { host, boundsBoxOf, anchorBoxOf, copyControlOf } = popupHost;
  const { signal } = popupHost;

  const popup = el('div', `${popupHost.extraClassName ?? ''} terminal-link-popup`.trim());
  popup.hidden = true;
  host.append(popup);

  let state: PopupState = HIDDEN_POPUP;
  let hoveredLink: HoveredLink<Anchor> | null = null;
  let showTimerId: ReturnType<typeof setTimeout> | null = null;
  let hideTimerId: ReturnType<typeof setTimeout> | null = null;
  let dwellTimerId: ReturnType<typeof setTimeout> | null = null;
  let loadedPreview: LoadedPreview | null = null;
  let stopRepaintingOnPacksChange: (() => void) | null = null;

  function clearShowTimer() {
    if (showTimerId === null) return;
    clearTimeout(showTimerId);
    showTimerId = null;
  }

  function clearHideTimer() {
    if (hideTimerId === null) return;
    clearTimeout(hideTimerId);
    hideTimerId = null;
  }

  function clearDwellTimer() {
    if (dwellTimerId === null) return;
    clearTimeout(dwellTimerId);
    dwellTimerId = null;
  }

  function fetchPreviewForHoveredLink() {
    const url = hoveredLink?.url;
    if (!isLinkPreviewEnabled || !url) return;
    void fetchLinkPreview(url).then((preview) => {
      if (!isLinkPreviewEnabled) return;
      loadedPreview = { url, preview };
      if (state.phase === 'shown' && hoveredLink?.url === url) render();
    });
  }

  function closeOnEscape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented || isModalOpen()) return;
    dispatch('escape');
  }

  function anchorWithinBounds(link: HoveredLink<Anchor>) {
    const anchorBox = anchorBoxOf(link.anchor);
    if (!anchorBox) return null;
    const boundsBox = boundsBoxOf();
    return {
      boundsBox,
      anchor: { topPx: anchorBox.topPx - boundsBox.top, bottomPx: anchorBox.bottomPx - boundsBox.top, leftPx: anchorBox.leftPx - boundsBox.left },
    };
  }

  function place(link: HoveredLink<Anchor>) {
    const measured = anchorWithinBounds(link);
    if (!measured) return;
    const hostBox = host.getBoundingClientRect();
    const placement = decidePopupPlacement({
      anchor: measured.anchor,
      boundsHeightPx: measured.boundsBox.height,
      boundsWidthPx: measured.boundsBox.width,
      popupHeightPx: popup.offsetHeight,
      popupWidthPx: popup.offsetWidth,
    });
    popup.dataset.side = placement.side;
    popup.style.left = `${measured.boundsBox.left - hostBox.left + placement.leftPx}px`;
    popup.style.top = `${measured.boundsBox.top - hostBox.top + placement.topPx}px`;
  }

  function hoveredPackName() {
    return hoveredLink === null ? null : packNameOfApprovalUrl(hoveredLink.url, location.host);
  }

  function repaintWhileShown() {
    if (state.phase === 'shown') render();
  }

  function capHeightToRoomBesideLink(link: HoveredLink<Anchor>) {
    const measured = anchorWithinBounds(link);
    if (!measured) return;
    popup.style.maxHeight = `${roomBesideAnchorPx(measured.anchor, measured.boundsBox.height)}px`;
  }

  function renderPackApproval(link: HoveredLink<Anchor>, packName: string) {
    popup.dataset.kind = 'pack';
    popup.replaceChildren(buildPackApprovalContent(packName, { close: () => dispatch('escape'), repaint: repaintWhileShown }));
    popup.hidden = false;
    capHeightToRoomBesideLink(link);
    place(link);
    document.addEventListener('keydown', closeOnEscape, { capture: true, signal });
    document.addEventListener('pointerdown', closeOnOutsidePointer, { capture: true, signal });
  }

  function closeOnOutsidePointer(event: PointerEvent) {
    if (!state.isPinned || !(event.target instanceof Node) || popup.contains(event.target)) return;
    dispatch('escape');
  }

  function repaintPackApprovalOnPacksChange() {
    if (state.phase === 'shown' && hoveredPackName() !== null) render();
  }

  function render() {
    const link = hoveredLink;
    if (!link) return;
    stopRepaintingOnPacksChange ??= watchPacksCollection(repaintPackApprovalOnPacksChange);
    const packName = hoveredPackName();
    if (packName !== null) {
      renderPackApproval(link, packName);
      return;
    }
    delete popup.dataset.kind;
    popup.style.removeProperty('max-height');
    const footer = el('div', 'terminal-link-popup-footer');
    footer.append(el('span', 'terminal-link-popup-hint', 'Click to open'), copyControlOf(link.url));
    const mismatchRow = buildMismatchRow(link);
    popup.replaceChildren(...[buildUrlRow(link.url), mismatchRow, buildPreviewRow(isLinkPreviewEnabled ? loadedPreview : null, link.url), footer].filter((row) => row !== null));
    popup.hidden = false;
    place(link);
    document.addEventListener('keydown', closeOnEscape, { capture: true, signal });
  }

  function remove() {
    stopRepaintingOnPacksChange?.();
    stopRepaintingOnPacksChange = null;
    popup.hidden = true;
    popup.replaceChildren();
    document.removeEventListener('keydown', closeOnEscape, { capture: true });
    document.removeEventListener('pointerdown', closeOnOutsidePointer, { capture: true });
  }

  const effectRunners: Record<PopupEffect, () => void> = {
    'schedule-show': () => {
      clearShowTimer();
      showTimerId = setTimeout(() => { showTimerId = null; dispatch('show-timer'); }, SHOW_DELAY_MS);
    },
    'cancel-show': clearShowTimer,
    'schedule-hide': () => {
      clearHideTimer();
      hideTimerId = setTimeout(() => { hideTimerId = null; dispatch('hide-timer'); }, HIDE_DELAY_MS);
    },
    'cancel-hide': clearHideTimer,
    'schedule-dwell': () => {
      clearDwellTimer();
      dwellTimerId = setTimeout(() => { dwellTimerId = null; dispatch('dwell-timer'); }, PREVIEW_DWELL_MS);
    },
    'cancel-dwell': clearDwellTimer,
    'fetch-preview': fetchPreviewForHoveredLink,
    render,
    remove,
  };

  function dispatch(event: PopupEvent) {
    const transition = nextPopupState(state, event);
    state = transition.state;
    for (const effect of transition.effects) effectRunners[effect]();
  }

  for (const eventName of SWALLOWED_POINTER_EVENTS) {
    popup.addEventListener(eventName, (event) => event.stopPropagation(), { signal });
  }
  popup.addEventListener('mouseenter', () => dispatch('enter-popup'), { signal });
  popup.addEventListener('mouseleave', () => dispatch('leave-popup'), { signal });
  signal?.addEventListener('abort', () => {
    clearShowTimer();
    clearHideTimer();
    clearDwellTimer();
    stopRepaintingOnPacksChange?.();
    popup.remove();
  }, { once: true });

  return {
    enterLink(link) {
      if (isPhoneLayout() || state.isPinned) return;
      hoveredLink = link;
      dispatch('enter-link');
    },
    pinLink(link) {
      hoveredLink = link;
      dispatch('pin');
    },
    leaveLink() {
      dispatch('leave-link');
    },
    close() {
      dispatch('escape');
    },
  };
}

function terminalAnchorBoxOf(term: Terminal, screen: HTMLElement, range: IBufferRange): AnchorBox {
  const screenBox = screen.getBoundingClientRect();
  const cellWidthPx = screenBox.width / term.cols;
  const cellHeightPx = screenBox.height / term.rows;
  const viewportTop = term.buffer.active.viewportY;
  return {
    topPx: screenBox.top + (range.start.y - 1 - viewportTop) * cellHeightPx,
    bottomPx: screenBox.top + (range.end.y - viewportTop) * cellHeightPx,
    leftPx: screenBox.left + (range.start.x - 1) * cellWidthPx,
  };
}

export function createTerminalLinkPopup(term: Terminal, ui: SessionUi): TerminalLinkPopup {
  const terminalElement = term.element;
  const screenElement = terminalElement?.querySelector<HTMLElement>('.xterm-screen');
  if (!terminalElement || !screenElement) return { enterLink() {}, leaveLink() {}, pinLink() {}, close() {} };
  const screen: HTMLElement = screenElement;
  const linkPopup = createLinkPopup<IBufferRange>({
    host: terminalElement,
    boundsBoxOf: () => screen.getBoundingClientRect(),
    anchorBoxOf: (range) => terminalAnchorBoxOf(term, screen, range),
    copyControlOf: (url) => button({ variant: 'secondary', size: 'small', label: 'Copy link', onClick: () => copyTextToClipboard(ui, url, 'link copy', 'Copied the link.') }),
    extraClassName: 'xterm-hover',
    signal: ui.abortController.signal,
  });
  let viewportTopSeen = term.buffer.active.viewportY;
  const scrollSubscription = term.onScroll(() => {
    const viewportTop = term.buffer.active.viewportY;
    if (viewportTop === viewportTopSeen) return;
    viewportTopSeen = viewportTop;
    linkPopup.close();
  });
  const resizeSubscription = term.onResize(() => linkPopup.close());
  ui.abortController.signal.addEventListener('abort', () => {
    scrollSubscription.dispose();
    resizeSubscription.dispose();
  }, { once: true });
  return linkPopup;
}
