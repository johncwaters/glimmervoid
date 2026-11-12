import path from 'node:path';
import { isPathInside } from '../../shared/paths.ts';

type RuntimeMode = 'source' | 'bundled' | 'binary';
type SelfEntry = 'cli' | 'hook-relay' | 'command-hook-relay' | 'statusline-relay' | 'hook-tool-relay' | 'posthog-read-gate';

export interface RuntimePaths {
  packageRoot: string;
  mode: RuntimeMode;
  bundled: boolean;
  assetRoot: string;
  clientDir: string;
  cliPath: string;
  examplePacksDir: string;
  relayPath: (relayName: string) => string;
  boardStoreWorkerPath: string;
  layoutWorkerPath: string;
  selfLaunch: (entry: SelfEntry, launcherPath: string) => string[];
  fnoxPath: (fnoxLocation: FnoxLocation) => string;
}

interface FnoxLocation {
  execPath: string;
  platform: NodeJS.Platform;
  fnoxVersion: string;
}

interface RuntimePathsInput {
  moduleFile: string;
  hasPackageJson: (directory: string) => boolean;
  isBinary: boolean;
}

function findPackageRoot(startDirectory: string, hasPackageJson: (directory: string) => boolean): string {
  let directory = startDirectory;
  for (;;) {
    if (hasPackageJson(directory)) return directory;
    const parent = path.dirname(directory);

    if (parent === directory) return path.resolve(startDirectory, '..');
    directory = parent;
  }
}

const SHIPPED_FNOX_NAME = 'glimmervoid-fnox';
const DEV_FNOX_DIRNAME = '.fnox';

function withExecutableSuffix(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

const ENTRY_EXTENSION_BY_MODE: Record<RuntimeMode, string> = { source: '.ts', bundled: '.js', binary: '.mjs' };

function decideRuntimeMode(isBundled: boolean, isBinary: boolean): RuntimeMode {
  if (isBinary) return 'binary';
  return isBundled ? 'bundled' : 'source';
}

function computeRuntimePaths({ moduleFile, hasPackageJson, isBinary }: RuntimePathsInput): RuntimePaths {
  const packageRoot = findPackageRoot(path.dirname(path.resolve(moduleFile)), hasPackageJson);
  const distDir = path.join(packageRoot, 'dist');
  const bundled = isPathInside(distDir, path.resolve(moduleFile), { allowEqual: false });
  const mode = decideRuntimeMode(bundled, isBinary);
  const assetRoot = bundled ? distDir : packageRoot;
  const sourceExtension = ENTRY_EXTENSION_BY_MODE[mode];
  const cliPath = path.join(assetRoot, 'bin', `glimmervoid${sourceExtension}`);
  const relayPath = (relayName: string) => path.join(assetRoot, 'session', `${relayName}${sourceExtension}`);
  const selfLaunch = (entry: SelfEntry, launcherPath: string): string[] => {
    if (mode === 'binary') return entry === 'cli' ? [launcherPath] : [launcherPath, '__run', entry];
    return [launcherPath, entry === 'cli' ? cliPath : relayPath(entry)];
  };
  const fnoxPath = ({ execPath, platform, fnoxVersion }: FnoxLocation): string => {
    if (mode === 'binary') return path.join(path.dirname(execPath), withExecutableSuffix(SHIPPED_FNOX_NAME, platform));
    return path.join(packageRoot, DEV_FNOX_DIRNAME, fnoxVersion, withExecutableSuffix('fnox', platform));
  };
  return {
    packageRoot,
    mode,
    bundled,
    assetRoot,
    clientDir: path.join(distDir, 'client'),
    cliPath,
    examplePacksDir: path.join(assetRoot, 'examples', 'packs'),
    relayPath,
    boardStoreWorkerPath: path.join(assetRoot, 'server', 'whiteboard', `board-store-worker${sourceExtension}`),
    layoutWorkerPath: path.join(assetRoot, 'server', 'whiteboard', `layout-worker${sourceExtension}`),
    selfLaunch,
    fnoxPath,
  };
}

export { computeRuntimePaths };
export type { SelfEntry };
