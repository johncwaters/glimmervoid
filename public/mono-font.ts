import { BUNDLED_MONO_FONT_FACES, terminalFontFamily, whenEveryFaceLoads } from './mono-font-core.ts';

function isBundledMonoFontLoaded(): boolean {
  if (!document.fonts) return false;
  return BUNDLED_MONO_FONT_FACES.every((face) => document.fonts.check(face));
}

export function currentTerminalFontFamily(): string {
  const cssFontStack = getComputedStyle(document.documentElement).getPropertyValue('--font-mono');
  return terminalFontFamily(cssFontStack, isBundledMonoFontLoaded());
}

export function whenBundledMonoFontLoads(onLoaded: () => void): void {
  if (!document.fonts) return;
  void whenEveryFaceLoads(document.fonts, BUNDLED_MONO_FONT_FACES, onLoaded);
}
