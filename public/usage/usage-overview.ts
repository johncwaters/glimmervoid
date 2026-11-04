import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import { reportUsageAction, requestUsageReport, usageRefreshStatus } from './usage-store.ts';
import { PLAN_LIMIT_VENDORS, PLAN_WINDOWS, USAGE_DISABLED_HINT, budgetRows, budgetSummary, dailyRowForDay, formatPercent, formatTokens, formatUsd, glimmervoidLaneCostUSD, glimmervoidOverhead, historyDayCount, isUsageUnavailable, missingPricingLine, nextPaceResetMs, paceSubText, paceVerdict, paceWindows, planLimitAgeText, planLimitStaleNote, rangeLabel, reportDayKey, resetClockText, sessionsSummary, topModelSummary, usageErrorLine, usageWarningLine } from './usage-view-core.ts';
import type { PaceWindow, PlanLimits, UsageDetailScreen } from './usage-view-core.ts';
import { _detailScreen, _refreshButtonEl, _refreshStatusEl, _ticker, _usage, render, setRefreshButtonEl, setRefreshStatusEl, setReportAgeEl } from './usage-panel-state.ts';
import { buildSection, clampPct, openScreen, paintReportAge } from './usage-panel-parts.ts';

let _resetRenderTimer: ReturnType<typeof setTimeout> | null = null;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function buildRefreshControls() {
  const controls = el('div', 'usage-controls');
  const refreshButton = button({
    variant: 'secondary',
    size: 'small',
    label: 'Refresh',
    action: 'refresh-usage',
    onClick: () => {
      reportUsageAction('refresh');
      requestUsageReport({ force: true });
    },
  });
  refreshButton.title = 'Re-read every transcript from the start';
  const status = el('span', 'usage-refresh-status', '');
  setRefreshButtonEl(refreshButton);
  setRefreshStatusEl(status);
  paintRefreshStatus();
  const reportAgeEl = el('p', 'usage-meta', '');
  setReportAgeEl(reportAgeEl);
  paintReportAge();
  _ticker.onTick(paintReportAge);
  controls.append(refreshButton, status, reportAgeEl);
  return controls;
}

function buildReportWarnings() {
  const lines = [usageWarningLine(_usage.report), missingPricingLine(_usage.report?.pricing?.missing)].filter(Boolean);
  return lines.map((line) => el('p', 'usage-warning', line));
}

function todayCostUSD() {
  if (!_usage.report) return null;
  const today = dailyRowForDay(_usage.report.daily, reportDayKey(_usage.report));
  return typeof today?.costUSD === 'number' && Number.isFinite(today.costUSD) ? today.costUSD : 0;
}

function buildVerdict(windows: readonly PaceWindow[], now: number) {
  const verdict = paceVerdict(windows, budgetRows(_usage.report), todayCostUSD(), now);
  const box = el('div', 'usage-verdict');
  box.dataset.tone = verdict.tone;
  box.append(el('p', 'usage-verdict-headline', verdict.headline), el('p', verdict.tone === 'ok' ? 'usage-verdict-detail' : 'usage-verdict-detail usage-warning', verdict.detail));
  return box;
}

function buildPaceSection(windows: readonly PaceWindow[], now: number) {
  if (windows.length === 0) return null;
  const section = el('section', 'usage-pace');
  section.setAttribute('aria-label', 'Plan limits');
  for (const { vendor, label } of PLAN_LIMIT_VENDORS) {
    const vendorWindows = windows.filter((window) => window.vendor === vendor);
    if (vendorWindows.length === 0) continue;
    section.append(buildPaceVendor(label, _usage.planLimitsByVendor[vendor], vendorWindows, now));
  }
  section.append(buildPaceLegend());
  return section;
}

