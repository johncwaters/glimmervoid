import type { AdoptableElement } from '../dom-helpers.ts';
import { adoptElement, el, releaseElement } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import { jumpTargetCount, pickStrongestAttention } from '../focus-view/attention-core.ts';
import { getRestorableSessionId, isSessionShown, requestSessionOpen, selectSession } from '../session-actions.ts';
import { addActivityRenderer } from '../session-card/activity.ts';
import { attentionTally, sessionName, sessionUIs } from '../session-card/card-registry.ts';
import { showSessionPlanFace } from '../session-card/card-faces.ts';
import { registerSessionPages } from '../session-pages/pages.ts';
import type { SessionPage, SessionPageHost } from '../session-pages/session-pages.ts';
import { canStepBackInSessionPage, closeSessionPage, isSessionPageOpen, onSessionPageChange, openSessionPage, releaseSessionPageHost, sessionPages, setSessionPageHost, stepBackInSessionPage } from '../session-pages/session-pages.ts';
import { BACK_ICON_PATH, createLineIcon, FOCUS_ICON_PATH, MORE_ICON_PATH, TERMINAL_ICON_PATH } from '../svg-dom.ts';
import { uiState } from '../ui-state-core.ts';
import { createBoardScreen } from './board-screen.ts';
import type { PhonePanel } from './phone-panels-core.ts';
import { createTerminalScreen } from './terminal-screen.ts';

const BOARD = 'board';
const TERMINAL = 'terminal';

interface PhoneScreenSpec {
  id: string;
  label: string;
  iconPath: string;
}

interface PhoneShellHooks {
  headerControls?: AdoptableElement[];
  panels?: PhonePanel<HTMLElement>[];
  onScreenShown?: (screenId: string) => void;
  canGoBack?: (screenId: string) => boolean;
  onBack?: (screenId: string) => void;
}

const NAV_SCREENS: readonly PhoneScreenSpec[] = Object.freeze([
  { id: BOARD, label: 'Focus', iconPath: FOCUS_ICON_PATH },
  { id: TERMINAL, label: 'Terminal', iconPath: TERMINAL_ICON_PATH },
]);
let panels: PhonePanel<AdoptableElement>[] = [];
const panelMountElById = new Map<string, HTMLDivElement>();
let shellEl: HTMLDivElement | null = null;
const navButtonById = new Map<string, HTMLButtonElement>();
const screenElById = new Map<string, HTMLElement>();
const screenAttentionById = new Map<string, string | boolean>();
let boardScreen: ReturnType<typeof createBoardScreen> | null = null;
let terminalScreen: ReturnType<typeof createTerminalScreen> | null = null;
const pageMountElById = new Map<string, HTMLDivElement>();
const pageSessionNameEls: HTMLSpanElement[] = [];
let moreButtonEl: HTMLButtonElement | null = null;
let moreMenuEl: HTMLDivElement | null = null;
const menuButtonById = new Map<string, HTMLButtonElement>();
const unavailableScreenIds = new Set<string>();
let hooks: PhoneShellHooks = {};
let active = false;
let isBoardStale = false;
const SOFT_KEYBOARD_OPEN_DELTA_PX = 120;
let keyboardClosedBaselineHeightPx = 0;
let baselineViewportWidthPx = 0;
let pushedHistoryDepth = 0;
let urlAwaitingOwnHistoryPop: string | null = null;

function resetSoftKeyboardBaseline() {
  keyboardClosedBaselineHeightPx = 0;
  baselineViewportWidthPx = 0;
}

function syncVisualViewport() {
  const viewport = window.visualViewport;
  if (!shellEl) return;
  if (!active || !viewport) {
    shellEl.removeAttribute('data-keyboard');
    return;
  }
  shellEl.style.setProperty('--phone-vh', `${viewport.height}px`);
  shellEl.style.setProperty('--phone-vv-top', `${viewport.offsetTop}px`);
  if (viewport.width !== baselineViewportWidthPx) {
    baselineViewportWidthPx = viewport.width;
    keyboardClosedBaselineHeightPx = 0;
  }
  keyboardClosedBaselineHeightPx = Math.max(keyboardClosedBaselineHeightPx, viewport.height);
  if (keyboardClosedBaselineHeightPx - viewport.height > SOFT_KEYBOARD_OPEN_DELTA_PX) {
    shellEl.dataset.keyboard = 'open';
    return;
  }
  shellEl.removeAttribute('data-keyboard');
}

