import './usage-panel.css';
import { el, isPanelHidden } from '../dom-helpers.ts';
import type { ViewModule, ViewRefreshReason } from '../view-registry-core.ts';
import { requestUsageReport, setUsageLookingProbe, subscribeUsage, usageSnapshot } from './usage-store.ts';
import type { UsageChange } from './usage-store.ts';
import { isUsageUnavailable } from './usage-view-core.ts';
import type { UsageDetailScreen } from './usage-view-core.ts';
import { _detailScreen, _focusAfterRender, _root, _screen, _sessionsTsEl, _shouldScrollToTop, _ticker, _usage, render, setFocusAfterRender, setRefreshButtonEl, setRefreshStatusEl, setReportAgeEl, setRoot, setSessionsTsEl, setShouldScrollToTop, setUsage, setUsageRenderer } from './usage-panel-state.ts';
import type { FocusTarget } from './usage-panel-state.ts';
import { paintSessionsTs } from './usage-panel-parts.ts';
import { buildOverview, paintRefreshStatus } from './usage-overview.ts';
import { buildReportScreen } from './usage-report-screen.ts';
import { buildBudgetsScreen, buildHistoryScreen, buildOverheadScreen } from './usage-detail-screens.ts';

const DETAIL_BUILDERS: Readonly<Record<UsageDetailScreen, () => HTMLElement>> = Object.freeze({
  report: buildReportScreen,
  history: buildHistoryScreen,
  overhead: buildOverheadScreen,
  budgets: buildBudgetsScreen,
});

function buildDetail() {
  const detail = el('div', 'usage-detail');
  if (!_usage.report || isUsageUnavailable(_usage.report)) return detail;
  detail.append(DETAIL_BUILDERS[_detailScreen]());
  return detail;
}

function clearRefs() {
  setReportAgeEl(null);
  setSessionsTsEl(null);
  setRefreshButtonEl(null);
  setRefreshStatusEl(null);
}

function renderUsagePanel({ force = false }: { force?: boolean } = {}) {
  if (!_root) return;
  if (!force && isPanelHidden(_root)) return;
  setUsage(usageSnapshot());
  const scroller = _root.parentElement;
  const scrollTop = scroller ? scroller.scrollTop : 0;
  _ticker.reset();
  clearRefs();
  _root.textContent = '';
  buildBody();
  if (scroller) scroller.scrollTop = _shouldScrollToTop ? 0 : scrollTop;
  setShouldScrollToTop(false);
  restoreFocusAfterRender();
}

function restoreFocusAfterRender() {
  const target = _focusAfterRender;
  setFocusAfterRender(null);
  if (!target) return;
  const selector = selectorForFocusTarget(target);
  if (!selector) return;
  if (!_root) return;
  const focusTarget = _root.querySelector(selector);
  if (!(focusTarget instanceof HTMLElement)) return;
  focusTarget.focus();
}

function selectorForFocusTarget(target: FocusTarget) {
  if (target.kind === 'day') return `.usage-toggle[data-usage-day="${CSS.escape(target.day)}"]`;
  if (target.kind === 'period') return `.usage-period-button[data-period-view="${CSS.escape(target.view)}"]`;
  if (target.kind === 'sessions-toggle') return '.usage-toggle[data-usage-sessions-toggle="true"]';
  if (target.kind === 'model') return `.usage-rank-head[data-usage-model="${CSS.escape(target.key)}"]`;
  if (target.kind === 'range') return `.usage-period-button[data-usage-range="${CSS.escape(target.value)}"]`;
  if (target.kind === 'back') return '[data-action="back-to-usage-overview"]';
  if (target.kind === 'drill') return `.usage-drill[data-usage-screen="${CSS.escape(target.screen)}"]`;
  if (target.kind === 'sort') return `[data-usage-table="${CSS.escape(target.table)}"] .usage-sort[data-sort-key="${CSS.escape(target.key)}"]`;
  return null;
}

function buildBody() {
  if (!_root) return;
  _root.dataset.screen = _screen;
  const layout = el('div', 'usage-layout');
  layout.append(buildOverview(), buildDetail());
  _root.append(layout);
}

function applyUsageChange(change: UsageChange) {
  if (change === 'refresh-status') {
    paintRefreshStatus();
    return;
  }
  setUsage(usageSnapshot());
  if (change === 'sessions' && _usage.report && !isUsageUnavailable(_usage.report) && _sessionsTsEl?.isConnected) {
    paintSessionsTs();
    return;
  }
  render();
}

function mountUsageView(parent: HTMLElement) {
  if (_root) return;
  const root = el('div', 'usage-content');
  parent.appendChild(root);
  setRoot(root);
  setUsageLookingProbe(() => !isPanelHidden(_root));
  subscribeUsage(applyUsageChange);
  _ticker.ensure();
  render({ force: true });
}

function refreshUsageView(reason: ViewRefreshReason) {
  if (reason === 'shown') render({ force: true });
  requestUsageReport();
}

const view: ViewModule<HTMLElement> = { mount: mountUsageView, refresh: refreshUsageView };

setUsageRenderer(renderUsagePanel);

export { view };
