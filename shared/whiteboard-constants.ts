import { BRAND_ACCENT } from './brand-mark.ts';
import type { Box, DialValue, WireEnd } from './contracts/whiteboard.ts';

export const WHITEBOARD_LIMITS = Object.freeze({
  elements: 1_000_000, opsPerPut: 5000, putBytes: 1_728_576, title: 80, line: 120, linesPerBox: 12, noteText: 400, logEntries: 2000, layoutWarnings: 20, readPage: 150, readPageChars: 32_000, outlineClusters: 40, queryText: 200, boxWidthMin: 160, boxWidthMax: 2400, boxHeightMax: 2400, dialsPerPage: 16, dialChoices: 12, strokePoints: 1000, strokes: 500, strokeWidthMax: 24,
  askQuestion: 200, askOptions: 4, askOption: 80,
  wireLabel: 40, wireBends: 32, lineKey: 40, caption: 400, ref: 200, refsPerElement: 8, legendEntries: 12, legendLabel: 40,
});

export const BOX_CHANGES = ['none', 'added', 'removed', 'relabeled'] as const;
export const WIRE_TONES = ['plain', 'fail', 'join'] as const;
export const NOTE_TONES = ['yellow', 'pink', 'green', 'blue', 'violet'] as const;
export const TEXT_SIZES = ['S', 'M', 'L', 'XL'] as const;
export type NoteTone = (typeof NOTE_TONES)[number];
export type TextSize = (typeof TEXT_SIZES)[number];
export const NOTE_TONE_HEX: Readonly<Record<NoteTone, string>> = { yellow: '#f5d565', pink: '#f28bb6', green: '#7fd49a', blue: '#7cb4f2', violet: '#b49cf5' };
export const TITLE_GRADIENT_HEX: readonly string[] = [BRAND_ACCENT, NOTE_TONE_HEX.blue, '#ef4444'];
export const STEP_STATUSES = ['planned', 'building', 'landed'] as const;
export const BLOCK_RASTER_PX = 64;

export function pointOfBox(box: Pick<Box, 'place'>): { x: number; y: number } | null {
  return typeof box.place === 'object' ? box.place.at : null;
}

export function dialValuesOfBox(box: Pick<Box, 'media' | 'params'>): Record<string, DialValue> {
  const { media, params } = box;
  if (media?.kind !== 'page') return {};
  return Object.fromEntries(media.dials.map((dial) => [dial.id, Object.hasOwn(params, dial.id) ? params[dial.id] ?? dial.default : dial.default]));
}

export function boxIdOfEnd(end: WireEnd): string | null {
  return typeof end === 'string' ? end : null;
}

export function boxIdsOfWire(wire: { from: WireEnd; to: WireEnd }): string[] {
  return [wire.from, wire.to].flatMap((end) => boxIdOfEnd(end) ?? []);
}
