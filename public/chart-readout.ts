import { el } from './dom-helpers.ts';

export type ChartReadoutCell = { element: HTMLElement; text: string };

type ChartReadoutOptions = {
  className: string;
  initialCell: HTMLElement | undefined;
  isPickedByColumn: boolean;
};

export function attachChartReadout(chart: HTMLElement, cells: ChartReadoutCell[], options: ChartReadoutOptions): HTMLElement {
  const readout = el('p', options.className);
  readout.setAttribute('aria-hidden', 'true');
  const textByCell = new Map(cells.map((cell) => [cell.element, cell.text]));

  function selectCell(cellElement: HTMLElement) {
    const text = textByCell.get(cellElement);
    if (text === undefined) return;
    for (const cell of cells) delete cell.element.dataset.selected;
    cellElement.dataset.selected = 'true';
    readout.textContent = text;
  }

  function horizontalDistance(cellElement: HTMLElement, clientX: number) {
    const bounds = cellElement.getBoundingClientRect();
    return Math.abs(bounds.left + bounds.width / 2 - clientX);
  }

  function cellNearestColumnAt(clientX: number) {
    let nearestCell: HTMLElement | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const cell of cells) {
      const distance = horizontalDistance(cell.element, clientX);
      if (distance >= nearestDistance) continue;
      nearestDistance = distance;
      nearestCell = cell.element;
    }
    return nearestCell;
  }

  function cellUnderPointer(event: PointerEvent) {
    if (options.isPickedByColumn) return cellNearestColumnAt(event.clientX);
    if (event.target instanceof HTMLElement && textByCell.has(event.target)) return event.target;
    return undefined;
  }

  function selectCellUnderPointer(event: PointerEvent) {
    const cellElement = cellUnderPointer(event);
    if (cellElement) selectCell(cellElement);
  }

  chart.addEventListener('pointermove', selectCellUnderPointer);
  chart.addEventListener('pointerdown', selectCellUnderPointer);
  const initialCell = options.initialCell ?? cells.at(-1)?.element;
  if (initialCell) selectCell(initialCell);
  return readout;
}
