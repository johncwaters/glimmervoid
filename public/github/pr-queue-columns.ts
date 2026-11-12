import { wireColumnResizer } from '../column-resizer.ts';
import { el } from '../dom-helpers.ts';
import { getPrsQueueWidth, setPrsQueueWidth } from '../ui-prefs.ts';

const QUEUE_BOUNDS = { minPx: 220, maxPx: 720 };
const QUEUE_KEY_STEP_PX = 16;
const DETAIL_BOUNDS = { minPx: 360, maxPx: 960 };
const BOARD_RESERVE_PX = 327;

interface DetailResizerOptions {
  label: string;
  getStoredWidth: () => number | null;
  setStoredWidth: (px: number | null) => void;
}

interface PrQueueColumnsOptions {
  queueLabel: string;
  scopeTabs: HTMLElement | null;
  resizerLabel: string;
  detailResizer?: DetailResizerOptions;
}

function applyStoredQueueWidth(columns: HTMLElement): void {
  const width = getPrsQueueWidth();
  if (width === null) {
    columns.style.removeProperty('--pr-queue-width');
    return;
  }
  columns.style.setProperty('--pr-queue-width', `${width}px`);
}

function createSeparator(className: string, label: string): HTMLElement {
  const separator = el('div', className);
  separator.setAttribute('role', 'separator');
  separator.setAttribute('aria-orientation', 'vertical');
  separator.setAttribute('aria-label', label);
  separator.tabIndex = 0;
  return separator;
}

function appendDetailResizer(columns: HTMLElement, detail: HTMLElement, { label, getStoredWidth, setStoredWidth }: DetailResizerOptions): void {
  const resizer = createSeparator('pr-queue-resizer pr-detail-resizer', label);
  detail.before(resizer);
  wireColumnResizer({
    resizer,
    column: detail,
    widthHost: columns,
    widthProperty: '--pr-detail-width',
    bounds: DETAIL_BOUNDS,
    keyStepPx: QUEUE_KEY_STEP_PX,
    getStoredWidth,
    setStoredWidth,
    growsLeftward: true,
    reservePx: BOARD_RESERVE_PX,
  });
}

function createPrQueueHead(scopeTabs: HTMLElement): HTMLElement {
  const head = el('div', 'pr-queue-head');
  head.append(scopeTabs);
  return head;
}

function createPrQueueFoot(control: HTMLElement | null): HTMLElement {
  const foot = el('div', 'pr-queue-foot');
  if (control) foot.append(control);
  return foot;
}

export function createPrQueueColumns({ queueLabel, scopeTabs, resizerLabel, detailResizer }: PrQueueColumnsOptions): {
  columns: HTMLElement;
  queue: HTMLElement;
  foot: HTMLElement;
  detail: HTMLElement;
} {
  const columns = el('div', 'pr-columns');
  const pane = el('div', 'pr-queue-pane');
  const queue = el('nav', 'pr-queue');
  queue.setAttribute('aria-label', queueLabel);
  const foot = createPrQueueFoot(null);
  if (scopeTabs) pane.append(createPrQueueHead(scopeTabs));
  pane.append(queue, foot);
  const resizer = createSeparator('pr-queue-resizer', resizerLabel);
  const detail = el('main', 'pr-detail-host');
  columns.append(pane, resizer, detail);
  applyStoredQueueWidth(columns);
  wireColumnResizer({
    resizer,
    column: pane,
    widthHost: columns,
    widthProperty: '--pr-queue-width',
    bounds: QUEUE_BOUNDS,
    keyStepPx: QUEUE_KEY_STEP_PX,
    getStoredWidth: getPrsQueueWidth,
    setStoredWidth: setPrsQueueWidth,
  });
  if (detailResizer) appendDetailResizer(columns, detail, detailResizer);
  return { columns, queue, foot, detail };
}
