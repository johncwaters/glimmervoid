import type { AdoptableElement } from '../dom-helpers.ts';
import { adoptElement, el, releaseElement } from '../dom-helpers.ts';
import { pickStrongestAttention } from '../focus-view/attention-core.ts';
import { getRestorableSessionId, requestSessionOpen, selectSession } from '../session-actions.ts';
import { addActivityRenderer } from '../session-card/activity.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { showSessionPlanFace } from '../session-card/lifecycle.ts';
import { reparentReviewPanel } from '../sidebar/review-sidebar.ts';
import { uiState } from '../ui-state-core.ts';
import { createBoardScreen } from './board-screen.ts';
import type { PhonePanel } from './phone-panels-core.ts';
import { createTerminalScreen } from './terminal-screen.ts';

const BOARD = 'board';

interface PhoneScreenSpec {
  id: string;
  label: string;
  glyph: string;
}

interface PhoneShellHooks {
  headerControls?: AdoptableElement[];
  panels?: PhonePanel<HTMLElement>[];
  onScreenShown?: (screenId: string) => void;
  canGoBack?: (screenId: string) => boolean;
  onBack?: (screenId: string) => void;
}

const NAV_SCREENS: readonly PhoneScreenSpec[] = Object.freeze([
  { id: BOARD, label: 'Board', glyph: '▤' },
  { id: 'terminal', label: 'Terminal', glyph: '▸' },
  { id: 'review', label: 'Review', glyph: '◫' },
]);
let panels: PhonePanel<AdoptableElement>[] = [];
const panelMountElById = new Map<string, HTMLDivElement>();
let shellEl: HTMLDivElement | null = null;
const navButtonById = new Map<string, HTMLButtonElement>();
const screenElById = new Map<string, HTMLElement>();
const screenAttentionById = new Map<string, string | boolean>();
let boardScreen: ReturnType<typeof createBoardScreen> | null = null;
let terminalScreen: ReturnType<typeof createTerminalScreen> | null = null;
let reviewMountEl: HTMLDivElement | null = null;
let moreButtonEl: HTMLButtonElement | null = null;
let moreMenuEl: HTMLDivElement | null = null;
const menuButtonById = new Map<string, HTMLButtonElement>();
const unavailableScreenIds = new Set<string>();
let hooks: PhoneShellHooks = {};
let active = false;
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

function buildNavButton(label: string, glyph: string, itemClass = 'phone-nav-item', dotClass = 'phone-nav-dot') {
  const btn = el('button', itemClass);
  btn.type = 'button';
  const glyphEl = el('span', 'phone-nav-glyph', glyph);
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
    nestedLevels.push(attention);
    applyDotAttention(dotOf(menuButtonById.get(panel.id)), attention);
  }
  applyDotAttention(dotOf(moreButtonEl), pickStrongestAttention(nestedLevels));
}

