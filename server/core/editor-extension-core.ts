import path from 'node:path';

export interface EditorIdentity {
  command: string;
  label: string;
}

export interface EditorCandidate extends EditorIdentity {
  macAppBundleName?: string;
}

export interface EditorProbe {
  platform: NodeJS.Platform;
  exists: (candidate: string) => boolean;
}

export interface EditorTarget extends EditorIdentity {
  commandPath: string;
}

export interface EditorTargetDecision {
  targets: EditorTarget[];
  reason: string;
}

export interface ExtensionFile {
  path: string;
  data: string;
}

const EDITOR_CANDIDATES: EditorCandidate[] = [
  { command: 'codium', label: 'VSCodium', macAppBundleName: 'VSCodium' },
  { command: 'code', label: 'VS Code', macAppBundleName: 'Visual Studio Code' },
  { command: 'code-insiders', label: 'VS Code Insiders', macAppBundleName: 'Visual Studio Code - Insiders' },
  { command: 'cursor', label: 'Cursor', macAppBundleName: 'Cursor' },
  { command: 'windsurf', label: 'Windsurf', macAppBundleName: 'Windsurf' },
];

const MACOS_BUNDLE_CLI_DIR = 'Contents/Resources/app/bin';

function editorBundleCandidatePaths(
  candidate: EditorCandidate,
  { platform, homeDir = null }: { platform: NodeJS.Platform; homeDir?: string | null },
): string[] {
  if (platform !== 'darwin') return [];
  const bundleName = candidate.macAppBundleName;
  if (!bundleName) return [];
  const applicationDirs = ['/Applications'];
  if (homeDir) applicationDirs.push(path.posix.join(homeDir, 'Applications'));
  return applicationDirs.map(
    (applicationDir) => path.posix.join(applicationDir, `${bundleName}.app`, MACOS_BUNDLE_CLI_DIR, candidate.command),
  );
}

function editorLabelFor(command: string, platform: NodeJS.Platform): string {
  const byCommand = EDITOR_CANDIDATES.find((candidate) => candidate.command === command);
  if (byCommand) return byCommand.label;
  const basename = (platform === 'win32' ? path.win32 : path.posix).basename(command);
  const byBasename = EDITOR_CANDIDATES.find((candidate) => candidate.command === basename);
  return byBasename?.label || command;
}

function isAbsoluteEditorPath(requested: string, platform: NodeJS.Platform): boolean {
  return (platform === 'win32' ? path.win32 : path.posix).isAbsolute(requested);
}

function resolveEditorPathsFor({
  platform,
  homeDir = null,
  matchesOnPath,
  exists,
}: {
  platform: NodeJS.Platform;
  homeDir?: string | null;
  matchesOnPath: (command: string) => string[];
  exists: (candidate: string) => boolean;
}): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const candidate of EDITOR_CANDIDATES) {
    const [firstOnPath] = matchesOnPath(candidate.command);
    const commandPath = firstOnPath
      || editorBundleCandidatePaths(candidate, { platform, homeDir }).find(exists);
    if (!commandPath) continue;
    resolved[candidate.command] = commandPath;
  }
  return resolved;
}

function decideEditorTargets({
  requested = null,
  resolvedByCommand = {},
  probe,
}: {
  requested?: string | null;
  resolvedByCommand?: Record<string, string | undefined>;
  probe: EditorProbe;
}): EditorTargetDecision {
  if (requested) {
    const label = editorLabelFor(requested, probe.platform);
    if (isAbsoluteEditorPath(requested, probe.platform)) {
      if (!probe.exists(requested)) return { targets: [], reason: `editor path does not exist on disk: ${requested}` };
      return { targets: [{ command: requested, label, commandPath: requested }], reason: 'requested' };
    }
    const commandPath = resolvedByCommand[requested];
    if (!commandPath) return { targets: [], reason: `editor not found on PATH: ${requested}` };
    return { targets: [{ command: requested, label, commandPath }], reason: 'requested' };
  }

  const targets: EditorTarget[] = [];
  for (const candidate of EDITOR_CANDIDATES) {
    const commandPath = resolvedByCommand[candidate.command];
    if (!commandPath) continue;
    targets.push({ command: candidate.command, label: candidate.label, commandPath });
  }
  if (targets.length === 0) return { targets: [], reason: 'no VS Code family editor found on PATH or on disk' };
  return { targets, reason: 'detected' };
}

function relayStamp(relayPath: string): string {
  return `${JSON.stringify({ relayPath }, null, 2)}\n`;
}

function visionsExtensionFiles({
  manifestJson,
  extensionJs,
  convertJs,
  lspCoreJs,
  relayPath,
}: {
  manifestJson: string;
  extensionJs: string;
  convertJs: string;
  lspCoreJs: string;
  relayPath: string;
}): ExtensionFile[] {
  return [
    { path: 'package.json', data: manifestJson },
    { path: 'extension.js', data: extensionJs },
    { path: 'lsp-convert.js', data: convertJs },
    { path: 'visions-lsp-core.js', data: lspCoreJs },
    { path: 'relay-path.json', data: relayStamp(relayPath) },
  ];
}

function parseInstalledExtensions(stdout: unknown): string[] {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function isExtensionInstalled(stdout: unknown, extensionId: string): boolean {
  const wanted = String(extensionId).toLowerCase();
  return parseInstalledExtensions(stdout).some((line) => line.toLowerCase() === wanted);
}

export {
  decideEditorTargets,
  isExtensionInstalled,
  parseInstalledExtensions,
  relayStamp,
  resolveEditorPathsFor,
  visionsExtensionFiles,
};
