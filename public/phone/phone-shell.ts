import { activatePhoneCalmView, deactivatePhoneCalmView, dismissPhoneCalmSheet } from '../calm/calm-view.ts';
import type { AdoptableElement } from '../dom-helpers.ts';
import { adoptElement, el, releaseElement } from '../dom-helpers.ts';
import { pickStrongestAttention } from '../focus-view/attention-core.ts';
import { getRestorableSessionId, requestSessionOpen, selectSession } from '../session-actions.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { showSessionPlanFace } from '../session-card/lifecycle.ts';
import { reparentReviewPanel } from '../sidebar/review-sidebar.ts';
import { uiState } from '../ui-state-core.ts';
import { closeSettingsSectionPicker } from '../settings-panel.ts';
import { createBoardScreen } from './board-screen.ts';
import type { PushedPhoneHistoryEntry } from './phone-history-core.ts';
import type { PhonePanel } from './phone-panels-core.ts';
import { CALM_SHEET_HISTORY_STATE, decideCalmSheetOpened, decidePhonePopState, isCalmSheetHistoryState, shouldConsumeCalmSheetEntry } from './phone-history-core.ts';
import { createTerminalScreen } from './terminal-screen.ts';

const BOARD = 'board';

interface PhoneScreenSpec {
  id: string;
  label: string;
  glyph: string;
}

export interface PhoneShellHooks {
  headerControls?: AdoptableElement[];
  panels?: PhonePanel<HTMLElement>[];
  onScreenShown?: (screenId: string) => void;
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
let pushedHistoryEntry: PushedPhoneHistoryEntry = 'none';
let isCalmSheetOpen = false;
let isOwnSheetPopPending = false;
let isCalmAvailable = false;
const phoneCalmNavigation = {
  openTerminal: openSession,
  openPlan: (sessionId: string) => { showPhonePlan(sessionId); },
  onSheetOpenChange: onCalmSheetOpenChange,
};

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
  boardScreen.setCalmShown(isCalmAvailable);
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

function pushHistoryFor(screenId: string) {
  if (screenId === BOARD) {
    surrenderHistoryEntry();
    return;
  }
  const state = { glimmervoidScreen: screenId };
  if (pushedHistoryEntry !== 'none') {
    history.replaceState(state, '');
    pushedHistoryEntry = 'screen';
    return;
  }
  history.pushState(state, '');
  pushedHistoryEntry = 'screen';
}

function adoptInheritedHistory() {
  if (isCalmSheetHistoryState(history.state)) {
    pushedHistoryEntry = 'calm-sheet';
    consumeCalmSheetHistoryEntry();
    return BOARD;
  }
  const inherited = screenIdFromHistoryState(history.state);
  if (inherited && canShowScreen(inherited)) {
    pushedHistoryEntry = 'screen';
    return inherited;
  }
  if (inherited) history.replaceState(null, '');
  pushedHistoryEntry = 'none';
  return BOARD;
}

function surrenderHistoryEntry() {
  if (pushedHistoryEntry === 'none') return;
  pushedHistoryEntry = 'none';
  history.back();
}

function pushCalmSheetHistoryEntry() {
  if (decideCalmSheetOpened({ pushedEntry: pushedHistoryEntry, isOwnSheetPopPending }) !== 'push-sheet-entry') return;
  history.pushState(CALM_SHEET_HISTORY_STATE, '');
  pushedHistoryEntry = 'calm-sheet';
}

function consumeCalmSheetHistoryEntry() {
  if (!shouldConsumeCalmSheetEntry({ pushedEntry: pushedHistoryEntry, topState: history.state, isOwnSheetPopPending })) return;
  pushedHistoryEntry = 'none';
  isOwnSheetPopPending = true;
  history.back();
}

function onCalmSheetOpenChange(isOpen: boolean) {
  isCalmSheetOpen = isOpen;
  if (isOpen) {
    pushCalmSheetHistoryEntry();
    return;
  }
  consumeCalmSheetHistoryEntry();
}

function screenIdFromHistoryState(state: unknown): string | null {
  const named = (state as { glimmervoidScreen?: unknown } | null)?.glimmervoidScreen;
  return typeof named === 'string' ? named : null;
}

function onPopState(event: PopStateEvent) {
  const wasOwnSheetPop = isOwnSheetPopPending;
  isOwnSheetPopPending = false;
  if (!active) return;
  const decision = decidePhonePopState({ poppedState: event.state, isCalmSheetOpen, isOwnSheetPopPending: wasOwnSheetPop });
  if (decision === 'own-sheet-pop') {
    if (isCalmSheetOpen) pushCalmSheetHistoryEntry();
    return;
  }
  if (decision === 'adopt-sheet-entry') {
    pushedHistoryEntry = 'calm-sheet';
    return;
  }
  if (decision === 'consume-stray-sheet-entry') {
    pushedHistoryEntry = 'calm-sheet';
    consumeCalmSheetHistoryEntry();
    return;
  }
  if (decision === 'close-sheet') {
    pushedHistoryEntry = 'none';
    dismissPhoneCalmSheet();
    return;
  }
  const target = screenIdFromHistoryState(event.state);
  pushedHistoryEntry = target ? 'screen' : 'none';
  applyScreen(target && canShowScreen(target) ? target : BOARD);
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
  syncPhoneCalm();
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
  if (screenId !== uiState.snapshot().phoneScreen) pushHistoryFor(screenId);
  applyScreen(screenId);
}

export function mountPhoneShell(options?: PhoneShellHooks) {
  hooks = options || {};
  panels = hooks.panels || [];
}

export function activatePhoneShell({ sessionId }: { sessionId?: string } = {}) {
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
  if (sessionId && startScreen === BOARD) {
    uiState.dispatch('setPhoneScreen', BOARD);
    showScreen('terminal');
    return;
  }
  applyScreen(startScreen);
}

export function deactivatePhoneShell() {
  if (!active) return;
  if (!shellEl || !terminalScreen) throw new Error('Phone shell is not built');
  active = false;
  syncPhoneCalm();
  closeSettingsSectionPicker({ returnFocus: false });
  terminalScreen.clear();
  reparentReviewPanel(null);
  for (const panel of panels) releaseElement(panel.el);
  for (const control of (hooks.headerControls || [])) releaseElement(control);
  setMoreMenuOpen(false);
  shellEl.hidden = true;
  shellEl.removeAttribute('data-keyboard');
  resetSoftKeyboardBaseline();
  surrenderHistoryEntry();
}

function syncPhoneCalm() {
  if (!boardScreen) return;
  const isCalmShown = active && isCalmAvailable && uiState.snapshot().phoneScreen === BOARD;
  if (!isCalmShown) {
    deactivatePhoneCalmView();
    return;
  }
  activatePhoneCalmView(boardScreen.calmEl, phoneCalmNavigation);
}

export function setPhoneCalmAvailable(isAvailable: boolean) {
  isCalmAvailable = isAvailable;
  boardScreen?.setCalmShown(isAvailable);
  syncPhoneCalm();
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
