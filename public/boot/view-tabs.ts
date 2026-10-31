import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { queryTag } from '../dom-helpers.ts';
import type { FeatureSurfaceSettings } from '../feature-surfaces-core.ts';
import { centerSessionQuietly, openPlanInFocus } from '../focus-view/focus-view.ts';
import { isPhoneShellActive, orderPhonePanels, setPhoneScreenAttention, setPhoneScreenAvailable, showPhoneScreen, showPhoneSession } from '../phone/phone-shell-gate.ts';
import { resolvePlanTarget } from '../plan/plan-link.ts';
import { nextRovingIndex, wrapIndex } from '../roving-keys-core.ts';
import { activateSettingsSection, setFeatureTabViews } from '../settings/settings-store.ts';
import { isSettingsHash } from '../settings/settings-link.ts';
import { mountReviewSidebar } from '../sidebar/review-sidebar.ts';
import { setTraceNavigate } from '../trace-store.ts';
import { getActiveView as getSavedActiveView, setActiveView } from '../ui-prefs.ts';
import { getActiveView, uiState } from '../ui-state-core.ts';
import { createDashboardViews, mountEagerViews, mountedViewModule, showView } from '../view-registry.ts';
import type { DashboardView } from '../view-registry.ts';
import { moveViewId, orderViewIds, refreshViewOnReason, refreshVisibleViews, viewAvailabilityFromSettings } from '../view-registry-core.ts';
import type { ViewRefreshReason } from '../view-registry-core.ts';
import { confirmServerRestart } from './power-menu.ts';

function openSettings(section?: string) {
  if (section) activateSettingsSection(section);
  if (showPhoneScreen('settings')) return;
  activateView('settings', { section });
}

function openView(view: string) {
  if (showPhoneScreen(view)) return;
  activateView(view);
}

function clearSettingsHash() {
  if (!isSettingsHash(location.hash)) return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
}

const VIEW_TABS = createDashboardViews({
  onRestart: confirmServerRestart,
  openTerminal: (id) => {
    if (showPhoneSession(id)) return;
    activateView('focus');
    centerSessionQuietly(id);
  },
  openPlan: (id) => { activateView('focus'); openPlanInFocus(id); },
  openReviews: () => {
    if (!isViewAvailable('prs')) return false;
    if (showPhoneScreen('prs')) return true;
    activateView('prs');
    return true;
  },
  setPhoneAttention: setPhoneScreenAttention,
});

function currentViewOrder() {
  return VIEW_TABS.map((viewTab) => viewTab.view);
}

const DEFAULT_VIEW_ORDER = currentViewOrder();

function findViewTab(view: string) {
  return VIEW_TABS.find((viewTab) => viewTab.view === view);
}

function isViewAvailable(view: string) {
  return VIEW_TABS.some((viewTab) => viewTab.view === view && !viewTab.tab.hidden);
}

let shouldPersistActiveView = true;
let savedViewAwaitingSurface: string | null = null;
function acknowledgeViewAttention(view: string) {
  findViewTab(view)?.attention?.acknowledge();
}

let unsentShownView: string | null = null;

function reportViewShown(view: string) {
  const isSent = sendControlMsg({ type: 'dashboard-telemetry', event: 'view_shown', properties: { view } });
  unsentShownView = isSent ? null : view;
}

function resendUnsentShownView() {
  if (unsentShownView) reportViewShown(unsentShownView);
}

function refreshViewOnShow(view: string) {
  const viewTab = findViewTab(view);
  if (!viewTab) return;
  showView(viewTab, (module) => refreshViewOnReason(viewTab, module, 'shown'));
  reportViewShown(view);
}

function refreshViewsIfVisible(reason: ViewRefreshReason) {
  refreshVisibleViews(VIEW_TABS, { isPhoneShellActive: isPhoneShellActive(), activeView: getActiveView(), phoneScreen: uiState.snapshot().phoneScreen }, reason, mountedViewModule);
}

