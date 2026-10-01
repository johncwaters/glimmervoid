const DESKTOP_SPRITE_WIDTH_PX = 61.2;
const DESKTOP_SPRITE_HEIGHT_PX = 37.8;
const NARROW_VIEWPORT_WIDTH_PX = 768;
const MIN_NARROW_SCALE = 0.68;
const MIN_TOP_PX = 64;
const MIN_TOP_VH = 5;
const MAX_TOP_VH = 75;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function deriveNyanGeometry({
  viewportWidthPx,
  viewportHeightPx,
  verticalProgress,
}: {
  viewportWidthPx: number;
  viewportHeightPx: number;
  verticalProgress: number;
}) {
  const scale = clamp(viewportWidthPx / NARROW_VIEWPORT_WIDTH_PX, MIN_NARROW_SCALE, 1);
  const requestedTopPx = (MIN_TOP_VH + (MAX_TOP_VH - MIN_TOP_VH) * verticalProgress * verticalProgress) * viewportHeightPx / 100;

  return {
    scale,
    spriteWidthPx: DESKTOP_SPRITE_WIDTH_PX,
    spriteHeightPx: DESKTOP_SPRITE_HEIGHT_PX,
    topPx: Math.max(requestedTopPx, MIN_TOP_PX),
    startXpx: -0.45 * viewportWidthPx,
    endXpx: 1.45 * viewportWidthPx,
  };
}

export type NyanGeometry = ReturnType<typeof deriveNyanGeometry>;

export function nyanFlightStyleProperties(geometry: NyanGeometry, scaleMultiplier: number): Array<readonly [string, string]> {
  return [
    ['--nyan-top', `${geometry.topPx}px`],
    ['--nyan-scale', String(geometry.scale * scaleMultiplier)],
    ['--nyan-width', `${geometry.spriteWidthPx}px`],
    ['--nyan-height', `${geometry.spriteHeightPx}px`],
    ['--nyan-start-x', `${geometry.startXpx}px`],
    ['--nyan-end-x', `${geometry.endXpx}px`],
  ];
}
