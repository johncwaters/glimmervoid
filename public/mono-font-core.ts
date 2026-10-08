export const BUNDLED_MONO_FONT_NAME = 'CommitMono';
export const BUNDLED_MONO_FONT_FACES: readonly string[] = [400, 700].map((fontWeight) => `${fontWeight} 14px ${BUNDLED_MONO_FONT_NAME}`);
const LAST_RESORT_FONT_FAMILY = 'monospace';

function unquotedFamilyName(family: string): string {
  return family.trim().replace(/^['"]|['"]$/g, '');
}

export function terminalFontFamily(cssFontStack: string, isBundledFontLoaded: boolean): string {
  const families = cssFontStack.split(',').map((family) => family.trim()).filter((family) => family.length > 0);
  const usableFamilies = isBundledFontLoaded ? families : families.filter((family) => unquotedFamilyName(family) !== BUNDLED_MONO_FONT_NAME);
  return usableFamilies.length > 0 ? usableFamilies.join(', ') : LAST_RESORT_FONT_FAMILY;
}

export type MonoFontSet = { load(face: string): Promise<unknown> };

export type FontRefreshableTerminalEntry = {
  term?: { options: { fontFamily?: string } } | null;
  _syncGrid?: () => void;
};

export function whenEveryFaceLoads(fontSet: MonoFontSet, faces: readonly string[], onLoaded: () => void): Promise<void> {
  return Promise.all(faces.map((face) => fontSet.load(face))).then(onLoaded, () => undefined);
}

export function applyTerminalFontFamily(entries: Iterable<FontRefreshableTerminalEntry>, fontFamily: string): void {
  for (const entry of entries) {
    if (!entry.term) continue;
    entry.term.options.fontFamily = fontFamily;
    entry._syncGrid?.();
  }
}
