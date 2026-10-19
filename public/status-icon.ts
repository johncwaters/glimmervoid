import type { StatusIcon } from '#shared/state-icons.ts';
import { STATUS_ICON_SHAPES } from '#shared/state-icons.ts';
import { createSvgIcon, createSvgShape } from './svg-dom.ts';

export function createStatusIcon(icon: StatusIcon): SVGSVGElement {
  const svg = createSvgIcon(16, 16);
  svg.classList.add('status-icon');
  svg.dataset.icon = icon;
  for (const shape of STATUS_ICON_SHAPES[icon]) svg.append(createSvgShape(shape.tag, shape.attributes));
  return svg;
}

export function paintStatusIcon(container: HTMLElement, icon: StatusIcon): void {
  if (container.dataset.icon === icon) return;
  container.dataset.icon = icon;
  container.replaceChildren(createStatusIcon(icon));
}