function buildNavButton(label: string, iconPath: string, itemClass = 'phone-nav-item', dotClass = 'phone-nav-dot') {
  const btn = createPressable(itemClass);
  const glyphEl = el('span', 'phone-nav-glyph');
  glyphEl.appendChild(createLineIcon(iconPath));
  glyphEl.setAttribute('aria-hidden', 'true');
  btn.append(glyphEl, el('span', 'phone-nav-label', label));
  const dot = el('span', dotClass);
  dot.setAttribute('aria-hidden', 'true');
  dot.hidden = true;
  btn.appendChild(dot);
  return btn;
}

function dotOf(button: HTMLElement | null | undefined) {
  return button?.querySelector<HTMLElement>('.phone-nav-dot') || null;
}

function applyDotAttention(dot: HTMLElement | null, attention: string | boolean) {
  if (!dot) return;
  dot.hidden = !attention;
  if (typeof attention === 'string') dot.dataset.attention = attention;
  if (typeof attention !== 'string') delete dot.dataset.attention;
}

function syncMoreAttention() {
  const nestedLevels: (string | boolean)[] = [];
  for (const panel of panels) {
    if (unavailableScreenIds.has(panel.id)) continue;
    const attention = screenAttentionById.get(panel.id) || false;
    if (panel.isNavScreen) {
      applyDotAttention(dotOf(navButtonById.get(panel.id)), attention);
      continue;
    }
    nestedLevels.push(attention);
    applyDotAttention(dotOf(menuButtonById.get(panel.id)), attention);
  }
  applyDotAttention(dotOf(moreButtonEl), pickStrongestAttention(nestedLevels));
}

function buildMoreMenu() {
  const menu = el('div', 'phone-nav-more-menu');
  menu.hidden = true;
  for (const panel of panels) {
    if (panel.isNavScreen) continue;
    const btn = buildNavButton(panel.label, panel.iconPath, 'phone-nav-menu-item', 'phone-nav-dot phone-nav-menu-dot');
    btn.dataset.screen = panel.id;
    btn.hidden = unavailableScreenIds.has(panel.id);
    btn.addEventListener('click', () => {
      setMoreMenuOpen(false);
      showScreen(panel.id);
    });
    menuButtonById.set(panel.id, btn);
    menu.appendChild(btn);
  }
  return menu;
}

function setMoreMenuOpen(isOpen: boolean) {
  if (!moreMenuEl || !moreButtonEl) return;
  moreMenuEl.hidden = !isOpen;
  moreButtonEl.setAttribute('aria-expanded', String(isOpen));
}

function isMoreMenuOpen() {
  return !!moreMenuEl && !moreMenuEl.hidden;
}

function buildNav() {
  const nav = el('nav', 'phone-nav');
  nav.setAttribute('aria-label', 'Screens');
  for (const screen of NAV_SCREENS) {
    const btn = buildNavButton(screen.label, screen.iconPath);
    btn.dataset.screen = screen.id;
    btn.addEventListener('click', () => {
      if (screen.id === TERMINAL && uiState.snapshot().phoneScreen === TERMINAL) showTerminalFaceOfShownSession();
      showScreen(screen.id);
    });
    navButtonById.set(screen.id, btn);
    nav.appendChild(btn);
  }
  for (const panel of panels) {
    if (!panel.isNavScreen) continue;
    const btn = buildNavButton(panel.label, panel.iconPath);
    btn.dataset.screen = panel.id;
    btn.hidden = unavailableScreenIds.has(panel.id);
    btn.addEventListener('click', () => showScreen(panel.id));
    navButtonById.set(panel.id, btn);
    nav.appendChild(btn);
  }
  moreButtonEl = buildNavButton('More', MORE_ICON_PATH);
  moreButtonEl.setAttribute('aria-expanded', 'false');
  moreButtonEl.addEventListener('click', () => setMoreMenuOpen(!isMoreMenuOpen()));
  nav.appendChild(moreButtonEl);
  moreMenuEl = buildMoreMenu();
  nav.appendChild(moreMenuEl);
  return nav;
}