interface ActivateViewOptions {
  section?: string;
  setting?: string | null;
  persist?: boolean;
}

function activateView(view: string, { section, setting, persist = true }: ActivateViewOptions = {}) {
  const viewTab = findViewTab(view);
  if (!viewTab || !isViewAvailable(view)) return;
  const prev = getActiveView();
  uiState.dispatch('setActiveView', view);
  shouldPersistActiveView = persist;
  if (persist) savedViewAwaitingSurface = null;

  document.body.dataset.activeView = view;
  document.body.dataset.reviewSidebarHidden = String(viewTab.hasReviewSidebar !== true);

  if (persist) setActiveView(view);
  for (const v of VIEW_TABS) {
    const selected = v.view === view;
    if (v.el) v.el.hidden = !selected;
    v.tab.setAttribute('aria-selected', String(selected));
    v.tab.tabIndex = selected ? 0 : -1;
  }

  if (prev !== view) mountedViewModule(prev)?.deactivate?.();
  showView(viewTab, (module) => {
    if (getActiveView() !== view) return;
    module.activate?.();
    refreshViewOnReason(viewTab, module, 'shown');
    if (view === 'settings' && section) activateSettingsSection(section, setting ?? null);
  });
  reportViewShown(view);
  if (prev === 'settings' && view !== 'settings') clearSettingsHash();
  acknowledgeViewAttention(view);
}

function setSurfaceAvailable(viewTab: DashboardView, isAvailable: boolean) {
  const { view } = viewTab;
  viewTab.tab.hidden = !isAvailable;
  setPhoneScreenAvailable(view, isAvailable);
  viewTab.onAvailabilityChange?.(isAvailable);
  if (isPhoneShellActive()) return;
  if (!isAvailable && getActiveView() === view) activateView('focus');
  if (!isAvailable) return;
  if (savedViewAwaitingSurface !== view) return;
  activateView(view);
}

function applySurfaceSettings(settings: FeatureSurfaceSettings) {
  for (const { view, isAvailable } of viewAvailabilityFromSettings(VIEW_TABS, settings)) setSurfaceAvailable(view, isAvailable);
}

function applyTabOrder(savedViewOrder: readonly string[] | undefined) {
  const orderedViewIds = orderViewIds(DEFAULT_VIEW_ORDER, savedViewOrder);
  const isAlreadyOrdered = VIEW_TABS.every((viewTab, index) => viewTab.view === orderedViewIds[index]);
  if (isAlreadyOrdered) return;
  VIEW_TABS.sort((first, second) => orderedViewIds.indexOf(first.view) - orderedViewIds.indexOf(second.view));
  queryTag(document, '#header-tabs', 'div').append(...VIEW_TABS.map((viewTab) => viewTab.tab));
  orderPhonePanels(orderedViewIds);
}

function availableViewTabs() {
  return VIEW_TABS.filter((viewTab) => !viewTab.tab.hidden);
}

function activateViewTabAt(availableTabs: typeof VIEW_TABS, index: number) {
  const nextTab = availableTabs[index];
  activateView(nextTab.view);
  return nextTab.tab;
}

function stepViewTab(fromView: string, direction: number) {
  const availableTabs = availableViewTabs();
  const fromIndex = availableTabs.findIndex((viewTab) => viewTab.view === fromView);
  return activateViewTabAt(availableTabs, wrapIndex(fromIndex, direction, availableTabs.length));
}

function focusViewTabIfFocused(tab: HTMLElement) {
  if (!VIEW_TABS.some((viewTab) => viewTab.tab === document.activeElement)) return;
  tab.focus();
}

let draggedViewId: string | null = null;

