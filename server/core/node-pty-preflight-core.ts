import path from 'node:path';

export interface NativeBindingScope {
  packageDir: string;
  platform: NodeJS.Platform;
  arch: string;
}

export interface BootRefusalScope {
  platform: NodeJS.Platform;
  packageDir: string;
  reason: string;
}

const REPAIR_COMMAND = 'npm rebuild -g node-pty --allow-scripts=node-pty';
const FALLBACK_REPAIR_COMMAND = 'cd "$(npm root -g)/glimmervoid" && npm rebuild node-pty --dangerously-allow-all-scripts';
const CHECKOUT_REPAIR_COMMAND = 'npm rebuild node-pty --dangerously-allow-all-scripts';

function nativeBindingCandidates({ packageDir, platform, arch }: NativeBindingScope): string[] {
  const searchDirs = [
    ['build', 'Release'],
    ['build', 'Debug'],
    ['prebuilds', `${platform}-${arch}`],
  ];
  return searchDirs.flatMap((searchDir) => [
    path.join(packageDir, ...searchDir, 'pty.node'),
    path.join(packageDir, 'lib', ...searchDir, 'pty.node'),
  ]);
}

function nativeToolchainHint(platform: NodeJS.Platform): string {
  if (platform === 'linux') return 'install build tools: sudo apt install build-essential python3';
  if (platform === 'win32') return 'install Visual Studio Build Tools';
  if (platform === 'darwin') return 'install Xcode Command Line Tools: xcode-select --install';
  return 'install the native build tools for this platform';
}

function nodePtyRebuildHint(platform: NodeJS.Platform): string {
  return `${nativeToolchainHint(platform)}; then rebuild. global install: ${REPAIR_COMMAND} (the flag is required on npm 12, unknown-but-harmless on older npm). clone or source checkout, from the checkout root: ${CHECKOUT_REPAIR_COMMAND}`;
}

function formatNodePtyBootRefusal({ platform, packageDir, reason }: BootRefusalScope): string {
  return [
    'Refusing to start: the node-pty native binding did not load, so Glimmervoid cannot spawn a terminal for any session.',
    `  reason: ${reason}`,
    `  node-pty package: ${packageDir}`,
    '  npm 12 blocks dependency install scripts by default, so a global install from a git spec leaves node-pty uncompiled.',
    `  repair (global install): ${REPAIR_COMMAND}`,
    '    (run it from a directory outside the installed package; from inside it the same command is project-scoped and dies with EALLOWSCRIPTS)',
    '    (name node-pty, not glimmervoid: rebuilding the wrapper exits 0 and rebuilds nothing nested)',
    `  fallback (global install): ${FALLBACK_REPAIR_COMMAND}`,
    `  repair (clone or source checkout): ${CHECKOUT_REPAIR_COMMAND}`,
    '    (run it from the checkout root; the global repair above rebuilds nothing in a checkout and exits 0)',
    `  ${nativeToolchainHint(platform)}`,
    '  Run "glimmervoid doctor" for the same check plus the rest of your install.',
  ].join('\n');
}

export { nativeBindingCandidates, nodePtyRebuildHint, formatNodePtyBootRefusal };
