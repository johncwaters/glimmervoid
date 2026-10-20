const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function createSvgShape(tag: string, attributes: Record<string, string>): SVGElement {
  const shape = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
  return shape;
}

export function createSvgIcon(width: number, height: number): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('width', String(width));
  icon.setAttribute('height', String(height));
  icon.setAttribute('viewBox', `0 0 ${width} ${height}`);
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

export const CLOSE_ICON_PATH = 'M4 4L12 12M12 4L4 12';
export const SETTINGS_ICON_PATH = 'M12 8a4 4 0 1 1-8 0a4 4 0 1 1 8 0M8 1.5v2.5M8 12v2.5M1.5 8h2.5M12 8h2.5M3.4 3.4l1.77 1.77M10.83 10.83l1.77 1.77M3.4 12.6l1.77-1.77M10.83 5.17l1.77-1.77';
export const TRACE_ICON_PATH = 'M3 4h10M3 8h10M3 12h10';
export const MORE_ICON_PATH = 'M3 8h0.01M8 8h0.01M13 8h0.01';
export const CLOUD_ICON_PATH = 'M4.5 12.5h7a3 3 0 0 0 0.4-5.97a4 4 0 0 0-7.7 0.57a2.7 2.7 0 0 0 0.3 5.4z';

export function createLineIcon(strokePath: string): SVGSVGElement {
  const icon = createSvgIcon(16, 16);
  icon.classList.add('line-icon');
  icon.append(createSvgShape('path', {
    d: strokePath,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }));
  return icon;
}