function saveTabOrder(nextViewOrder: string[]) {
  const previousViewOrder = currentViewOrder();
  applyTabOrder(nextViewOrder);
  sendControlRequest('update-settings', { settings: { viewTabOrder: nextViewOrder } })
    .then((message) => {
      if (message.type === 'settings-error') applyTabOrder(previousViewOrder);
    })
    .catch(() => applyTabOrder(previousViewOrder));
}

function dropDraggedTabOn(targetView: string) {
  const movedView = draggedViewId;
  draggedViewId = null;
  if (!movedView || movedView === targetView) return;
  const viewOrder = currentViewOrder();
  saveTabOrder(moveViewId(viewOrder, movedView, viewOrder.indexOf(targetView)));
}

function wireViewTab({ view, tab }: DashboardView) {
  tab.addEventListener('click', () => activateView(view));
  tab.addEventListener('dragstart', (e) => {
    draggedViewId = view;
    e.dataTransfer?.setData('text/plain', view);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  tab.addEventListener('dragover', (e) => {
    if (!draggedViewId || draggedViewId === view) return;
    e.preventDefault();
    tab.dataset.dropTarget = 'true';
  });
  tab.addEventListener('dragleave', () => delete tab.dataset.dropTarget);
  tab.addEventListener('drop', (e) => {
    e.preventDefault();
    delete tab.dataset.dropTarget;
    dropDraggedTabOn(view);
  });
  tab.addEventListener('dragend', () => { draggedViewId = null; });
  tab.addEventListener('keydown', (e) => {
    if (e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
    const availableTabs = availableViewTabs();
    const activeIndex = availableTabs.findIndex((viewTab) => viewTab.view === getActiveView());
    const nextIndex = nextRovingIndex(e.key, activeIndex, availableTabs.length, 'horizontal');
    if (nextIndex === null) return;
    e.preventDefault();
    activateViewTabAt(availableTabs, nextIndex).focus();
  });
}

function selectInitialView() {
  const savedView = getSavedActiveView();
  const isInitialSettingsLink = isSettingsHash(location.hash);
  const initialPlanTarget = resolvePlanTarget(location.hash);
  if (isInitialSettingsLink) {
    activateSettingsSection(null, null, location.hash);
    activateView('settings', { persist: false });
  }
  if (initialPlanTarget) activateView('focus', { persist: false });
  if (isInitialSettingsLink || initialPlanTarget) return;
  const canRestoreSavedView = isViewAvailable(savedView);
  if (!canRestoreSavedView) savedViewAwaitingSurface = savedView;
  activateView(canRestoreSavedView ? savedView : 'focus', { persist: canRestoreSavedView });
}

function restoreDesktopViews() {
  const restoredView = getActiveView();
  activateView(isViewAvailable(restoredView) ? restoredView : 'focus', { persist: shouldPersistActiveView });
}

function mountViewTabs() {
  setFeatureTabViews(VIEW_TABS);
  mountReviewSidebar({ panel: document.getElementById('review-sidebar') });
  mountEagerViews(VIEW_TABS);

  for (const viewTab of VIEW_TABS) {
    if (!viewTab.gate) continue;
    setSurfaceAvailable(viewTab, false);
    if ('subscribe' in viewTab.gate) viewTab.gate.subscribe((isAvailable) => setSurfaceAvailable(viewTab, isAvailable));
  }

  setTraceNavigate(() => {
    if (!isViewAvailable('trace')) return;
    if (showPhoneScreen('trace')) return;
    activateView('trace');
  });

  for (const viewTab of VIEW_TABS) wireViewTab(viewTab);
  selectInitialView();
}

export {
  VIEW_TABS,
  acknowledgeViewAttention,
  activateView,
  applySurfaceSettings,
  applyTabOrder,
  clearSettingsHash,
  focusViewTabIfFocused,
  isViewAvailable,
  mountViewTabs,
  openSettings,
  openView,
  refreshViewOnShow,
  refreshViewsIfVisible,
  resendUnsentShownView,
  restoreDesktopViews,
  stepViewTab,
};
