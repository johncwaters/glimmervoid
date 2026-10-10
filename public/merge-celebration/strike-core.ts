import { freeFallDurationMs, GRAVITY_PX_PER_SECOND_SQUARED, randomBetween, shuffled } from './motion-core.ts';

const PIN_ROW_SIZES = [1, 2, 3, 4];
const PIN_ROW_SPACING_PX = 14;
const PIN_DEPTH_SHIFT_X_PX = 3;
const PIN_DEPTH_SHIFT_Y_PX = 3;
const PIN_WIDTH_PX = 10;
const PIN_FRONT_LAYER = 20;
const PIN_LAYER_STEP_PER_DEPTH = 2;
const RACK_RIGHT_INSET_PX = 28;
const BALL_DIAMETER_PX = 18;
const BALL_ROLLING_DEPTH = 1.5;
const BALL_APPROACH_SPIN_DEGREES = 2200;
const BALL_OVERLAP_INTO_HEAD_PIN_PX = 1;
const BALL_FOLLOW_THROUGH_PX = 120;
const BALL_SPEED_AFTER_IMPACT_PX_PER_MS = 0.35;
export const PIN_LAUNCH_ANGLE_MIN_DEGREES = 15;
export const PIN_LAUNCH_ANGLE_MAX_DEGREES = 105;
const PIN_LAUNCH_ANGLE_JITTER_DEGREES = 4;
const PIN_DEPTH_SCALE_MIN_PERCENT = 65;
const PIN_DEPTH_SCALE_MAX_PERCENT = 145;

interface PinPosition {
  rowIndex: number;
  depthIndex: number;
}

interface PinLaunch {
  angleDegrees: number;
  depthScalePercent: number;
}

export interface StrikePinFlight {
  depthIndex: number;
  launchAngleDegrees: number;
  distanceFromHeadPinPx: number;
  layer: number;
  flyXPx: number;
  peakRisePx: number;
  landingDropPx: number;
  riseMs: number;
  fallMs: number;
  flightMs: number;
  spinDegrees: number;
  glintMs: number;
  depthScalePercent: number;
  delayMs: number;
}

function rollingSpinDegrees(distancePx: number): number {
  return Math.round((distancePx / (Math.PI * BALL_DIAMETER_PX)) * 360);
}

function layerAtDepth(depth: number): number {
  return PIN_FRONT_LAYER - depth * PIN_LAYER_STEP_PER_DEPTH;
}

function distanceFromHeadPinPx(position: PinPosition): number {
  return position.rowIndex * PIN_ROW_SPACING_PX + position.depthIndex * PIN_DEPTH_SHIFT_X_PX;
}

function spreadEvenly(min: number, max: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1));
}

function pinPositions(): PinPosition[] {
  return PIN_ROW_SIZES.flatMap((rowSize, rowIndex) =>
    Array.from({ length: rowSize }, (_, backToFrontIndex) => ({ rowIndex, depthIndex: rowSize - 1 - backToFrontIndex })),
  );
}

function createPinLaunches(pinCount: number, random: () => number): PinLaunch[] {
  const angles = shuffled(spreadEvenly(PIN_LAUNCH_ANGLE_MIN_DEGREES, PIN_LAUNCH_ANGLE_MAX_DEGREES, pinCount), random);
  const depthScales = shuffled(spreadEvenly(PIN_DEPTH_SCALE_MIN_PERCENT, PIN_DEPTH_SCALE_MAX_PERCENT, pinCount), random);
  return angles.map((angle, index) => ({
    angleDegrees: angle + randomBetween(-PIN_LAUNCH_ANGLE_JITTER_DEGREES, PIN_LAUNCH_ANGLE_JITTER_DEGREES, random),
    depthScalePercent: Math.round(depthScales[index]),
  }));
}