function wrapScreen(id: string, label: string, contentEl: HTMLElement | null | undefined) {
  const section = el('section', 'phone-screen');
  section.dataset.screen = id;
  section.setAttribute('aria-label', label);
  section.hidden = true;
  if (contentEl) section.appendChild(contentEl);
  screenElById.set(id, section);
  return section;
}

function build() {
  if (shellEl) return;

  boardScreen = createBoardScreen({ onSelectSession: openSession, shownSessionId: () => terminalScreen?.getSessionId() ?? null });
  addActivityRenderer((ui, kind) => { if (active) boardScreen?.renderActivity(ui, kind); });
  registerSessionPages();
  terminalScreen = createTerminalScreen({ onBack: () => showScreen(BOARD) });
  onSessionPageChange(syncPhoneHistory);

  const screens = el('div', 'phone-screens');
  const contentByScreenId: Record<string, HTMLElement | null> = {
    [BOARD]: boardScreen.el,
    [TERMINAL]: terminalScreen.el,
  };
  for (const screen of NAV_SCREENS) {
    screens.appendChild(wrapScreen(screen.id, screen.label, contentByScreenId[screen.id]));
  }
  for (const page of sessionPages()) screens.appendChild(wrapScreen(page.id, page.label, buildPageScreen(page)));
  for (const panel of panels) {
    const mountEl = el('div', `phone-panel phone-${panel.id}`);
    panelMountElById.set(panel.id, mountEl);
    screens.appendChild(wrapScreen(panel.id, panel.label, mountEl));
  }

  shellEl = el('div', 'phone-shell');
  shellEl.id = 'phone-shell';
  shellEl.append(screens, buildNav());
  document.body.appendChild(shellEl);
  syncMoreAttention();

  window.visualViewport?.addEventListener('resize', syncVisualViewport);
  window.visualViewport?.addEventListener('scroll', syncVisualViewport);
  window.addEventListener('popstate', onPopState);
  document.addEventListener('click', (event) => {
    if (!isMoreMenuOpen()) return;
    if (!moreMenuEl || !moreButtonEl || !(event.target instanceof Node)) return;
    if (moreMenuEl.contains(event.target) || moreButtonEl.contains(event.target)) return;
    setMoreMenuOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isMoreMenuOpen()) setMoreMenuOpen(false);
  });
}

function buildPageScreen(page: SessionPage) {
  const pageScreen = el('div', 'phone-page-screen');
  const topBar = el('header', 'phone-topbar phone-page-bar');
  const backButton = button({ variant: 'icon', label: 'Back', icon: createLineIcon(BACK_ICON_PATH), action: 'back-to-terminal', onClick: goBackFromPage });
  const sessionNameEl = el('span', 'phone-page-session');
  pageSessionNameEls.push(sessionNameEl);
  const mountEl = el('div', `phone-page phone-page-${page.id}`);
  pageMountElById.set(page.id, mountEl);
  topBar.append(backButton, el('span', 'phone-page-title', page.label), sessionNameEl);
  pageScreen.append(topBar, mountEl);
  return pageScreen;
}

function goBackFromPage() {
  if (!stepBackInSessionPage()) showScreen(TERMINAL);
}

function isPageScreen(screenId: string) {
  return pageMountElById.has(screenId);
}

const phonePageHost: SessionPageHost = {
  placement: 'screen',
  sessionId: () => terminalScreen?.getSessionId() ?? null,
  elementFor: (page) => {
    const mountEl = pageMountElById.get(page.id);
    if (!mountEl) throw new Error(`Phone page ${page.id} is not built`);
    return mountEl;
  },
  didShow: (page) => {
    if (uiState.snapshot().phoneScreen !== page.id) showScreen(page.id);
  },
  didHide: (page) => {
    if (uiState.snapshot().phoneScreen === page.id) showScreen(TERMINAL);
  },
};

