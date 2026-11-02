import { el } from '../dom-helpers.ts';
import { formatAgo } from '../poll-ago.ts';
import { reportUsageAction, requestUsageReport, setUsageRange } from './usage-store.ts';
import { PERIOD_VIEWS, RANGE_OPTIONS, SESSION_ROW_LIMIT, USAGE_CAVEAT_SHORT, dayRangeLabel, formatPercent, formatTokens, formatUsd, isGlimmervoidSessionRow, modelRowPrefix, modelTokenMix, percentOfTotal, periodAverageText, periodDayKeys, periodDeltaText, periodSummary, rangeDays, rangeLabel, rankedModels, rankedSessions, reportDayKey, reportInsights, sessionOverflowText, shareBasis, shareLabel, vendorSplitText, visibleSessionRows, yourDayHint } from './usage-view-core.ts';
import type { PeriodSummary, UsageWireRow } from './usage-view-core.ts';
import { _ticker, _usage, render, setFocusAfterRender, setSessionsTsEl } from './usage-panel-state.ts';
import { buildBackControl, buildSection, clampPct, paintSessionsTs } from './usage-panel-parts.ts';

const _expandedModels = new Set<string>();

let _sessionsExpanded = false;

function buildRangeSwitch() {
  const group = el('div', 'usage-period');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Report period');
  for (const option of RANGE_OPTIONS) {
    const button = el('button', 'usage-period-button', PERIOD_VIEWS.find((view) => view.value === option.value)?.label || option.label);
    button.type = 'button';
    button.dataset.usageRange = option.value;
    button.setAttribute('aria-pressed', option.value === _usage.rangeValue ? 'true' : 'false');
    button.addEventListener('click', () => {
      if (_usage.rangeValue === option.value) return;
      reportUsageAction('period');
      setUsageRange(option.value);
      setFocusAfterRender({ kind: 'range', value: option.value });
      requestUsageReport();
      render();
    });
    group.append(button);
  }
  return group;
}

function buildReportScreen() {
  const screen = el('div', 'usage-screen');
  const days = rangeDays(_usage.rangeValue);
  const todayKey = reportDayKey(_usage.report);
  screen.append(buildBackControl(), buildSection('Report', dayRangeLabel(periodDayKeys(todayKey, days))), buildRangeSwitch());
  screen.append(buildPeriodCard(periodSummary(_usage.report?.daily, days, todayKey), days));
  const insights = buildInsightsSection();
  if (insights) screen.append(insights);
  screen.append(buildModelsSection(), buildSessionsSection());
  return screen;
}

function buildPeriodCard(summary: PeriodSummary, days: number) {
  const card = el('div', 'usage-period-card');
  card.append(el('p', 'usage-eyebrow', rangeLabel(_usage.rangeValue)));
  card.append(el('p', 'usage-period-total', formatUsd(summary.costUSD)));
  const details = [periodDeltaText(summary, days), vendorSplitText(_usage.report?.totals), USAGE_CAVEAT_SHORT].filter(Boolean);
  for (const detail of details) card.append(el('p', 'usage-meta', detail));
  if (days > 1 && summary.costUSD > 0) card.append(buildPeriodBars(summary, days));
  return card;
}

function buildPeriodBars(summary: PeriodSummary, days: number) {
  const chart = el('div', 'usage-bars');
  chart.dataset.days = String(days);
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', summary.bars.map((bar) => `${bar.day} ${formatUsd(bar.costUSD)}`).join(', '));
  const plot = el('div', 'usage-bars-plot');
  const labels = el('div', 'usage-bars-labels');
  for (const bar of summary.bars) {
    const fill = el('span', 'usage-bar-fill');
    if (bar.isToday) fill.dataset.today = 'true';
    fill.title = `${bar.day} ${formatUsd(bar.costUSD)}`;
    fill.style.height = `${clampPct(percentOfTotal(bar.costUSD, summary.peakUSD) ?? 0)}%`;
    plot.append(fill);
    labels.append(el('span', 'usage-bar-label', bar.label));
  }
  const averagePct = percentOfTotal(summary.averageUSD, summary.peakUSD);
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
  const section = buildSection('By model', shareLabel(shareBasis(totals)));
  const ranked = rankedModels(_usage.report);
  if (ranked.length === 0) {
    section.append(el('p', 'usage-empty', 'No models in this period.'));
    return section;
  }
  const list = el('ul', 'usage-ranks');
  for (const entry of ranked) {
    const key = `${String(entry.row.vendor ?? '')}:${entry.label}`;
    const isExpanded = _expandedModels.has(key);
    const item = el('li', 'usage-rank');
    const button = el('button', 'usage-rank-head');
    button.type = 'button';
    button.dataset.usageModel = key;
    button.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    const { bar, shareText } = buildRankedBar(entry.sharePct, entry.barPct);
    const prefix = modelRowPrefix(entry.row, totals);
    const name = el('span', 'usage-rank-label', entry.label);
    if (prefix) name.prepend(el('span', 'usage-vendor-tag', prefix));
    button.append(name, el('span', 'usage-rank-value', formatUsd(entry.costUSD)), el('span', 'usage-rank-share', shareText), bar);
    button.addEventListener('click', () => {
      reportUsageAction('expand');
      setFocusAfterRender({ kind: 'model', key });
      if (isExpanded) _expandedModels.delete(key);
      if (!isExpanded) _expandedModels.add(key);
      render();
    });
    item.append(button);
    if (isExpanded) item.append(buildTokenMix(entry.row));
    list.append(item);
  }
  section.append(list);
  return section;
}

function buildTokenMix(row: UsageWireRow) {
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
  const section = buildSection('By session', shareLabel(shareBasis(totals)));
  const ranked = rankedSessions(_usage.report);
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
    head.append(el('span', 'usage-rank-label', entry.label), el('span', 'usage-rank-value', formatUsd(entry.costUSD)), el('span', 'usage-rank-share', shareText), bar, ago);
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
  const button = el('button', 'usage-toggle', 'All sessions');
  button.type = 'button';
  button.dataset.usageSessionsToggle = 'true';
  button.setAttribute('aria-expanded', _sessionsExpanded ? 'true' : 'false');
  button.addEventListener('click', () => {
    reportUsageAction('expand');
    setFocusAfterRender({ kind: 'sessions-toggle' });
    _sessionsExpanded = !_sessionsExpanded;
    render();
  });
  wrap.append(button);
  return wrap;
}

export { buildReportScreen };
