import type { StatusIcon } from '#shared/state-icons.ts';
import { STATUS_ICON_SHAPES } from '#shared/state-icons.ts';
import { createSvgIcon, createSvgShape } from './svg-dom.ts';

function createShapeLayer(tag: string, attributes: Readonly<Record<string, string>>): SVGSVGElement {
  const { class: animationClass, ...shapeAttributes } = attributes;
  const layer = createSvgIcon(16, 16);
  if (animationClass !== undefined) layer.classList.add(animationClass);
  layer.append(createSvgShape(tag, shapeAttributes));
  return layer;
}

function createStatusIcon(icon: StatusIcon): HTMLSpanElement {
  const stack = document.createElement('span');
  stack.className = 'status-icon';
  stack.dataset.icon = icon;
  for (const shape of STATUS_ICON_SHAPES[icon]) stack.append(createShapeLayer(shape.tag, shape.attributes));
  return stack;
}

export function paintStatusIcon(container: HTMLElement, icon: StatusIcon): void {
  if (container.dataset.icon === icon) return;
  container.dataset.icon = icon;
  container.replaceChildren(createStatusIcon(icon));
}