function openSession(sessionId: string) {
  if (!sessionUIs.has(sessionId)) return;
  if (!boardScreen || !terminalScreen) throw new Error('Phone shell is not built');
  requestSessionOpen(sessionId, 'dormant-fallback');
  selectSession(sessionId);
  terminalScreen.show(sessionId);
  isBoardStale = true;
  showScreen(TERMINAL);
}

interface PhoneHistoryState {
  glimmervoidScreen?: unknown;
  glimmervoidNested?: unknown;
  glimmervoidDepth?: unknown;
}

function rootScreenOf(screenId: string) {
  return isPageScreen(screenId) ? TERMINAL : screenId;
}

function historyStateFor(screenId: string, depth: number) {
  if (depth > 1) return { glimmervoidScreen: screenId, glimmervoidNested: true, glimmervoidDepth: depth };
  return { glimmervoidScreen: rootScreenOf(screenId) };
}

function screenIdFromHistoryState(state: unknown): string | null {
  const named = (state as PhoneHistoryState | null)?.glimmervoidScreen;
  return typeof named === 'string' ? named : null;
}

function historyDepthOf(state: unknown) {
  if (!screenIdFromHistoryState(state)) return 0;
  const { glimmervoidDepth, glimmervoidNested } = state as PhoneHistoryState;
  if (typeof glimmervoidDepth === 'number' && Number.isInteger(glimmervoidDepth) && glimmervoidDepth > 1) return glimmervoidDepth;
  return glimmervoidNested === true ? 2 : 1;
}

function canGoBackWithin(screenId: string) {
  if (isPageScreen(screenId)) return canStepBackInSessionPage();
  return hooks.canGoBack?.(screenId) ?? false;
}

function goBackWithin(screenId: string) {
  if (isPageScreen(screenId)) {
    stepBackInSessionPage();
    return;
  }
  hooks.onBack?.(screenId);
}

function desiredHistoryDepth(screenId: string) {
  if (screenId === BOARD) return 0;
  const screenDepth = isPageScreen(screenId) ? 2 : 1;
  return canGoBackWithin(screenId) ? screenDepth + 1 : screenDepth;
}

function isCurrentHistoryStateFor(screenId: string, depth: number) {
  const expectedScreenId = depth > 1 ? screenId : rootScreenOf(screenId);
  return screenIdFromHistoryState(history.state) === expectedScreenId && historyDepthOf(history.state) === depth;
}

export function syncPhoneHistory() {
  if (!active || urlAwaitingOwnHistoryPop !== null) return;
  const screenId = uiState.snapshot().phoneScreen || BOARD;
  const desiredDepth = desiredHistoryDepth(screenId);
  if (pushedHistoryDepth > desiredDepth) {
    urlAwaitingOwnHistoryPop = location.href;
    history.go(desiredDepth - pushedHistoryDepth);
    pushedHistoryDepth = desiredDepth;
    return;
  }
  if (pushedHistoryDepth > 0 && !isCurrentHistoryStateFor(screenId, pushedHistoryDepth)) history.replaceState(historyStateFor(screenId, pushedHistoryDepth), '');
  while (pushedHistoryDepth < desiredDepth) {
    pushedHistoryDepth += 1;
    history.pushState(historyStateFor(screenId, pushedHistoryDepth), '');
  }
}

function adoptInheritedHistory() {
  const inherited = screenIdFromHistoryState(history.state);
  if (inherited && canShowScreen(inherited)) {
    pushedHistoryDepth = historyDepthOf(history.state);
    return inherited;
  }
  if (inherited) history.replaceState(null, '');
  pushedHistoryDepth = 0;
  return BOARD;
}

