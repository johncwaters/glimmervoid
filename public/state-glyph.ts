import type { StateTone } from './state-tone-core.ts';

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

export function createStateGlyph(tone: StateTone): SVGSVGElement {
  const glyph = createSvgIcon(12, 12);
  glyph.classList.add('state-glyph');
  glyph.dataset.tone = tone;
  if (tone === 'danger') glyph.append(createSvgShape('path', { d: 'M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' }));
  if (tone === 'warn') glyph.append(createSvgShape('path', { d: 'M6 1L11 6L6 11L1 6Z', fill: 'currentColor' }));
  if (tone === 'wait') glyph.append(createSvgShape('circle', { cx: '6', cy: '6', r: '4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }));
  if (tone === 'ok') glyph.append(createSvgShape('path', { d: 'M2 6L4.5 8.5L10 3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  if (tone === 'muted') glyph.append(createSvgShape('path', { d: 'M3 6H9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' }));
  return glyph;
}
