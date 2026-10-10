import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFETTI_COLORS, confettiPieceStyleProperties } from '../public/merge-celebration/confetti-core.ts';
import { freeFallDurationMs, GRAVITY_PX_PER_SECOND_SQUARED, randomBetween, shuffled } from '../public/merge-celebration/motion-core.ts';
import {
  CROSSHAIR_START_LEFT_MAX_PERCENT,
  CROSSHAIR_START_LEFT_MIN_PERCENT,
  CROSSHAIR_START_OFFSET_Y_MAX_PX,
  CROSSHAIR_START_OFFSET_Y_MIN_PX,
  headshotCrosshairStyleProperties,
} from '../public/merge-celebration/headshot-core.ts';
import { FLIP_DURATION_MS, ROYAL_FLUSH_RANKS, royalFlushCardLayout, royalFlushTableStyleProperties } from '../public/merge-celebration/royal-flush-core.ts';
import { MERGE_CELEBRATION_SCENES } from '../public/merge-celebration/scenes.ts';
import {
  BALL_SPEED_AFTER_IMPACT_PX_PER_MS,
  PIN_LAUNCH_ANGLE_MAX_DEGREES,
  PIN_LAUNCH_ANGLE_MIN_DEGREES,
  planStrikePinFlights,
  strikeBallLayer,
  strikeLaneStyleProperties,
  strikeRackWidthPx,
} from '../public/merge-celebration/strike-core.ts';
import { swishBallFlight } from '../public/merge-celebration/swish-core.ts';

const alwaysMidpoint = () => 0.5;

function randomFromSequence(values: readonly number[]): () => number {
  let callCount = 0;
  return () => {
    const value = values[callCount % values.length];
    callCount += 1;
    return value;
  };
}

function propertyValue(properties: Array<readonly [string, string]>, propertyName: string): string | undefined {
  return properties.find(([name]) => name === propertyName)?.[1];
}

test('a body falls 390px in exactly one second under the celebration gravity', () => {
  assert.equal(GRAVITY_PX_PER_SECOND_SQUARED, 780);
  assert.equal(freeFallDurationMs(390), 1000);
});

test('a random value between two bounds rounds the injected draw onto the range', () => {
  assert.equal(randomBetween(10, 20, () => 0), 10);
  assert.equal(randomBetween(10, 20, alwaysMidpoint), 15);
  assert.equal(randomBetween(10, 20, () => 0.999), 20);
});

test('shuffling returns a permutation of its input and leaves the input untouched', () => {
  const ranks = Object.freeze([1, 2, 3, 4, 5]);
  const shuffledRanks = shuffled(ranks, () => 0);
  assert.deepEqual(shuffledRanks, [2, 3, 4, 5, 1]);
  assert.deepEqual([...shuffledRanks].sort(), [...ranks]);
  assert.deepEqual(ranks, [1, 2, 3, 4, 5]);
  assert.notEqual(shuffledRanks, ranks);
});

test('strike pins launch at angles spread evenly across the configured range', () => {
  const flights = planStrikePinFlights(alwaysMidpoint);
  assert.equal(flights.length, 10);
  const angleStepDegrees = (PIN_LAUNCH_ANGLE_MAX_DEGREES - PIN_LAUNCH_ANGLE_MIN_DEGREES) / (flights.length - 1);
  const evenlySpreadAngles = flights.map((_, index) => PIN_LAUNCH_ANGLE_MIN_DEGREES + angleStepDegrees * index);
  assert.deepEqual(flights.map((flight) => flight.launchAngleDegrees).sort((left, right) => left - right), evenlySpreadAngles);
});

test('each strike pin launches once the ball has travelled to it after impact', () => {
  const flights = planStrikePinFlights(randomFromSequence([0.1, 0.7, 0.3, 0.9]));
  assert.equal(flights[0].delayMs, 0);
  for (const flight of flights) assert.equal(flight.delayMs, Math.round(flight.distanceFromHeadPinPx / BALL_SPEED_AFTER_IMPACT_PX_PER_MS));
});

test('the strike ball rolls in front of the back two pin depths and behind the front two', () => {
  const flights = planStrikePinFlights(alwaysMidpoint);
  for (const flight of flights) {
    const isFrontPin = flight.depthIndex <= 1;
    assert.equal(flight.layer > strikeBallLayer(), isFrontPin);
  }
  assert.equal(propertyValue(strikeLaneStyleProperties(), '--ball-layer'), String(strikeBallLayer()));
});