function onPopState(event: PopStateEvent) {
  if (!active) return;
  if (urlAwaitingOwnHistoryPop !== null) {
    history.replaceState(history.state, '', urlAwaitingOwnHistoryPop);
    urlAwaitingOwnHistoryPop = null;
    syncPhoneHistory();
    return;
  }
  const target = screenIdFromHistoryState(event.state);
  const targetScreenId = target && canShowScreen(target) ? target : BOARD;
  pushedHistoryDepth = historyDepthOf(event.state);
  const currentScreenId = uiState.snapshot().phoneScreen;
  const isLeavingNestedScreen = targetScreenId === currentScreenId && canGoBackWithin(currentScreenId) && pushedHistoryDepth < desiredHistoryDepth(currentScreenId);
  if (isLeavingNestedScreen) goBackWithin(currentScreenId);
  applyScreen(targetScreenId);
  syncPhoneHistory();
}

function syncCurrent(buttonById: Map<string, HTMLElement>, screenId: string) {
  for (const [id, btn] of buttonById) {
    if (id === screenId) {
      btn.setAttribute('aria-current', 'page');
      continue;
    }
    btn.removeAttribute('aria-current');
  }
}

function openPhonePage(pageId: string) {
  const sessionId = terminalScreen?.getSessionId();
  if (!sessionId) return false;
  openSessionPage(pageId, sessionId);
  return isSessionPageOpen(pageId, sessionId);
}

function applyScreen(requestedScreenId: string) {
  if (!moreButtonEl || !terminalScreen) throw new Error('Phone shell is not built');
  uiState.dispatch('setPhoneScreen', requestedScreenId);
  const isPageOpened = isPageScreen(requestedScreenId) && openPhonePage(requestedScreenId);
  const screenId = isPageScreen(requestedScreenId) && !isPageOpened ? TERMINAL : requestedScreenId;
  if (screenId !== requestedScreenId) uiState.dispatch('setPhoneScreen', screenId);
  if (!isPageScreen(screenId)) closeSessionPage();
  setMoreMenuOpen(false);
  paintPageSessionName();
  for (const [id, section] of screenElById) {
    section.hidden = id !== screenId;
  }
  if (screenId === BOARD && isBoardStale) {
    isBoardStale = false;
    boardScreen?.refresh();
  }
  hooks.onScreenShown?.(screenId);
  syncCurrent(navButtonById, rootScreenOf(screenId));
  const isNestedActive = menuButtonById.has(screenId);
  if (isNestedActive) moreButtonEl.setAttribute('aria-current', 'page');
  if (!isNestedActive) moreButtonEl.removeAttribute('aria-current');
  syncCurrent(menuButtonById, screenId);
  if (screenId === TERMINAL) {
    terminalScreen.reveal();
    return;
  }
  terminalScreen.unview();
}

function showTerminalFaceOfShownSession() {
  const shownSessionId = terminalScreen?.getSessionId();
  if (!shownSessionId) return;
  sessionUIs.get(shownSessionId)?._showTerminalFace?.();
}

function canShowScreen(screenId: string) {
  return screenElById.has(screenId) && !unavailableScreenIds.has(screenId);
}

function paintPageSessionName() {
  if (!terminalScreen) return;
  const shownSessionId = terminalScreen.getSessionId();
  const shownSessionUi = shownSessionId ? sessionUIs.get(shownSessionId) : null;
  const name = shownSessionUi ? sessionName(shownSessionUi) : '';
  for (const sessionNameEl of pageSessionNameEls) {
    sessionNameEl.textContent = name;
    sessionNameEl.title = name;
  }
}

function showScreen(screenId: string) {
  if (!shellEl || !canShowScreen(screenId)) return;
  applyScreen(screenId);
  syncPhoneHistory();
}

export function orderPhonePanels(orderedViewIds: readonly string[]) {
  panels.sort((first, second) => orderedViewIds.indexOf(first.id) - orderedViewIds.indexOf(second.id));
  moreMenuEl?.append(...panels.flatMap((panel) => menuButtonById.get(panel.id) ?? []));
}

export function mountPhoneShell(options?: PhoneShellHooks) {
  hooks = options || {};
  panels = hooks.panels || [];
}

