import type { TickPhase } from '#shared/contracts/wargames.ts';
import { CHAT_ICON_PATH } from '../svg-dom.ts';
import { BREACH_WARNING_PATH, GRAIN_GLYPH_PATH, MARCH_ARROW_PATH, ORE_GLYPH_PATH, PACT_SCROLL_PATH, VILLAGE_GLYPH_PATH } from './wargames-map.ts';

export const WARGAMES_GLYPH_PATHS = Object.freeze({
  skull: 'M 4 7 A 4 4 0 1 1 12 7 V 10 H 10 V 13 H 6 V 10 H 4 Z M 6.5 7.5 H 6.6 M 9.5 7.5 H 9.6',
  scroll: PACT_SCROLL_PATH,
  crosshair: 'M 8 2 V 5 M 8 11 V 14 M 2 8 H 5 M 11 8 H 14 M 5 8 A 3 3 0 1 0 11 8 A 3 3 0 1 0 5 8',
  swords: 'M 3 13 L 12 4 M 10 3 L 13 3 L 13 6 M 13 13 L 4 4 M 6 3 L 3 3 L 3 6',
  clock: 'M 3 8 A 5 5 0 1 0 13 8 A 5 5 0 1 0 3 8 M 8 5 V 8 L 10 9.5',
  ready: 'M 5 8 A 3 3 0 1 0 11 8 A 3 3 0 1 0 5 8',
  offline: 'M 4 8 A 4 4 0 1 0 12 8 A 4 4 0 1 0 4 8 M 5 11 L 11 5',
  breach: BREACH_WARNING_PATH,
  territory: VILLAGE_GLYPH_PATH,
  arrow: MARCH_ARROW_PATH,
  grain: GRAIN_GLYPH_PATH,
  ore: ORE_GLYPH_PATH,
});

export const ACTING_PHASE_GLYPHS: Readonly<Record<TickPhase, string>> = Object.freeze({
  talk: CHAT_ICON_PATH,
  contracts: WARGAMES_GLYPH_PATHS.scroll,
  orders: WARGAMES_GLYPH_PATHS.crosshair,
  resolving: WARGAMES_GLYPH_PATHS.swords,
  reported: WARGAMES_GLYPH_PATHS.swords,
});