function buildPaceVendor(label: string, planLimits: PlanLimits | null, windows: readonly PaceWindow[], now: number) {
  const group = el('div', 'usage-pace-vendor');
  const head = el('div', 'usage-pace-vendor-head');
  head.append(el('h3', 'usage-eyebrow', label));
  const ageEl = el('span', 'usage-meta', '');
  head.append(ageEl);
  const paintAge = () => {
    if (!ageEl.isConnected) return;
    const age = planLimitAgeText(planLimits?.ts);
    ageEl.textContent = age ? `official, ${age}` : 'official';
  };
  paintAge();
  _ticker.onTick(paintAge);
  group.append(head);
  const stale = planLimitStaleNote(planLimits?.ts);
  if (stale) {
    const note = el('p', 'usage-meta', stale);
    note.dataset.tone = 'warn';
    group.append(note);
  }
  for (const window of windows) group.append(buildPaceWindow(window, now));
  return group;
}

function buildPaceWindow(window: PaceWindow, now: number) {
  const row = el('div', 'usage-pace-window');
  row.dataset.tone = window.tone;
  const head = el('div', 'usage-pace-head');
  head.append(el('span', 'usage-pace-label', PLAN_WINDOWS.find((spec) => spec.key === window.key)?.label || window.windowLabel));
  head.append(el('span', 'usage-pace-used', `${Math.round(window.usedPct)}%`));
  const clock = resetClockText(window.resetsAtMs, now);
  head.append(el('span', 'usage-pace-reset', clock ? `resets ${clock}` : ''));
  row.append(head, buildPaceBar(window));
  const sub = paceSubText(window);
  if (sub) row.append(el('p', 'usage-pace-sub', sub));
  return row;
}

function buildPaceBar(window: PaceWindow) {
  const bar = el('div', 'usage-pacebar');
  bar.setAttribute('role', 'img');
  const usedPct = clampPct(window.usedPct);
  const described = [`${Math.round(window.usedPct)}% used`];
  const fill = el('span', 'usage-pacebar-fill');
  fill.style.width = `${usedPct}%`;
  bar.append(fill);
  if (window.projectedPct !== null && window.projectedPct > window.usedPct) {
    const projection = el('span', 'usage-pacebar-projection');
    projection.style.left = `${usedPct}%`;
    projection.style.width = `${clampPct(window.projectedPct) - usedPct}%`;
    bar.append(projection);
    described.push(`about ${Math.round(window.projectedPct)}% projected at reset`);
  }
  if (window.elapsedPct !== null) {
    const tick = el('span', 'usage-pacebar-tick');
    tick.style.left = `${clampPct(window.elapsedPct)}%`;
    bar.append(tick);
    described.push(`${Math.round(window.elapsedPct)}% of the window gone`);
  }
  bar.setAttribute('aria-label', `${window.vendorLabel} ${window.windowLabel} limit: ${described.join(', ')}`);
  return bar;
}

function buildPaceLegend() {
  const legend = el('div', 'usage-pace-legend');
  legend.setAttribute('aria-hidden', 'true');
  for (const [part, label] of [['fill', 'used'], ['projection', 'projected'], ['tick', 'time gone']]) {
    const item = el('span', 'usage-pace-legend-item');
    const swatch = el('span', 'usage-pace-swatch');
    swatch.dataset.part = part;
    item.append(swatch, el('span', null, label));
    legend.append(item);
  }
  return legend;
}

function buildDrillRow(screen: UsageDetailScreen, label: string, detail: string, value: string) {
  const drillRow = createPressable('usage-drill');
  drillRow.dataset.usageScreen = screen;
  if (_detailScreen === screen) drillRow.setAttribute('aria-current', 'true');
  const text = el('span', 'usage-drill-text');
  text.append(el('span', 'usage-drill-label', label));
  if (detail) text.append(el('span', 'usage-drill-detail', detail));
  drillRow.append(text, el('span', 'usage-drill-value', value), el('span', 'usage-drill-chevron'));
  drillRow.addEventListener('click', () => openScreen(screen));
  return drillRow;
}