export function activatePhoneShell({ sessionId, linkedScreenId }: { sessionId?: string; linkedScreenId?: string } = {}) {
  if (active) return;
  build();
  if (!shellEl || !boardScreen || !terminalScreen) throw new Error('Phone shell is not built');
  active = true;
  shellEl.hidden = false;
  for (const control of (hooks.headerControls || [])) adoptElement(control, boardScreen.topBarEl);
  setSessionPageHost(phonePageHost);
  for (const panel of panels) {
    adoptElement(panel.el, panelMountElById.get(panel.id));
    panel.el.hidden = false;
  }
  syncVisualViewport();
  if (sessionId) terminalScreen.show(sessionId);
  const startScreen = adoptInheritedHistory();
  refreshPhoneBoard();
  if (linkedScreenId && canShowScreen(linkedScreenId)) {
    showScreen(linkedScreenId);
    return;
  }
  if (sessionId && startScreen === BOARD) {
    showScreen(TERMINAL);
    return;
  }
  applyScreen(startScreen);
  syncPhoneHistory();
}

export function deactivatePhoneShell() {
  if (!active) return;
  if (!shellEl || !terminalScreen) throw new Error('Phone shell is not built');
  active = false;
  terminalScreen.clear();
  releaseSessionPageHost(phonePageHost);
  for (const panel of panels) releaseElement(panel.el);
  for (const control of (hooks.headerControls || [])) releaseElement(control);
  setMoreMenuOpen(false);
  shellEl.hidden = true;
  shellEl.removeAttribute('data-keyboard');
  resetSoftKeyboardBaseline();
  if (pushedHistoryDepth > 0) history.go(-pushedHistoryDepth);
  pushedHistoryDepth = 0;
  urlAwaitingOwnHistoryPop = null;
}

export function showPhonePlan(sessionId: string) {
  if (!active || !boardScreen || !terminalScreen) return false;
  if (!sessionUIs.has(sessionId)) return false;
  openSession(sessionId);
  return showSessionPlanFace(sessionId);
}

export function isPhoneShellActive() {
  return active;
}

export function getPhoneSessionId() {
  return active && terminalScreen ? terminalScreen.getSessionId() : null;
}

export function refreshPhoneBoard() {
  if (!active) return;
  if (!boardScreen || !terminalScreen) throw new Error('Phone shell is not built');
  restoreShownSession();
  const visibleRootScreen = rootScreenOf(uiState.snapshot().phoneScreen || BOARD);
  isBoardStale = visibleRootScreen !== BOARD;
  if (!isBoardStale) boardScreen.refresh();
  terminalScreen.refresh();
  paintPageSessionName();
  const terminalSessionId = terminalScreen.getSessionId();
  const isTerminalSessionGone = !terminalSessionId || !isSessionShown(terminalSessionId);
  if (visibleRootScreen === TERMINAL && isTerminalSessionGone) showScreen(BOARD);
  const dot = dotOf(navButtonById.get(BOARD));
  if (dot) dot.hidden = jumpTargetCount(attentionTally.counts) === 0;
}

export function showPhoneSession(sessionId: string) {
  if (!active) return false;
  openSession(sessionId);
  return true;
}

export function showPhoneScreen(screenId: string) {
  if (!active || !canShowScreen(screenId)) return false;
  showScreen(screenId);
  return true;
}

export function setPhoneScreenAvailable(screenId: string, isAvailable: boolean) {
  if (isAvailable) unavailableScreenIds.delete(screenId);
  if (!isAvailable) unavailableScreenIds.add(screenId);
  const screenButton = menuButtonById.get(screenId) ?? navButtonById.get(screenId);
  if (screenButton) screenButton.hidden = !isAvailable;
  const section = screenElById.get(screenId);
  if (section && !isAvailable) section.hidden = true;
  syncMoreAttention();
  if (!isAvailable && active && uiState.snapshot().phoneScreen === screenId) showScreen(BOARD);
}

export function setPhoneScreenAttention(screenId: string, attention: string | boolean | null) {
  screenAttentionById.set(screenId, typeof attention === 'string' && attention ? attention : attention === true);
  syncMoreAttention();
}

function restoreShownSession() {
  if (!terminalScreen) throw new Error('Phone shell is not built');
  if (terminalScreen.getSessionId()) return;
  const id = getRestorableSessionId();
  if (!id) return;
  terminalScreen.show(id);
  selectSession(id, { rememberFocus: false });
}
