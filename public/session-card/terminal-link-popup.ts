import type { IBufferRange, Terminal } from '@xterm/xterm';
import type { LinkPreview } from '#shared/contracts/link-preview.ts';
import { el } from '../dom-helpers.ts';
import { fetchLinkPreview } from '../external-link.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { isStreamerMode } from '../streamer-mode.ts';
import { button } from '../ui/button.ts';
import type { SessionUi } from './card-registry.ts';
import { copyTextToClipboard } from './terminal-notices.ts';
import { decideHostMismatch, decidePopupPlacement, HIDDEN_POPUP, nextPopupState, splitUrlForDisplay } from './terminal-link-popup-core.ts';
import type { PopupEffect, PopupEvent, PopupState } from './terminal-link-popup-core.ts';
import './terminal-link-popup.css';

const SHOW_DELAY_MS = 100;
const HIDE_DELAY_MS = 150;
const PREVIEW_DWELL_MS = 600;
const PREVIEW_ICON_SIZE_PX = 16;
const SWALLOWED_POINTER_EVENTS = ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'wheel'] as const;

type HoveredLink = { url: string; linkText: string | null; range: IBufferRange };

export type TerminalLinkPopup = {
  enterLink(link: HoveredLink): void;
  leaveLink(): void;
};

type LoadedPreview = { url: string; preview: LinkPreview };

let isLinkPreviewEnabled = false;

export function setLinkPreviewsEnabled(isEnabled: boolean) {
  isLinkPreviewEnabled = isEnabled;
}

function buildUrlRow(url: string) {
  const row = el('div', 'terminal-link-popup-url');
  const parts = splitUrlForDisplay(url, isStreamerMode());
  if (!parts) {
    row.textContent = url;
    return row;
  }
  row.append(el('span', 'terminal-link-popup-url-dim', parts.scheme), el('strong', 'terminal-link-popup-host', parts.host), el('span', 'terminal-link-popup-url-dim', parts.rest));
  return row;
}

function buildMismatchRow(link: HoveredLink) {
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

export function createTerminalLinkPopup(term: Terminal, ui: SessionUi): TerminalLinkPopup {
  const terminalElement = term.element;
  const screenElement = terminalElement?.querySelector<HTMLElement>('.xterm-screen');
  if (!terminalElement || !screenElement) return { enterLink() {}, leaveLink() {} };
  const host: HTMLElement = terminalElement;
  const screen: HTMLElement = screenElement;
  const signal = ui.abortController.signal;

  const popup = el('div', 'xterm-hover terminal-link-popup');
  popup.hidden = true;
  host.append(popup);

  let state: PopupState = HIDDEN_POPUP;
  let hoveredLink: HoveredLink | null = null;
  let showTimerId: ReturnType<typeof setTimeout> | null = null;
  let hideTimerId: ReturnType<typeof setTimeout> | null = null;
  let dwellTimerId: ReturnType<typeof setTimeout> | null = null;
  let loadedPreview: LoadedPreview | null = null;
  let viewportTopAtRender = 0;

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
    if (event.key === 'Escape') dispatch('escape');
  }

  function place(link: HoveredLink) {
    const screenBounds = screen.getBoundingClientRect();
    const hostBounds = host.getBoundingClientRect();
    const viewportTop = term.buffer.active.viewportY;
    viewportTopAtRender = viewportTop;
    const placement = decidePopupPlacement({
      linkRange: {
        startRow: link.range.start.y - 1 - viewportTop,
        startCol: link.range.start.x - 1,
        endRow: link.range.end.y - 1 - viewportTop,
      },
      rows: term.rows,
      cellWidthPx: screenBounds.width / term.cols,
      cellHeightPx: screenBounds.height / term.rows,
      popupHeightPx: popup.offsetHeight,
      popupWidthPx: popup.offsetWidth,
      screenWidthPx: screenBounds.width,
    });
    popup.dataset.side = placement.side;
    popup.style.left = `${screenBounds.left - hostBounds.left + placement.leftPx}px`;
    popup.style.top = `${screenBounds.top - hostBounds.top + placement.topPx}px`;
  }

  function render() {
    const link = hoveredLink;
    if (!link) return;
    const footer = el('div', 'terminal-link-popup-footer');
    footer.append(
      el('span', 'terminal-link-popup-hint', 'Click to open'),
      button({ variant: 'secondary', size: 'small', label: 'Copy link', onClick: () => copyTextToClipboard(ui, link.url, 'link copy', 'Copied the link.') }),
    );
    const mismatchRow = buildMismatchRow(link);
    popup.replaceChildren(...[buildUrlRow(link.url), mismatchRow, buildPreviewRow(isLinkPreviewEnabled ? loadedPreview : null, link.url), footer].filter((row) => row !== null));
    popup.hidden = false;
    place(link);
    document.addEventListener('keydown', closeOnEscape, { capture: true, signal });
  }

  function remove() {
    popup.hidden = true;
    popup.replaceChildren();
    document.removeEventListener('keydown', closeOnEscape, { capture: true });
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
  const scrollSubscription = term.onScroll(() => {
    if (term.buffer.active.viewportY !== viewportTopAtRender) dispatch('escape');
  });
  const resizeSubscription = term.onResize(() => dispatch('escape'));
  signal.addEventListener('abort', () => {
    clearShowTimer();
    clearHideTimer();
    clearDwellTimer();
    scrollSubscription.dispose();
    resizeSubscription.dispose();
    popup.remove();
  }, { once: true });

  return {
    enterLink(link) {
      if (isPhoneLayout()) return;
      hoveredLink = link;
      dispatch('enter-link');
    },
    leaveLink() {
      dispatch('leave-link');
    },
  };
}
