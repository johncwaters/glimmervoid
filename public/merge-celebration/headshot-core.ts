import { randomBetween } from './motion-core.ts';

export const CROSSHAIR_START_LEFT_MIN_PERCENT = 6;
export const CROSSHAIR_START_LEFT_MAX_PERCENT = 30;
export const CROSSHAIR_START_OFFSET_Y_MIN_PX = -14;
export const CROSSHAIR_START_OFFSET_Y_MAX_PX = 16;

export function headshotCrosshairStyleProperties(random: () => number = Math.random): Array<readonly [string, string]> {
  return [
    ['--crosshair-start-left', `${randomBetween(CROSSHAIR_START_LEFT_MIN_PERCENT, CROSSHAIR_START_LEFT_MAX_PERCENT, random)}%`],
    ['--crosshair-start-offset-y', `${randomBetween(CROSSHAIR_START_OFFSET_Y_MIN_PX, CROSSHAIR_START_OFFSET_Y_MAX_PX, random)}px`],
  ];
}
