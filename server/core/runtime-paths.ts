import path from 'node:path';
import { isPathInside } from '../../shared/paths.ts';

type RuntimeMode = 'source' | 'bundled' | 'binary';
type SelfEntry = 'cli' | 'hook-relay' | 'command-hook-relay' | 'statusline-relay' | 'hook-tool-relay' | 'mcp-bridge' | 'posthog-read-gate';

export interface RuntimePaths {
  packageRoot: string;
  mode: RuntimeMode;
  bundled: boolean;
  assetRoot: string;
  clientDir: string;
  appIconPath: string;
  cliPath: string;
  examplePacksDir: string;
  relayPath: (relayName: string) => string;
  boardStoreWorkerPath: string;
  layoutWorkerPath: string;
  codemapWorkerPath: string;
  workbookWorkerPath: string;
  seatbeltLauncherPath: string;
  selfLaunch: (entry: SelfEntry, launcherPath: string, relayRunnerPath?: string) => string[];
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

const SHIPPED_RELAY_NAME = 'glimmervoid-relay';
const BINARY_RUN_SUBCOMMAND = '__run';
const WINDOWS_EXECUTABLE_EXTENSION = '.exe';

function relayExecutableBeside(launcherPath: string): string {
  const launcherExtension = path.extname(launcherPath).toLowerCase() === WINDOWS_EXECUTABLE_EXTENSION ? WINDOWS_EXECUTABLE_EXTENSION : '';
  return path.join(path.dirname(launcherPath), `${SHIPPED_RELAY_NAME}${launcherExtension}`);
}

type RelayRunnerFacts = { launcherPath: string; hasRelayBesideLauncher: boolean; hasRelayBesideExecutable: boolean; executableRealPath: string };
type RelayRunner = { kind: 'relay' | 'main-binary'; path: string };

function relayRunnerOf({ launcherPath, hasRelayBesideLauncher, hasRelayBesideExecutable, executableRealPath }: RelayRunnerFacts): RelayRunner {
  if (hasRelayBesideLauncher) return { kind: 'relay', path: relayExecutableBeside(launcherPath) };
  if (hasRelayBesideExecutable) return { kind: 'relay', path: relayExecutableBeside(executableRealPath) };
  return { kind: 'main-binary', path: launcherPath };
}

type RelayExecutableFacts = { runner: RelayRunner; runnerRealPath: string | null; executableRealPath: string };
type RelayExecutableProblem = { code: 'RELAY_ABSENT' | 'RELAY_MISSING' | 'RELAY_ELSEWHERE'; refusesSpawn: boolean; message: string };

function relayExecutableProblemOf({ runner, runnerRealPath, executableRealPath }: RelayExecutableFacts): RelayExecutableProblem | null {
  const executableDirectory = path.dirname(executableRealPath);
  if (runner.kind === 'main-binary') return { code: 'RELAY_ABSENT', refusesSpawn: false, message: `no ${SHIPPED_RELAY_NAME} beside ${runner.path} or the running glimmervoid, so hooks run through glimmervoid itself, which is slower; reinstall Glimmervoid to restore it` };
  if (runnerRealPath === null) return { code: 'RELAY_MISSING', refusesSpawn: true, message: `${SHIPPED_RELAY_NAME} is missing at ${runner.path}; reinstall Glimmervoid so it sits beside glimmervoid` };
  if (path.dirname(runnerRealPath) === executableDirectory) return null;
  return { code: 'RELAY_ELSEWHERE', refusesSpawn: true, message: `${runner.path} resolves to ${runnerRealPath}, outside ${executableDirectory} where the running glimmervoid lives; restart Glimmervoid so it runs the release beside its relay, and reinstall only if that does not clear this` };
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
  const selfLaunch = (entry: SelfEntry, launcherPath: string, relayRunnerPath = relayExecutableBeside(launcherPath)): string[] => {
    if (mode === 'binary') return entry === 'cli' ? [launcherPath] : [relayRunnerPath, BINARY_RUN_SUBCOMMAND, entry];
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
    appIconPath: path.join(distDir, 'client', 'app-icons', 'icon-512.png'),
    cliPath,
    examplePacksDir: path.join(assetRoot, 'examples', 'packs'),
    relayPath,
    boardStoreWorkerPath: path.join(assetRoot, 'server', 'whiteboard', `board-store-worker${sourceExtension}`),
    layoutWorkerPath: path.join(assetRoot, 'server', 'whiteboard', `layout-worker${sourceExtension}`),
    codemapWorkerPath: path.join(assetRoot, 'server', 'codemap', `codemap-worker${sourceExtension}`),
    workbookWorkerPath: path.join(assetRoot, 'server', 'whiteboard', `workbook-worker${sourceExtension}`),
    seatbeltLauncherPath: path.join(assetRoot, 'server', 'sandbox', `seatbelt-launcher${sourceExtension}`),
    selfLaunch,
    fnoxPath,
  };
}

export { BINARY_RUN_SUBCOMMAND, computeRuntimePaths, relayExecutableBeside, relayExecutableProblemOf, relayRunnerOf };
export type { RelayRunner, SelfEntry };
