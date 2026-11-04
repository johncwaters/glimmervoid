import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { formatAgo } from '../poll-ago.ts';
import { reportUsageAction, requestUsageReport, setUsageMetric, setUsageRange } from './usage-store.ts';
import { METRIC_OPTIONS, PERIOD_VIEWS, RANGE_OPTIONS, SESSION_ROW_LIMIT, USAGE_CAVEAT_SHORT, dayRangeLabel, formatMetric, formatPercent, formatTokens, formatUsd, isGlimmervoidSessionRow, modelRowPrefix, modelTokenMix, percentOfTotal, periodAverageText, periodDayKeys, periodDeltaText, periodSummary, rangeDays, rangeLabel, rankedModels, rankedSessions, reportDayKey, reportInsights, sessionOverflowText, sessionsSummary, shareBasis, shareLabel, tokenTotals, vendorSplitText, vendorTokenRows, visibleSessionRows, yourDayHint } from './usage-view-core.ts';
import type { PeriodSummary, UsageMetric } from './usage-view-core.ts';
import { _ticker, _usage, render, setFocusAfterRender, setSessionsTsEl } from './usage-panel-state.ts';
import { buildBackControl, buildSection, buildTile, clampPct, paintSessionsTs } from './usage-panel-parts.ts';

const _expandedModels = new Set<string>();

let _sessionsExpanded = false;

function buildRangeSwitch() {
  const group = el('div', 'usage-period');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Report period');
  for (const option of RANGE_OPTIONS) {
    const rangeOption = createPressable('usage-period-button', PERIOD_VIEWS.find((view) => view.value === option.value)?.label || option.label);
    rangeOption.dataset.usageRange = option.value;
    rangeOption.setAttribute('aria-pressed', option.value === _usage.rangeValue ? 'true' : 'false');
    rangeOption.addEventListener('click', () => {
      if (_usage.rangeValue === option.value) return;
      reportUsageAction('period');
      setUsageRange(option.value);
      setFocusAfterRender({ kind: 'range', value: option.value });
      requestUsageReport();
      render();
    });
    group.append(rangeOption);
  }
  return group;
}

function buildMetricSwitch() {
  const group = el('div', 'usage-period');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Primary measure');
  for (const option of METRIC_OPTIONS) {
    const metricOption = createPressable('usage-period-button', option.label);
    metricOption.dataset.usageMetric = option.value;
    metricOption.setAttribute('aria-pressed', option.value === _usage.metric ? 'true' : 'false');
    metricOption.addEventListener('click', () => {
      if (_usage.metric === option.value) return;
      setUsageMetric(option.value);
      setFocusAfterRender({ kind: 'metric', value: option.value });
      render();
    });
    group.append(metricOption);
  }
  return group;
}

function buildReportSwitches() {
  const switches = el('div', 'usage-switches');
  switches.append(buildRangeSwitch(), buildMetricSwitch());
  return switches;
}

function buildReportScreen() {
  const screen = el('div', 'usage-screen');
  const days = rangeDays(_usage.rangeValue);
  const todayKey = reportDayKey(_usage.report);
  screen.append(buildBackControl(), buildSection('Report', dayRangeLabel(periodDayKeys(todayKey, days))), buildReportSwitches());
  screen.append(buildPeriodCard(periodSummary(_usage.report?.daily, days, todayKey, _usage.metric), days));
  if (_usage.metric === 'tokens') screen.append(buildTokenTotalsSection(), buildTokenTypesSection());
  const insights = buildInsightsSection();
  if (insights) screen.append(insights);
  screen.append(buildModelsSection(), buildSessionsSection());
  return screen;
}

function buildPeriodCard(summary: PeriodSummary, days: number) {
  const card = el('div', 'usage-period-card');
  card.append(el('p', 'usage-eyebrow', rangeLabel(_usage.rangeValue)));
  card.append(el('p', 'usage-period-total', formatMetric(summary.total, summary.metric)));
  if (summary.metric === 'tokens') return buildTokenPeriodCard(card, summary, days);
  const details = [periodDeltaText(summary, days), vendorSplitText(_usage.report?.totals), USAGE_CAVEAT_SHORT].filter(Boolean);
  for (const detail of details) card.append(el('p', 'usage-meta', detail));
  if (days > 1 && summary.total > 0) card.append(buildPeriodBars(summary, days));
  return card;
}