test('the strike rack is exactly as wide as the furthest pin reaches', () => {
  const laneProperties = strikeLaneStyleProperties();
  const furthestPinLeftPx = Math.max(...planStrikePinFlights(alwaysMidpoint).map((flight) => flight.distanceFromHeadPinPx));
  assert.equal(propertyValue(laneProperties, '--rack-width'), `${strikeRackWidthPx()}px`);
  assert.equal(`${strikeRackWidthPx() - furthestPinLeftPx}px`, propertyValue(laneProperties, '--pin-width'));
});

test('the swish ball enters the net at the speed it fell through the rim', () => {
  const flight = swishBallFlight();
  const speedFallingThroughRimPxPerSecond = (GRAVITY_PX_PER_SECOND_SQUARED * flight.fallToRimMs) / 1000;
  const speedEnteringNetPxPerSecond = (2 * (flight.heightThroughRimPx - flight.heightLeavingNetPx)) / (flight.netCatchMs / 1000);
  assert.ok(Math.abs(speedEnteringNetPxPerSecond - speedFallingThroughRimPxPerSecond) / speedFallingThroughRimPxPerSecond < 0.01);
});

test('the last royal flush card finishes flipping exactly at impact', () => {
  const lastCardLayout = royalFlushCardLayout(ROYAL_FLUSH_RANKS.length - 1);
  assert.equal(lastCardLayout.flipLeadMs, FLIP_DURATION_MS);
  assert.equal(propertyValue(royalFlushTableStyleProperties(), '--card-flip-ms'), `${FLIP_DURATION_MS}ms`);
});

test('royal flush cards fan symmetrically about the center and span the title edge to edge', () => {
  const layouts = ROYAL_FLUSH_RANKS.map((_, cardIndex) => royalFlushCardLayout(cardIndex));
  layouts.forEach((layout, cardIndex) => {
    const mirroredLayout = layouts[layouts.length - 1 - cardIndex];
    assert.equal(layout.offsetPx + mirroredLayout.offsetPx, 0);
    assert.equal(layout.titleSpreadFraction + mirroredLayout.titleSpreadFraction, 0);
    assert.equal(layout.tiltDegrees + mirroredLayout.tiltDegrees, 0);
    assert.equal(layout.bottomPx, mirroredLayout.bottomPx);
  });
  assert.equal(layouts[0].titleSpreadFraction, -0.5);
  assert.equal(layouts[layouts.length - 1].titleSpreadFraction, 0.5);
});

test('each confetti piece flies for its rise plus its fall and cycles the palette', () => {
  const properties = confettiPieceStyleProperties(CONFETTI_COLORS.length + 1, randomFromSequence([0.25, 0.75]));
  const riseMs = Number.parseInt(propertyValue(properties, '--confetti-rise-ms') ?? '', 10);
  const fallMs = Number.parseInt(propertyValue(properties, '--confetti-fall-ms') ?? '', 10);
  assert.equal(propertyValue(properties, '--confetti-flight-ms'), `${riseMs + fallMs}ms`);
  assert.equal(propertyValue(properties, '--confetti-color'), CONFETTI_COLORS[1]);
});

test('every merge celebration scene has a title to slam in', () => {
  assert.ok(MERGE_CELEBRATION_SCENES.length > 0);
  for (const scene of MERGE_CELEBRATION_SCENES) assert.ok(scene.title.trim().length > 0);
});

test('the headshot crosshair starts anywhere inside its left-hand start area', () => {
  const lowestDraw = headshotCrosshairStyleProperties(() => 0);
  const highestDraw = headshotCrosshairStyleProperties(() => 1);
  assert.equal(propertyValue(lowestDraw, '--crosshair-start-left'), `${CROSSHAIR_START_LEFT_MIN_PERCENT}%`);
  assert.equal(propertyValue(lowestDraw, '--crosshair-start-offset-y'), `${CROSSHAIR_START_OFFSET_Y_MIN_PX}px`);
  assert.equal(propertyValue(highestDraw, '--crosshair-start-left'), `${CROSSHAIR_START_LEFT_MAX_PERCENT}%`);
  assert.equal(propertyValue(highestDraw, '--crosshair-start-offset-y'), `${CROSSHAIR_START_OFFSET_Y_MAX_PX}px`);
});
