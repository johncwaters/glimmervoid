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