function buildTokenPeriodCard(card: HTMLElement, summary: PeriodSummary, days: number) {
  const sessionCount = sessionsSummary(_usage.report, _usage.metric).count;
  const details = [`${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}, ${formatUsd(_usage.report?.totals?.costUSD ?? 0)} est.`, periodDeltaText(summary, days)].filter(Boolean);
  for (const detail of details) card.append(el('p', 'usage-meta', detail));
  const vendors = vendorTokenRows(_usage.report?.totals);
  if (vendors.length > 0) card.append(buildVendorTokenRows(vendors));
  if (days > 1 && summary.total > 0) card.append(buildPeriodBars(summary, days));
  return card;
}

function buildVendorTokenRows(vendors: ReturnType<typeof vendorTokenRows>) {
  const list = el('ul', 'usage-vendors');
  for (const vendor of vendors) {
    const item = el('li', 'usage-vendor');
    item.append(el('span', 'usage-vendor-name', vendor.label), el('span', 'usage-vendor-value', formatTokens(vendor.tokens)), el('span', 'usage-meta', `${formatPercent(vendor.sharePct)} of tokens, ${formatUsd(vendor.costUSD)}`));
    list.append(item);
  }
  return list;
}

function buildTokenTotalsSection() {
  const section = buildSection('Totals', '');
  const tiles = el('div', 'usage-tiles');
  for (const total of tokenTotals(_usage.report)) tiles.append(buildTile(total.label, total.value).tile);
  section.append(tiles);
  return section;
}

function buildTokenTypesSection() {
  const section = buildSection('Tokens by type', '');
  const parts = modelTokenMix(_usage.report?.totals || {});
  const sum = parts.reduce((total, part) => total + part.tokens, 0);
  const stack = el('div', 'usage-type-stack');
  stack.setAttribute('role', 'img');
  stack.setAttribute('aria-label', parts.map((part) => `${part.label} ${formatTokens(part.tokens)}`).join(', '));
  parts.forEach((part, index) => {
    const segment = el('span', 'usage-type-segment');
    segment.dataset.part = String(index);
    segment.style.width = `${clampPct(percentOfTotal(part.tokens, sum) ?? 0)}%`;
    segment.title = `${part.label} ${formatTokens(part.tokens)}`;
    stack.append(segment);
  });
  section.append(stack, buildTokenMix(_usage.report?.totals || {}));
  return section;
}

function buildPeriodBars(summary: PeriodSummary, days: number) {
  const chart = el('div', 'usage-bars');
  chart.dataset.days = String(days);
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', summary.bars.map((bar) => `${bar.day} ${formatMetric(bar.value, summary.metric)}`).join(', '));
  const plot = el('div', 'usage-bars-plot');
  const labels = el('div', 'usage-bars-labels');
  for (const bar of summary.bars) {
    const fill = el('span', 'usage-bar-fill');
    if (bar.isToday) fill.dataset.today = 'true';
    fill.title = `${bar.day} ${formatMetric(bar.value, summary.metric)}`;
    fill.style.height = `${clampPct(percentOfTotal(bar.value, summary.peak) ?? 0)}%`;
    plot.append(fill);
    labels.append(el('span', 'usage-bar-label', bar.label));
  }
  const averagePct = percentOfTotal(summary.average, summary.peak);
  if (averagePct !== null) {
    const line = el('span', 'usage-bars-average');
    line.style.bottom = `${clampPct(averagePct)}%`;
    plot.append(line);
  }
  chart.append(plot, labels, el('p', 'usage-meta', periodAverageText(summary)));
  return chart;
}

function buildInsightsSection() {
  const insights = reportInsights(_usage.report);
  const yourDay = _usage.report?.yourDay;
  if (insights.length === 0 && !yourDay) return null;
  const section = buildSection('Insights', yourDay ? yourDayHint(yourDay, Date.now()) : '');
  if (insights.length === 0) return section;
  const list = el('ul', 'usage-insights');
  for (const insight of insights) {
    const item = el('li', 'usage-insight', insight.text);
    item.dataset.tone = insight.tone;
    list.append(item);
  }
  section.append(list);
  return section;
}

function buildRankedBar(sharePct: number | null, barPct: number) {
  const bar = el('span', 'usage-rank-bar');
  bar.setAttribute('aria-hidden', 'true');
  const fill = el('span', 'usage-rank-fill');
  fill.style.width = `${clampPct(barPct)}%`;
  bar.append(fill);
  return { bar, shareText: sharePct === null ? '' : formatPercent(sharePct) };
}

