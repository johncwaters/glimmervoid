const SPRITE_FRAME_WIDTH_PX = 68;
const SPRITE_FRAME_HEIGHT_PX = 42;
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
    spriteWidthPx: SPRITE_FRAME_WIDTH_PX,
    spriteHeightPx: SPRITE_FRAME_HEIGHT_PX,
    topPx: Math.max(requestedTopPx, MIN_TOP_PX),
    startXpx: -0.45 * viewportWidthPx,
    endXpx: 1.45 * viewportWidthPx,
  };
}

type NyanGeometry = ReturnType<typeof deriveNyanGeometry>;

function snapPixelArtScale(requestedScale: number, devicePixelRatio: number): number {
  const deviceScale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const devicePixelsPerArtPixel = Math.max(1, Math.round(requestedScale * deviceScale));
  return devicePixelsPerArtPixel / deviceScale;
}

export function nyanFlightStyleProperties(geometry: NyanGeometry, scaleMultiplier: number, devicePixelRatio: number): Array<readonly [string, string]> {
  return [
    ['--nyan-top', `${geometry.topPx}px`],
    ['--nyan-scale', String(snapPixelArtScale(geometry.scale * scaleMultiplier, devicePixelRatio))],
    ['--nyan-width', `${geometry.spriteWidthPx}px`],
    ['--nyan-height', `${geometry.spriteHeightPx}px`],
    ['--nyan-start-x', `${geometry.startXpx}px`],
    ['--nyan-end-x', `${geometry.endXpx}px`],
  ];
}