function planPinFlight(position: PinPosition, launch: PinLaunch, random: () => number): StrikePinFlight {
  const launchSpeedPxPerSecond = randomBetween(240, 380, random);
  const launchAngleRadians = (launch.angleDegrees * Math.PI) / 180;
  const horizontalSpeedPxPerSecond = launchSpeedPxPerSecond * Math.cos(launchAngleRadians);
  const verticalSpeedPxPerSecond = launchSpeedPxPerSecond * Math.sin(launchAngleRadians);
  const peakHeightPx = verticalSpeedPxPerSecond ** 2 / (2 * GRAVITY_PX_PER_SECOND_SQUARED);
  const landingDropPx = randomBetween(15, 45, random);
  const riseMs = freeFallDurationMs(peakHeightPx);
  const fallMs = freeFallDurationMs(peakHeightPx + landingDropPx);
  const flightMs = riseMs + fallMs;
  const spinDegreesPerSecond = randomBetween(540, 1080, random);
  const spinDirection = horizontalSpeedPxPerSecond >= 0 ? 1 : -1;
  const pinDistanceFromHeadPinPx = distanceFromHeadPinPx(position);
  return {
    depthIndex: position.depthIndex,
    launchAngleDegrees: launch.angleDegrees,
    distanceFromHeadPinPx: pinDistanceFromHeadPinPx,
    layer: layerAtDepth(position.depthIndex),
    flyXPx: Math.round((horizontalSpeedPxPerSecond * flightMs) / 1000),
    peakRisePx: Math.round(peakHeightPx),
    landingDropPx,
    riseMs,
    fallMs,
    flightMs,
    spinDegrees: Math.round((spinDirection * spinDegreesPerSecond * flightMs) / 1000),
    glintMs: Math.round((180 / spinDegreesPerSecond) * 1000),
    depthScalePercent: launch.depthScalePercent,
    delayMs: Math.round(pinDistanceFromHeadPinPx / BALL_SPEED_AFTER_IMPACT_PX_PER_MS),
  };
}

export function planStrikePinFlights(random: () => number = Math.random): StrikePinFlight[] {
  const positions = pinPositions();
  const launches = createPinLaunches(positions.length, random);
  return positions.map((position, pinIndex) => planPinFlight(position, launches[pinIndex], random));
}

export function strikePinStyleProperties(flight: StrikePinFlight): Array<readonly [string, string]> {
  return [
    ['--pin-left', `${flight.distanceFromHeadPinPx}px`],
    ['--pin-raise', `${flight.depthIndex * PIN_DEPTH_SHIFT_Y_PX}px`],
    ['--pin-shade', `${100 - flight.depthIndex * 12}%`],
    ['--pin-fly-x', `${flight.flyXPx}px`],
    ['--pin-peak-y', `${-flight.peakRisePx}px`],
    ['--pin-land-y', `${flight.landingDropPx}px`],
    ['--pin-rise-ms', `${flight.riseMs}ms`],
    ['--pin-fall-ms', `${flight.fallMs}ms`],
    ['--pin-flight-ms', `${flight.flightMs}ms`],
    ['--pin-spin', `${flight.spinDegrees}deg`],
    ['--pin-glint-ms', `${flight.glintMs}ms`],
    ['--pin-depth-scale', `${flight.depthScalePercent}%`],
    ['--pin-depth-shade', `${flight.depthScalePercent - 10}%`],
    ['--pin-delay', `${flight.delayMs}ms`],
    ['--pin-layer', String(flight.layer)],
  ];
}

export function strikeBallLayer(): number {
  return layerAtDepth(BALL_ROLLING_DEPTH);
}

export function strikeRackWidthPx(): number {
  return Math.max(...pinPositions().map(distanceFromHeadPinPx)) + PIN_WIDTH_PX;
}

export function strikeLaneStyleProperties(): Array<readonly [string, string]> {
  const rackWidthPx = strikeRackWidthPx();
  const ballImpactInsetPx = RACK_RIGHT_INSET_PX + rackWidthPx + BALL_DIAMETER_PX - BALL_OVERLAP_INTO_HEAD_PIN_PX;
  return [
    ['--ball-follow-px', `${BALL_FOLLOW_THROUGH_PX}px`],
    ['--ball-follow-ms', `${Math.round(BALL_FOLLOW_THROUGH_PX / BALL_SPEED_AFTER_IMPACT_PX_PER_MS)}ms`],
    ['--ball-follow-spin', `${rollingSpinDegrees(BALL_FOLLOW_THROUGH_PX)}deg`],
    ['--ball-size', `${BALL_DIAMETER_PX}px`],
    ['--ball-approach-spin', `${BALL_APPROACH_SPIN_DEGREES}deg`],
    ['--ball-impact-inset', `${ballImpactInsetPx}px`],
    ['--ball-layer', String(strikeBallLayer())],
    ['--rack-right', `${RACK_RIGHT_INSET_PX}px`],
    ['--rack-width', `${rackWidthPx}px`],
    ['--pin-width', `${PIN_WIDTH_PX}px`],
  ];
}