function buildModelsSection() {
  const totals = _usage.report?.totals || {};
  const section = buildSection('By model', shareLabel(shareBasis(totals, _usage.metric)));
  const ranked = rankedModels(_usage.report, _usage.metric);
  if (ranked.length === 0) {
    section.append(el('p', 'usage-empty', 'No models in this period.'));
    return section;
  }
  const list = el('ul', 'usage-ranks');
  for (const entry of ranked) {
    const key = `${String(entry.row.vendor ?? '')}:${entry.label}`;
    const isExpanded = _expandedModels.has(key);
    const item = el('li', 'usage-rank');
    const rankHead = createPressable('usage-rank-head');
    rankHead.dataset.usageModel = key;
    rankHead.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    const { bar, shareText } = buildRankedBar(entry.sharePct, entry.barPct);
    const prefix = modelRowPrefix(entry.row, totals);
    const name = el('span', 'usage-rank-label', entry.label);
    if (prefix) name.prepend(el('span', 'usage-vendor-tag', prefix));
    rankHead.append(name, ...buildRankValues(entry, _usage.metric), el('span', 'usage-rank-share', shareText), bar);
    rankHead.addEventListener('click', () => {
      reportUsageAction('expand');
      setFocusAfterRender({ kind: 'model', key });
      if (isExpanded) _expandedModels.delete(key);
      if (!isExpanded) _expandedModels.add(key);
      render();
    });
    item.append(rankHead);
    if (isExpanded) item.append(buildTokenMix(entry.row));
    list.append(item);
  }
  section.append(list);
  return section;
}

function buildRankValues(entry: { tokens: number; costUSD: number }, metric: UsageMetric) {
  if (metric === 'cost') return [el('span', 'usage-rank-value', formatUsd(entry.costUSD))];
  return [el('span', 'usage-rank-cost', formatUsd(entry.costUSD)), el('span', 'usage-rank-value', formatTokens(entry.tokens))];
}

function buildTokenMix(row: Parameters<typeof modelTokenMix>[0]) {
  const mix = el('dl', 'usage-mix');
  for (const part of modelTokenMix(row)) {
    const pair = el('div', 'usage-mix-part');
    pair.append(el('dt', null, part.label), el('dd', null, formatTokens(part.tokens)));
    mix.append(pair);
  }
  return mix;
}

function buildSessionsSection() {
  const totals = _usage.report?.totals || {};
  const section = buildSection('By session', shareLabel(shareBasis(totals, _usage.metric)));
  const ranked = rankedSessions(_usage.report, _usage.metric);
  if (ranked.length === 0) {
    section.append(el('p', 'usage-empty', 'No sessions in this period.'));
    return section;
  }
  const visible = visibleSessionRows(ranked, _sessionsExpanded);
  const list = el('ul', 'usage-ranks');
  for (const entry of visible.rows) {
    const item = el('li', 'usage-rank');
    if (isGlimmervoidSessionRow(entry.row)) item.dataset.managed = 'true';
    const head = el('div', 'usage-rank-head');
    head.title = entry.row.project ? String(entry.row.project) : entry.label;
    const { bar, shareText } = buildRankedBar(entry.sharePct, entry.barPct);
    const ago = el('span', 'usage-rank-ago', '');
    _ticker.track(ago, Number(entry.row.lastTs), formatAgo);
    head.append(el('span', 'usage-rank-label', entry.label), ...buildRankValues(entry, _usage.metric), el('span', 'usage-rank-share', shareText), bar, ago);
    item.append(head);
    list.append(item);
  }
  section.append(list);
  if (ranked.length > SESSION_ROW_LIMIT) section.append(buildSessionsOverflow(visible.hiddenCount));
  const sessionsTsEl = el('p', 'usage-meta', '');
  setSessionsTsEl(sessionsTsEl);
  section.append(sessionsTsEl);
  paintSessionsTs();
  _ticker.onTick(paintSessionsTs);
  return section;
}

function buildSessionsOverflow(hiddenCount: number) {
  const wrap = el('div', 'usage-overflow');
  const text = sessionOverflowText(hiddenCount);
  if (text) wrap.append(el('p', 'usage-meta', text));
  const sessionsToggle = createPressable('usage-toggle', 'All sessions');
  sessionsToggle.dataset.usageSessionsToggle = 'true';
  sessionsToggle.setAttribute('aria-expanded', _sessionsExpanded ? 'true' : 'false');
  sessionsToggle.addEventListener('click', () => {
    reportUsageAction('expand');
    setFocusAfterRender({ kind: 'sessions-toggle' });
    _sessionsExpanded = !_sessionsExpanded;
    render();
  });
  wrap.append(sessionsToggle);
  return wrap;
}

export { buildReportScreen };
