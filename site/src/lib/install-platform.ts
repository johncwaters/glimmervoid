export type InstallPlatform = 'macos' | 'windows' | 'linux';

export const INSTALL_PLATFORMS: readonly InstallPlatform[] = ['macos', 'windows', 'linux'];

const PLATFORM_PATTERNS: readonly [InstallPlatform, RegExp][] = [
  ['windows', /windows|win32|win64/i],
  ['macos', /mac ?os|macintosh|mac os x/i],
  ['linux', /linux|x11|cros|chrome ?os|chromium ?os/i],
];

const MOBILE_PATTERN = /android|iphone|ipad|ipod|mobile/i;

function matchPlatform(text: string): InstallPlatform | null {
  for (const [platform, pattern] of PLATFORM_PATTERNS) {
    if (pattern.test(text)) return platform;
  }
  return null;
}

export function detectInstallPlatform({ userAgentDataPlatform, userAgent }: { userAgentDataPlatform?: string | null; userAgent?: string | null }): InstallPlatform | null {
  const hintedPlatform = userAgentDataPlatform?.trim() ?? '';
  if (MOBILE_PATTERN.test(hintedPlatform)) return null;
  const hintedMatch = matchPlatform(hintedPlatform);
  if (hintedMatch) return hintedMatch;
  const agent = userAgent ?? '';
  if (MOBILE_PATTERN.test(agent)) return null;
  return matchPlatform(agent);
}

export interface InstallPlatformView {
  visibleCommand: 'default' | 'linux';
  pressedPlatform: InstallPlatform;
  isBuildNoteShown: boolean;
}

export function installPlatformView(platform: InstallPlatform): InstallPlatformView {
  const isLinux = platform === 'linux';
  return { visibleCommand: isLinux ? 'linux' : 'default', pressedPlatform: platform, isBuildNoteShown: isLinux };
}
