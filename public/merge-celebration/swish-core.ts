import { freeFallDurationMs, GRAVITY_PX_PER_SECOND_SQUARED } from './motion-core.ts';

const BALL_LAUNCH_HEIGHT_PX = 20;
const BALL_PEAK_HEIGHT_PX = 92;
const BALL_HEIGHT_THROUGH_RIM_PX = 23;
const BALL_HEIGHT_LEAVING_NET_PX = 7;
const BALL_HEIGHT_OUT_OF_CARD_PX = -40;

export function swishBallFlight() {
  const riseMs = freeFallDurationMs(BALL_PEAK_HEIGHT_PX - BALL_LAUNCH_HEIGHT_PX);
  const fallToRimMs = freeFallDurationMs(BALL_PEAK_HEIGHT_PX - BALL_HEIGHT_THROUGH_RIM_PX);
  const speedThroughRimPxPerSecond = (GRAVITY_PX_PER_SECOND_SQUARED * fallToRimMs) / 1000;
  const netCatchMs = Math.round(((2 * (BALL_HEIGHT_THROUGH_RIM_PX - BALL_HEIGHT_LEAVING_NET_PX)) / speedThroughRimPxPerSecond) * 1000);
  return {
    launchHeightPx: BALL_LAUNCH_HEIGHT_PX,
    peakHeightPx: BALL_PEAK_HEIGHT_PX,
    heightThroughRimPx: BALL_HEIGHT_THROUGH_RIM_PX,
    heightLeavingNetPx: BALL_HEIGHT_LEAVING_NET_PX,
    heightOutOfCardPx: BALL_HEIGHT_OUT_OF_CARD_PX,
    riseMs,
    fallToRimMs,
    speedThroughRimPxPerSecond,
    netCatchMs,
    dropMs: freeFallDurationMs(BALL_HEIGHT_LEAVING_NET_PX - BALL_HEIGHT_OUT_OF_CARD_PX),
  };
}

type SwishBallFlight = ReturnType<typeof swishBallFlight>;

export function swishCourtStyleProperties(flight: SwishBallFlight = swishBallFlight()): Array<readonly [string, string]> {
  return [
    ['--ball-launch-y', `${-flight.launchHeightPx}px`],
    ['--ball-peak-y', `${-flight.peakHeightPx}px`],
    ['--ball-rim-y', `${-flight.heightThroughRimPx}px`],
    ['--ball-net-exit-y', `${-flight.heightLeavingNetPx}px`],
    ['--ball-drop-out-y', `${-flight.heightOutOfCardPx}px`],
    ['--ball-rise-ms', `${flight.riseMs}ms`],
    ['--ball-fall-to-rim-ms', `${flight.fallToRimMs}ms`],
    ['--ball-to-rim-ms', `${flight.riseMs + flight.fallToRimMs}ms`],
    ['--ball-net-catch-ms', `${flight.netCatchMs}ms`],
    ['--ball-drop-ms', `${flight.dropMs}ms`],
  ];
}
