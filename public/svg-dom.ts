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
export const BACK_ICON_PATH = 'M10 3L5 8L10 13';
export const MORE_ICON_PATH = 'M3 8h0.01M8 8h0.01M13 8h0.01';
export const CHANGES_ICON_PATH = 'M8 2.5v6M5 5.5h6M5 12.5h6';
export const CLOUD_ICON_PATH = 'M4.5 12.5h7a3 3 0 0 0 0.4-5.97a4 4 0 0 0-7.7 0.57a2.7 2.7 0 0 0 0.3 5.4z';
export const SHIELD_ICON_PATH = 'M8 1.8l5.2 2v4c0 3.2-2.2 5.4-5.2 6.4c-3-1-5.2-3.2-5.2-6.4v-4z';
export const BOLT_ICON_PATH = 'M9.2 1.5L3.5 9h4.3l-1 5.5L12.5 7H8.2z';
export const SHIELDED_BOLT_FILL_PATH = 'M8.7 4.2L5.6 8.6h2.5l-.6 3.2l3.1-4.4H8.1z';
export const TERMINAL_ICON_PATH = 'M3 4.5L6.5 8L3 11.5 M8.5 11.5h4.5';
export const IMAGE_ICON_PATH = 'M2.5 3.5h11v9h-11z M2.5 10.5l3-3l3 3l2-2l3 3 M10.5 6.2h0.01';
export const USAGE_ICON_PATH = 'M3 13V9M8 13V3M13 13V6.5';
export const FOCUS_ICON_PATH = 'M2.5 2.5h11v11h-11z M5.5 5.5h5v5h-5z';
export const BOARDS_ICON_PATH = 'M3 1.5v12.5 M3 1.5h4a2.75 2.75 0 0 1 0 5.5H3 M3 7h5a3 3 0 0 1 0 6H5 M6.75 11.25L5 13l1.75 1.75';
export const REVIEWS_ICON_PATH = 'M5 13V3M2.5 5.5L5 3l2.5 2.5 M11 3v10M8.5 10.5L11 13l2.5-2.5';
export const ISSUES_ICON_PATH = 'M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0z M8 8h0.01';
export const RADAR_ICON_PATH = 'M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0z M8 8L11.5 4.5';
export const COMMUNITY_ICON_PATH = 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z';
export const HOOKS_ICON_PATH = 'M10.5 2.5v7.5a3 3 0 0 1 -6 0V7.5 M4.5 7.5l2 2';
export const TRACE_ICON_PATH = 'M2 8.5h3l2 -5l2 9l2 -4h3';
export const BENCH_ICON_PATH = 'M3.5 9a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0z M8 9V6.5 M6.5 2h3';
export const SETTINGS_ICON_PATH = 'M2.5 5h11 M2.5 11h11 M6 3v4 M10 9v4';

export function createLineIcon(strokePath: string, strokeWidth = '2'): SVGSVGElement {
  const icon = createSvgIcon(16, 16);
  icon.classList.add('line-icon');
  icon.append(createSvgShape('path', {
    d: strokePath,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': strokeWidth,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }));
  return icon;
}
