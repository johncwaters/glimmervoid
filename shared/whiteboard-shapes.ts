import type { IconName } from './whiteboard-icons.ts';

export const BYLINE_PREFIX = 'from ';

export const BOX_SHAPES = ['box', 'decision', 'ellipse', 'note', 'icon', 'device'] as const;
export type BoxShape = (typeof BOX_SHAPES)[number];

interface ShapeTraits {
  label: string;
  pickerIcon: IconName;
  holdsLines: boolean;
  holdsMedia: boolean;
  isFitted: boolean;
  isBorderlessByDefault: boolean;
  takesTone: boolean;
  needsDevice: boolean;
  needsIcon: boolean;
}

export const SHAPE_TRAITS: Readonly<Record<BoxShape, ShapeTraits>> = Object.freeze({
  box: { label: 'Box', pickerIcon: 'component', holdsLines: true, holdsMedia: true, isFitted: true, isBorderlessByDefault: false, takesTone: true, needsDevice: false, needsIcon: false },
  decision: { label: 'Decision', pickerIcon: 'workflow', holdsLines: true, holdsMedia: true, isFitted: true, isBorderlessByDefault: false, takesTone: true, needsDevice: false, needsIcon: false },
  ellipse: { label: 'Ellipse', pickerIcon: 'shapes', holdsLines: true, holdsMedia: true, isFitted: true, isBorderlessByDefault: false, takesTone: true, needsDevice: false, needsIcon: false },
  note: { label: 'Note', pickerIcon: 'message', holdsLines: true, holdsMedia: true, isFitted: true, isBorderlessByDefault: false, takesTone: true, needsDevice: false, needsIcon: false },
  icon: { label: 'Icon', pickerIcon: 'star', holdsLines: false, holdsMedia: false, isFitted: false, isBorderlessByDefault: true, takesTone: false, needsDevice: false, needsIcon: true },
  device: { label: 'Device', pickerIcon: 'phone', holdsLines: false, holdsMedia: true, isFitted: false, isBorderlessByDefault: true, takesTone: false, needsDevice: true, needsIcon: false },
});

export function isBorderlessBox(box: { shape: BoxShape; borderless: boolean | null }): boolean {
  return box.borderless ?? SHAPE_TRAITS[box.shape].isBorderlessByDefault;
}
