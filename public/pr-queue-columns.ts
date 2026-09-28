import { wireColumnResizer } from './column-resizer.ts';
import { el } from './dom-helpers.ts';
import { getPrsQueueWidth, isPrsQueueCollapsed, setPrsQueueCollapsed, setPrsQueueWidth } from './ui-prefs.ts';

const QUEUE_BOUNDS = { minPx: 220, maxPx: 720 };
const QUEUE_KEY_STEP_PX = 16;

interface PrQueueColumnsOptions {
  queueLabel: string;
  minimizeTitle?: string;
  expandTitle?: string;
  resizerLabel: string;
}

const liveQueueColumns = new Set<HTMLElement>();

function applyStoredQueueLayout(columns: HTMLElement): void {
  columns.toggleAttribute('data-queue-collapsed', isPrsQueueCollapsed());
  const width = getPrsQueueWidth();
  if (width === null) {
    columns.style.removeProperty('--pr-queue-width');
    return;
  }
  columns.style.setProperty('--pr-queue-width', `${width}px`);
}

export function resyncPrQueueLayouts(): void {
  for (const columns of liveQueueColumns) {
    if (!columns.isConnected) {
      liveQueueColumns.delete(columns);
      continue;
    }
    applyStoredQueueLayout(columns);
  }
}

export function createPrQueueColumns({ queueLabel, minimizeTitle, expandTitle, resizerLabel }: PrQueueColumnsOptions): {
  columns: HTMLElement;
  queue: HTMLElement;
  detail: HTMLElement;
} {
  const columns = el('div', 'pr-columns');
  const pane = el('div', 'pr-queue-pane');
  const head = el('div', 'pr-queue-head');
  const minimizeButton = el('button', 'review-btn pr-queue-minimize', 'Minimize');
  minimizeButton.type = 'button';
  if (minimizeTitle) minimizeButton.title = minimizeTitle;
  minimizeButton.addEventListener('click', () => {
    columns.toggleAttribute('data-queue-collapsed', true);
    setPrsQueueCollapsed(true);
  });
  head.append(minimizeButton);
  const queue = el('nav', 'pr-queue');
  queue.setAttribute('aria-label', queueLabel);
  pane.append(head, queue);
  const expandButton = el('button', 'pr-queue-expand', 'Show queue');
  expandButton.type = 'button';
  if (expandTitle) expandButton.title = expandTitle;
  expandButton.addEventListener('click', () => {
    columns.toggleAttribute('data-queue-collapsed', false);
    setPrsQueueCollapsed(false);
  });
  const resizer = el('div', 'pr-queue-resizer');
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-label', resizerLabel);
  resizer.tabIndex = 0;
  const detail = el('main', 'pr-detail-host');
  columns.append(expandButton, pane, resizer, detail);
  applyStoredQueueLayout(columns);
  liveQueueColumns.add(columns);
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
  return { columns, queue, detail };
}
