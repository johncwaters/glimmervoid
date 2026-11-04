import { createPollAgoTicker } from '../poll-ago.ts';
import { usageSnapshot } from './usage-store.ts';
import { DEFAULT_DETAIL_SCREEN } from './usage-view-core.ts';
import type { UsageDetailScreen, UsageScreen } from './usage-view-core.ts';

type FocusTarget =
  | { kind: 'sort'; table: string; key: string }
  | { kind: 'period'; view: string }
  | { kind: 'day'; day: string }
  | { kind: 'sessions-toggle' }
  | { kind: 'model'; key: string }
  | { kind: 'range'; value: string }
  | { kind: 'metric'; value: string }
  | { kind: 'back' }
  | { kind: 'drill'; screen: UsageDetailScreen };

let _usage = usageSnapshot();

let _root: HTMLDivElement | null = null;

let _focusAfterRender: FocusTarget | null = null;

let _screen: UsageScreen = 'overview';

let _detailScreen: UsageDetailScreen = DEFAULT_DETAIL_SCREEN;

let _shouldScrollToTop = false;

let _reportAgeEl: HTMLParagraphElement | null = null;

let _sessionsTsEl: HTMLParagraphElement | null = null;

let _refreshButtonEl: HTMLButtonElement | null = null;

let _refreshStatusEl: HTMLSpanElement | null = null;

const _ticker = createPollAgoTicker(() => _root);

function setUsage(next: typeof _usage): void {
  _usage = next;
}

function setRoot(next: typeof _root): void {
  _root = next;
}

function setFocusAfterRender(next: typeof _focusAfterRender): void {
  _focusAfterRender = next;
}

function setScreen(next: typeof _screen): void {
  _screen = next;
}

function setDetailScreen(next: typeof _detailScreen): void {
  _detailScreen = next;
}

function setShouldScrollToTop(next: typeof _shouldScrollToTop): void {
  _shouldScrollToTop = next;
}

function setReportAgeEl(next: typeof _reportAgeEl): void {
  _reportAgeEl = next;
}

function setSessionsTsEl(next: typeof _sessionsTsEl): void {
  _sessionsTsEl = next;
}

function setRefreshButtonEl(next: typeof _refreshButtonEl): void {
  _refreshButtonEl = next;
}

function setRefreshStatusEl(next: typeof _refreshStatusEl): void {
  _refreshStatusEl = next;
}

type UsageRenderOptions = { force?: boolean };

let installedRender: (options?: UsageRenderOptions) => void = () => {};

function setUsageRenderer(renderUsagePanel: (options?: UsageRenderOptions) => void): void {
  installedRender = renderUsagePanel;
}

function render(options?: UsageRenderOptions): void {
  installedRender(options);
}

export { _detailScreen, _focusAfterRender, _refreshButtonEl, _refreshStatusEl, _reportAgeEl, _root, _screen, _sessionsTsEl, _shouldScrollToTop, _ticker, _usage, render, setDetailScreen, setFocusAfterRender, setRefreshButtonEl, setRefreshStatusEl, setReportAgeEl, setRoot, setScreen, setSessionsTsEl, setShouldScrollToTop, setUsage, setUsageRenderer };
export type { FocusTarget };
