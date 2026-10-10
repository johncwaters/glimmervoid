export const GRAVITY_PX_PER_SECOND_SQUARED = 780;

export function freeFallDurationMs(distancePx: number): number {
  return Math.round(Math.sqrt((2 * distancePx) / GRAVITY_PX_PER_SECOND_SQUARED) * 1000);
}

export function randomBetween(min: number, max: number, random: () => number = Math.random): number {
  return Math.round(min + random() * (max - min));
}

export function shuffled<Item>(items: readonly Item[], random: () => number = Math.random): Item[] {
  const shuffledItems = [...items];
  for (let index = shuffledItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffledItems[index], shuffledItems[swapIndex]] = [shuffledItems[swapIndex], shuffledItems[index]];
  }
  return shuffledItems;
}
