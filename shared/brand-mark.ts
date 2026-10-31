export type BrandMarkSide = 'top' | 'right' | 'bottom' | 'left';

export const BRAND_MARK_VIEWBOX = '-4 -4 108 108';

const BRAND_MARK_BRACKETS: ReadonlyArray<{ side: BrandMarkSide; d: string }> = Object.freeze([
  { side: 'top', d: 'M33 29L50 12L67 29' },
  { side: 'right', d: 'M71 33L88 50L71 67' },
  { side: 'bottom', d: 'M67 71L50 88L33 71' },
  { side: 'left', d: 'M29 67L12 50L29 33' },
]);

const BRAND_MARK_LIGHT = 'M50 39L61 50L50 61L39 50Z';

const BRAND_MARK_STROKE_WIDTH = 11;

export const BRAND_INK = '#e8e0ff';

export const BRAND_ACCENT = '#c084fc';

export function brandMarkMarkup({ frame, light, strokeWidth = BRAND_MARK_STROKE_WIDTH }: { frame: string; light: string; strokeWidth?: number }): string {
  const brackets = BRAND_MARK_BRACKETS.map(({ d }) => d).join('');
  return `<path d="${brackets}" fill="none" stroke="${frame}" stroke-width="${strokeWidth}" stroke-linejoin="miter" stroke-linecap="butt"/><path d="${BRAND_MARK_LIGHT}" fill="${light}"/>`;
}
