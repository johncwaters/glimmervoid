import { fitTipLabel } from '../hover-tip-core.ts';
import { el, isRealInputOwningKey } from '../dom-helpers.ts';
import { createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';

export type SessionPagePlacement = 'overlay' | 'screen';

export interface SessionPage {
  id: string;
  label: string;
  iconPath: string;
  titleFor(sessionId: string): string;
  isAvailableFor(sessionId: string): boolean;
  hasUnreadFor(sessionId: string): boolean;
  mount(host: HTMLElement, sessionId: string, options: { placement: SessionPagePlacement; target: string | null }): void;
  unmount(): void;
  canStepBack(): boolean;
  stepBack(): void;
  attachButton?(button: HTMLElement, style: ButtonStyle): void;
}

export interface SessionPageHost {
  placement: SessionPagePlacement;
  sessionId(): string | null;
  elementFor(page: SessionPage): HTMLElement;
  didShow(page: SessionPage): void;
  didHide(page: SessionPage): void;
}

export type ButtonStyle = 'header' | 'phone';
type PageChangeListener = (pageId: string, sessionId: string | null) => void;

interface OpenPage {
  page: SessionPage;
  sessionId: string;
}

const pages: SessionPage[] = [];
const changeListeners = new Set<PageChangeListener>();
const hostsWithEscape = new WeakSet<HTMLElement>();
let host: SessionPageHost | null = null;
let openPage: OpenPage | null = null;

export function registerSessionPage(page: SessionPage) {
  if (pages.some((registered) => registered.id === page.id)) return;
  pages.push(page);
  announceSessionPageChange(page.id, null);
}

export function sessionPages(): readonly SessionPage[] {
  return pages;
}

export function announceSessionPageChange(pageId: string, sessionId: string | null) {
  for (const listener of changeListeners) listener(pageId, sessionId);
}

export function onSessionPageChange(listener: PageChangeListener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function setSessionPageHost(nextHost: SessionPageHost) {
  if (nextHost === host) return;
  closeSessionPage();
  host = nextHost;
}

export function releaseSessionPageHost(hostToRelease: SessionPageHost) {
  if (host !== hostToRelease) return;
  closeSessionPage();
  host = null;
}

export function isSessionPageOpen(pageId: string, sessionId: string) {
  return openPage?.page.id === pageId && openPage.sessionId === sessionId;
}

export function openSessionPage(pageId: string, sessionId: string, target: string | null = null) {
  const page = pages.find((registered) => registered.id === pageId);
  if (!page || !host || host.sessionId() !== sessionId || !page.isAvailableFor(sessionId)) return;
  if (isSessionPageOpen(pageId, sessionId) && target === null) return;
  closeSessionPage();
  const pageHost = host;
  const element = pageHost.elementFor(page);
  listenForEscape(element);
  openPage = { page, sessionId };
  page.mount(element, sessionId, { placement: pageHost.placement, target });
  pageHost.didShow(page);
  announceSessionPageChange(page.id, sessionId);
}

export function closeSessionPage() {
  if (!openPage) return;
  const { page, sessionId } = openPage;
  openPage = null;
  page.unmount();
  host?.didHide(page);
  announceSessionPageChange(page.id, sessionId);
}

export function canStepBackInSessionPage() {
  return openPage?.page.canStepBack() ?? false;
}

export function stepBackInSessionPage() {
  if (!openPage) return false;
  if (openPage.page.canStepBack()) {
    openPage.page.stepBack();
    return true;
  }
  closeSessionPage();
  return true;
}

function listenForEscape(element: HTMLElement) {
  if (hostsWithEscape.has(element)) return;
  hostsWithEscape.add(element);
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isRealInputOwningKey(event)) return;
    if (!stepBackInSessionPage()) return;
    event.preventDefault();
  });
}

interface PageButton {
  wrap: HTMLElement;
  control: HTMLButtonElement;
  dot: HTMLElement;
}

export function createSessionPageButtons({ style }: { style: ButtonStyle }) {
  const element = el('div', `session-page-bar session-page-bar-${style}`);
  const buttonByPageId = new Map<string, PageButton>();
  let shownSessionId: string | null = null;

  function buildButton(page: SessionPage): PageButton {
    const isHeader = style === 'header';
    const control = button({
      variant: 'icon',
      size: isHeader ? 'small' : 'default',
      label: fitTipLabel(page.label),
      icon: createLineIcon(page.iconPath),
      action: `${isHeader ? 'open' : 'show'}-${page.id}`,
    });
    control.addEventListener('click', () => {
      if (shownSessionId) openSessionPage(page.id, shownSessionId);
    });
    const dot = el('span', 'session-page-dot');
    dot.setAttribute('aria-hidden', 'true');
    const wrap = el('span', 'session-page-button');
    wrap.dataset.page = page.id;
    wrap.append(control, dot);
    element.append(wrap);
    page.attachButton?.(wrap, style);
    return { wrap, control, dot };
  }

  function paint(page: SessionPage) {
    const pageButton = buttonByPageId.get(page.id) ?? buildButton(page);
    buttonByPageId.set(page.id, pageButton);
    const isAvailable = shownSessionId !== null && page.isAvailableFor(shownSessionId);
    pageButton.wrap.toggleAttribute('data-slot-held', !isAvailable);
    pageButton.dot.hidden = !isAvailable || !shownSessionId || !page.hasUnreadFor(shownSessionId);
    const title = shownSessionId ? page.titleFor(shownSessionId) : '';
    pageButton.control.toggleAttribute('title', title !== '');
    if (title !== '') pageButton.control.title = title;
  }

  function paintAll() {
    for (const page of pages) paint(page);
  }

  onSessionPageChange((pageId, sessionId) => {
    if (sessionId !== null && sessionId !== shownSessionId) return;
    const page = pages.find((registered) => registered.id === pageId);
    if (page) paint(page);
  });
  paintAll();

  return {
    element,
    showSession(sessionId: string | null) {
      shownSessionId = sessionId;
      paintAll();
    },
  };
}
