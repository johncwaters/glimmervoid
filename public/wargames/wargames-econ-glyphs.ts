import { createLineIcon, TROPHY_ICON_PATH } from '../svg-dom.ts';
import {
  BUILD_HAMMER_PATH,
  BUILDING_GLYPH_PATHS,
  CONTROL_FLAG_PATH,
  GRAIN_GLYPH_PATH,
  MARCH_ARROW_PATH,
  ORE_GLYPH_PATH,
  UNIT_GLYPH_PATHS,
  VILLAGE_GLYPH_PATH,
} from './wargames-map.ts';

export type EconGlyphKey =
  | 'village'
  | 'grain'
  | 'ore'
  | 'farm'
  | 'mine'
  | 'wall'
  | 'raider'
  | 'guard'
  | 'envoy'
  | 'field'
  | 'built'
  | 'taken'
  | 'points';

interface EconGlyph {
  readonly path: string;
  readonly color: string;
  readonly label: string;
}

export const GRAIN_COLOR = 'var(--state-waiting)';
export const ORE_COLOR = 'var(--state-monitoring)';

function buildingGlyph(key: 'farm' | 'mine' | 'wall'): EconGlyph {
  const building = BUILDING_GLYPH_PATHS.find((entry) => entry.key === key);
  return { path: building?.path ?? '', color: building?.color ?? 'var(--text-dim)', label: building?.label ?? key };
}

function unitGlyph(key: 'raider' | 'guard' | 'envoy'): EconGlyph {
  const unit = UNIT_GLYPH_PATHS.find((entry) => entry.key === key);
  return { path: unit?.path ?? '', color: unit?.color ?? 'var(--text-dim)', label: unit?.label ?? key };
}

export const ECON_GLYPHS: Readonly<Record<EconGlyphKey, EconGlyph>> = Object.freeze({
  village: { path: VILLAGE_GLYPH_PATH, color: 'var(--text-dim)', label: 'Villages' },
  grain: { path: GRAIN_GLYPH_PATH, color: GRAIN_COLOR, label: 'Grain' },
  ore: { path: ORE_GLYPH_PATH, color: ORE_COLOR, label: 'Ore' },
  farm: buildingGlyph('farm'),
  mine: buildingGlyph('mine'),
  wall: buildingGlyph('wall'),
  raider: unitGlyph('raider'),
  guard: unitGlyph('guard'),
  envoy: unitGlyph('envoy'),
  field: { path: MARCH_ARROW_PATH, color: 'var(--text-dim)', label: 'In the field' },
  built: { path: BUILD_HAMMER_PATH, color: 'var(--text-dim)', label: 'Levels built' },
  taken: { path: CONTROL_FLAG_PATH, color: 'var(--accent)', label: 'Levels taken' },
  points: { path: TROPHY_ICON_PATH, color: 'var(--text-head)', label: 'Victory points' },
});

export function econGlyph(key: EconGlyphKey, size = 12, accessibleLabel: string | null = ECON_GLYPHS[key].label): SVGSVGElement {
  const glyph = ECON_GLYPHS[key];
  const icon = createLineIcon(glyph.path, '1.5');
  icon.setAttribute('width', String(size));
  icon.setAttribute('height', String(size));
  icon.style.color = glyph.color;
  if (accessibleLabel === null) return icon;
  icon.removeAttribute('aria-hidden');
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', accessibleLabel);
  return icon;
}