function buildMoreMenu() {
  const menu = el('div', 'phone-nav-more-menu');
  menu.hidden = true;
  for (const panel of panels) {
    const btn = buildNavButton(panel.label, panel.glyph, 'phone-nav-menu-item', 'phone-nav-dot phone-nav-menu-dot');
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
    const btn = buildNavButton(screen.label, screen.glyph);
    btn.dataset.screen = screen.id;
    btn.addEventListener('click', () => showScreen(screen.id));
    navButtonById.set(screen.id, btn);
    nav.appendChild(btn);
  }
  moreButtonEl = buildNavButton('More', String.fromCharCode(0x22ef));
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

  boardScreen = createBoardScreen({ onSelectSession: openSession });
  addActivityRenderer((ui, kind) => { if (active) boardScreen?.renderActivity(ui, kind); });
  terminalScreen = createTerminalScreen({ onBack: () => showScreen(BOARD) });
  reviewMountEl = el('div', 'phone-review');

  const screens = el('div', 'phone-screens');
  const contentByScreenId: Record<string, HTMLElement | null> = {
    [BOARD]: boardScreen.el,
    terminal: terminalScreen.el,
    review: reviewMountEl,
  };
  for (const screen of NAV_SCREENS) {
    screens.appendChild(wrapScreen(screen.id, screen.label, contentByScreenId[screen.id]));
  }
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

function openSession(sessionId: string) {
  if (!sessionUIs.has(sessionId)) return;
  if (!boardScreen || !terminalScreen) throw new Error('Phone shell is not built');
  requestSessionOpen(sessionId, 'dormant-fallback');
  boardScreen.acknowledge(sessionId);
  selectSession(sessionId);
  terminalScreen.show(sessionId);
  showScreen('terminal');
}

interface PhoneHistoryState {
  glimmervoidScreen?: unknown;
  glimmervoidNested?: unknown;
}

function historyStateFor(screenId: string, isNested: boolean) {
  if (isNested) return { glimmervoidScreen: screenId, glimmervoidNested: true };
  return { glimmervoidScreen: screenId };
}

function screenIdFromHistoryState(state: unknown): string | null {
  const named = (state as PhoneHistoryState | null)?.glimmervoidScreen;
  return typeof named === 'string' ? named : null;
}

function historyDepthOf(state: unknown) {
  if (!screenIdFromHistoryState(state)) return 0;
  return (state as PhoneHistoryState).glimmervoidNested === true ? 2 : 1;
}

function desiredHistoryDepth(screenId: string) {
  if (screenId === BOARD) return 0;
  return hooks.canGoBack?.(screenId) ? 2 : 1;
}

function isCurrentHistoryStateFor(screenId: string, isNested: boolean) {
  return screenIdFromHistoryState(history.state) === screenId && historyDepthOf(history.state) === (isNested ? 2 : 1);
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
  const isTopNested = pushedHistoryDepth === 2;
  if (pushedHistoryDepth > 0 && !isCurrentHistoryStateFor(screenId, isTopNested)) history.replaceState(historyStateFor(screenId, isTopNested), '');
  if (pushedHistoryDepth === 0 && desiredDepth > 0) {
    history.pushState(historyStateFor(screenId, false), '');
    pushedHistoryDepth = 1;
  }
  if (pushedHistoryDepth === 1 && desiredDepth === 2) {
    history.pushState(historyStateFor(screenId, true), '');
    pushedHistoryDepth = 2;
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
  const isLeavingNestedScreen = pushedHistoryDepth < 2 && targetScreenId === currentScreenId && hooks.canGoBack?.(currentScreenId);
  if (isLeavingNestedScreen) hooks.onBack?.(currentScreenId);
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

function applyScreen(screenId: string) {
  if (!moreButtonEl || !terminalScreen) throw new Error('Phone shell is not built');
  uiState.dispatch('setPhoneScreen', screenId);
  setMoreMenuOpen(false);
  for (const [id, section] of screenElById) {
    section.hidden = id !== screenId;
  }
  hooks.onScreenShown?.(screenId);
  syncCurrent(navButtonById, screenId);
  const isNestedActive = menuButtonById.has(screenId);
  if (isNestedActive) moreButtonEl.setAttribute('aria-current', 'page');
  if (!isNestedActive) moreButtonEl.removeAttribute('aria-current');
  syncCurrent(menuButtonById, screenId);
  if (screenId === 'terminal') {
    terminalScreen.reveal();
    return;
  }
  terminalScreen.unview();
}

function canShowScreen(screenId: string) {
  return screenElById.has(screenId) && !unavailableScreenIds.has(screenId);
}

function showScreen(screenId: string) {
  if (!shellEl || !canShowScreen(screenId)) return;
  applyScreen(screenId);
  syncPhoneHistory();
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
  reparentReviewPanel(reviewMountEl);
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
    showScreen('terminal');
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
  reparentReviewPanel(null);
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
  boardScreen.refresh();
  terminalScreen.refresh();
  if (uiState.snapshot().phoneScreen === 'terminal' && !terminalScreen.getSessionId()) showScreen(BOARD);
  const dot = dotOf(navButtonById.get(BOARD));
  if (dot) dot.hidden = boardScreen.getAttentionCount() === 0;
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
  const menuButton = menuButtonById.get(screenId);
  if (menuButton) menuButton.hidden = !isAvailable;
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