function buildPrimaryDrillRow(periodText: string) {
  const totals = _usage.report?.totals;
  if (_usage.metric === 'cost') return buildDrillRow('report', 'Spend', `${periodText}, est. list price`, formatUsd(totals?.costUSD ?? 0));
  return buildDrillRow('report', 'Tokens', `${periodText}, ${formatUsd(totals?.costUSD ?? 0)} est.`, formatTokens(totals?.tokens ?? 0));
}

function buildDrillRows() {
  const nav = el('nav', 'usage-drills');
  nav.setAttribute('aria-label', 'Usage details');
  const report = _usage.report;
  const periodText = rangeLabel(_usage.rangeValue);
  nav.append(buildPrimaryDrillRow(periodText));
  const topModel = topModelSummary(report, _usage.metric);
  nav.append(buildDrillRow('report', 'Models', topModel ? `${topModel.label} leads` : 'none yet', topModel ? formatPercent(topModel.sharePct) : ''));
  const sessions = sessionsSummary(report, _usage.metric);
  nav.append(buildDrillRow('report', 'Sessions', sessions.topLabel ? `top: ${sessions.topLabel}` : 'none yet', String(sessions.count)));
  const dayCount = historyDayCount(report?.daily);
  nav.append(buildDrillRow('history', 'History', 'daily heatmap, past windows', `${dayCount} ${dayCount === 1 ? 'day' : 'days'}`));
  const overheadCost = glimmervoidLaneCostUSD(report);
  if (overheadCost !== null || glimmervoidOverhead(report, _usage.planLimitsByVendor.claude).length > 0) {
    nav.append(buildDrillRow('overhead', 'Glimmervoid overhead', 'sessions it spawns for its own work', overheadCost === null ? '' : formatUsd(overheadCost)));
  }
  const budgets = budgetRows(report);
  if (budgets.length > 0) {
    const summary = budgetSummary(budgets);
    nav.append(buildDrillRow('budgets', 'Budgets', summary.detail, summary.value));
  }
  return nav;
}

function scheduleResetRender(windows: readonly PaceWindow[], now: number) {
  if (_resetRenderTimer) clearTimeout(_resetRenderTimer);
  _resetRenderTimer = null;
  const nextResetMs = nextPaceResetMs(windows);
  if (nextResetMs === null) return;
  _resetRenderTimer = setTimeout(() => {
    _resetRenderTimer = null;
    render();
  }, Math.min(nextResetMs - now + 1000, MAX_TIMER_DELAY_MS));
}

function buildOverview() {
  const overview = el('div', 'usage-overview');
  const now = Date.now();
  const windows = paceWindows(_usage.planLimitsByVendor, now);
  scheduleResetRender(windows, now);
  if (isUsageUnavailable(_usage.report)) {
    overview.append(buildUnavailableSection());
    const pace = buildPaceSection(windows, now);
    if (pace) overview.append(pace);
    overview.append(buildRefreshControls());
    return overview;
  }
  if (_usage.report) overview.append(buildVerdict(windows, now));
  overview.append(...buildReportWarnings());
  const pace = buildPaceSection(windows, now);
  if (pace) overview.append(pace);
  if (!_usage.report) {
    overview.append(el('p', 'usage-empty', 'Waiting for the first usage scan. Figures appear once it finishes.'));
    overview.append(buildRefreshControls());
    return overview;
  }
  overview.append(buildDrillRows(), buildRefreshControls());
  return overview;
}

function buildUnavailableSection() {
  const section = buildSection('Not available', '');
  section.append(el('p', 'usage-empty', usageErrorLine(_usage.report)));
  section.append(el('p', 'usage-empty', USAGE_DISABLED_HINT));
  return section;
}

function paintRefreshStatus() {
  const status = usageRefreshStatus();
  if (_refreshButtonEl) _refreshButtonEl.disabled = status.isPending;
  if (!_refreshStatusEl) return;
  _refreshStatusEl.textContent = status.text;
  if (status.hasFailure) { _refreshStatusEl.dataset.tone = 'error'; return; }
  delete _refreshStatusEl.dataset.tone;
}

export { buildOverview, paintRefreshStatus };
