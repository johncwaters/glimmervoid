import { wireColumnResizer } from '../column-resizer.ts';
import { el } from '../dom-helpers.ts';
import { getPrsQueueWidth, setPrsQueueWidth } from '../ui-prefs.ts';

const QUEUE_BOUNDS = { minPx: 220, maxPx: 720 };
const QUEUE_KEY_STEP_PX = 16;

interface PrQueueColumnsOptions {
  queueLabel: string;
  scopeTabs: HTMLElement | null;
  resizerLabel: string;
}

function applyStoredQueueWidth(columns: HTMLElement): void {
  const width = getPrsQueueWidth();
  if (width === null) {
    columns.style.removeProperty('--pr-queue-width');
    return;
  }
  columns.style.setProperty('--pr-queue-width', `${width}px`);
}

function createPrQueueHead(scopeTabs: HTMLElement): HTMLElement {
  const head = el('div', 'pr-queue-head');
  head.append(scopeTabs);
  return head;
}

export function createPrQueueFoot(control: HTMLElement | null): HTMLElement {
  const foot = el('div', 'pr-queue-foot');
  if (control) foot.append(control);
  return foot;
}

export function createPrQueueColumns({ queueLabel, scopeTabs, resizerLabel }: PrQueueColumnsOptions): {
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
  const resizer = el('div', 'pr-queue-resizer');
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-label', resizerLabel);
  resizer.tabIndex = 0;
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
  return { columns, queue, foot, detail };
}
