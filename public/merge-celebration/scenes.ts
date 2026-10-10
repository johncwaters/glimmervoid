import { bullseyeScene } from './bullseye-scene.ts';
import { headshotScene } from './headshot-scene.ts';
import { royalFlushScene } from './royal-flush-scene.ts';
import { strikeScene } from './strike-scene.ts';
import { swishScene } from './swish-scene.ts';

export interface MergeCelebrationScene {
  title: string;
  buildScene: () => HTMLElement;
}

export const MERGE_CELEBRATION_SCENES: readonly MergeCelebrationScene[] = [strikeScene, swishScene, bullseyeScene, headshotScene, royalFlushScene];
