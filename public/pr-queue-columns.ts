import { wireColumnResizer } from './column-resizer.ts';
import { el } from './dom-helpers.ts';
import { createSvgIcon, createSvgShape } from './state-glyph.ts';
import { getPrsQueueWidth, isPrsQueueCollapsed, setPrsQueueCollapsed, setPrsQueueWidth } from './ui-prefs.ts';

const QUEUE_BOUNDS = { minPx: 220, maxPx: 720 };
const QUEUE_KEY_STEP_PX = 16;

interface PrQueueColumnsOptions {
  queueLabel: string;
  scopeTabs: HTMLElement;
  resizerLabel: string;
}

const liveQueueColumns = new Set<HTMLElement>();
let nextQueueId = 0;

function applyStoredQueueLayout(columns: HTMLElement): void {
  const isCollapsed = isPrsQueueCollapsed();
  columns.toggleAttribute('data-queue-collapsed', isCollapsed);
  columns.querySelector('.pr-queue-toggle')?.setAttribute('aria-expanded', String(!isCollapsed));
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

export function createPrQueueHead(scopeTabs: HTMLElement | null, toggle?: HTMLElement): HTMLElement {
  const head = el('div', 'pr-queue-head');
  if (scopeTabs) head.append(scopeTabs);
  if (toggle) head.append(toggle);
  return head;
}

export function createPrQueueColumns({ queueLabel, scopeTabs, resizerLabel }: PrQueueColumnsOptions): {
  columns: HTMLElement;
  queue: HTMLElement;
  detail: HTMLElement;
} {
  const columns = el('div', 'pr-columns');
  const pane = el('div', 'pr-queue-pane');
  const queue = el('nav', 'pr-queue');
  queue.id = `pr-queue-${++nextQueueId}`;
  queue.setAttribute('aria-label', queueLabel);
  const toggle = el('button', 'pr-queue-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Review queue');
  toggle.setAttribute('aria-controls', queue.id);
  toggle.title = 'Collapse or expand the review queue';
  const icon = createSvgIcon(16, 16);
  icon.append(createSvgShape('rect', { x: '1.5', y: '2', width: '13', height: '12', rx: '2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' }));
  icon.append(createSvgShape('path', { d: 'M5.5 2V14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' }));
  const chevron = createSvgShape('path', { d: 'M11 6L9 8L11 10', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  chevron.classList.add('pr-queue-chevron');
  icon.append(chevron);
  toggle.append(icon);
  toggle.addEventListener('click', () => {
    setPrsQueueCollapsed(!isPrsQueueCollapsed());
    resyncPrQueueLayouts();
  });
  pane.append(createPrQueueHead(scopeTabs, toggle), queue);
  const resizer = el('div', 'pr-queue-resizer');
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-label', resizerLabel);
  resizer.tabIndex = 0;
  const detail = el('main', 'pr-detail-host');
  columns.append(pane, resizer, detail);
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
