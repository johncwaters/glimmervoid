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
export const CHECK_ICON_PATH = 'M3 8.5L6.5 12L13 4';
export const UNDO_ICON_PATH = 'M5.5 3.5l-3 3l3 3 M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7';
export const REDO_ICON_PATH = 'M10.5 3.5l3 3l-3 3 M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H9';
export const PLUS_ICON_PATH = 'M8 3v10M3 8h10';
export const BACK_ICON_PATH = 'M10 3L5 8L10 13';
export const HELP_ICON_PATH = 'M5.1 5.3a3 3 0 1 1 4.2 2.9c-0.8 0.3-1.3 1-1.3 1.8v0.6 M8 13.3h0.01';
export const MUSIC_NOTE_ICON_PATH = 'M9.5 11.5a2.25 2.25 0 1 1-4.5 0a2.25 2.25 0 1 1 4.5 0z M9.5 11.5V2 M9.5 2c0.6 1.6 3 2.2 3 4.5';
export const TROPHY_ICON_PATH = 'M4.5 2h7v3.5a3.5 3.5 0 0 1-7 0z M4.5 3.5H2.5a2 2 0 0 0 2 2.5 M11.5 3.5h2a2 2 0 0 1-2 2.5 M8 9v3 M5.5 14h5';
export const FORWARD_ICON_PATH = 'M6 3L11 8L6 13';
export const MORE_ICON_PATH = 'M3 8h0.01M8 8h0.01M13 8h0.01';
export const MENU_ICON_PATH = 'M2.5 4h11M2.5 8h11M2.5 12h11';
export const CHANGES_ICON_PATH = 'M8 2.5v6M5 5.5h6M5 12.5h6';
export const CLOUD_ICON_PATH = 'M4.5 12.5h7a3 3 0 0 0 0.4-5.97a4 4 0 0 0-7.7 0.57a2.7 2.7 0 0 0 0.3 5.4z';
export const TERMINAL_ICON_PATH = 'M3 4.5L6.5 8L3 11.5 M8.5 11.5h4.5';
export const USAGE_ICON_PATH = 'M3 13V9M8 13V3M13 13V6.5';
export const FOCUS_ICON_PATH = 'M2.5 5.5v-3h3 M10.5 2.5h3v3 M13.5 10.5v3h-3 M5.5 13.5h-3v-3 M8 5c0.3 1.6 1.4 2.7 3 3c-1.6 0.3-2.7 1.4-3 3c-0.3-1.6-1.4-2.7-3-3c1.6-0.3 2.7-1.4 3-3z';
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
