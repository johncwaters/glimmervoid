import { randomBetween } from './motion-core.ts';

export const CONFETTI_COLORS = ['var(--accent)', 'var(--state-running)', 'var(--state-idle)', 'var(--state-waiting)', 'var(--state-failed)'];

export function confettiPieceStyleProperties(pieceIndex: number, random: () => number = Math.random): Array<readonly [string, string]> {
  const riseMs = randomBetween(320, 520, random);
  const fallMs = randomBetween(1800, 2800, random);
  return [
    ['--confetti-start-x', `${randomBetween(4, 96, random)}%`],
    ['--confetti-x', `${randomBetween(-140, 140, random)}px`],
    ['--confetti-rise', `${-randomBetween(20, 55, random)}px`],
    ['--confetti-fall', `${randomBetween(45, 70, random)}vh`],
    ['--confetti-rise-ms', `${riseMs}ms`],
    ['--confetti-fall-ms', `${fallMs}ms`],
    ['--confetti-flight-ms', `${riseMs + fallMs}ms`],
    ['--confetti-tilt', `${randomBetween(0, 180, random)}deg`],
    ['--confetti-spin', `${randomBetween(-360, 360, random)}deg`],
    ['--confetti-flutter-ms', `${randomBetween(160, 340, random)}ms`],
    ['--confetti-delay', `${randomBetween(0, 160, random)}ms`],
    ['--confetti-color', CONFETTI_COLORS[pieceIndex % CONFETTI_COLORS.length]],
  ];
}
