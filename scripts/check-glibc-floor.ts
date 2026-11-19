import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type GlibcVersion = { major: number; minor: number };

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const ELF_MACHINE_BY_NODE_ARCH: Record<string, number> = { x64: 62, arm64: 183 };
const EMBEDDED_NATIVE_MODULE_DIRECTORIES = ['node_modules/node-pty', 'node_modules/fs-native-extensions', 'node_modules/@img'];

function parseGlibcVersion(text: string): GlibcVersion {
  const [major, minor] = text.split('.').map(Number);
  return { major, minor };
}

function isNewerThan(candidate: GlibcVersion, floor: GlibcVersion): boolean {
  if (candidate.major !== floor.major) return candidate.major > floor.major;
  return candidate.minor > floor.minor;
}

function formatGlibcVersion(version: GlibcVersion): string {
  return `${version.major}.${version.minor}`;
}

export function readDistGlibcFloor(distWorkspacePath: string): GlibcVersion {
  const distWorkspaceText = fs.readFileSync(distWorkspacePath, 'utf8');
  const floorMatch = distWorkspaceText.match(/\[dist\.min-glibc-version\][^[]*?"\*"\s*=\s*"(\d+\.\d+)"/);
  if (!floorMatch) throw new Error(`${distWorkspacePath} sets no [dist.min-glibc-version] "*" floor`);
  return parseGlibcVersion(floorMatch[1]);
}

function isHostArchitectureElf(filePath: string): boolean {
  const header = Buffer.alloc(20);
  const fileDescriptor = fs.openSync(filePath, 'r');
  const bytesRead = fs.readSync(fileDescriptor, header, 0, header.length, 0);
  fs.closeSync(fileDescriptor);
  if (bytesRead < header.length || !header.subarray(0, 4).equals(ELF_MAGIC)) return false;
  return header.readUInt16LE(18) === ELF_MACHINE_BY_NODE_ARCH[process.arch];
}

function listFilesUnder(directoryPath: string): string[] {
  if (!fs.existsSync(directoryPath)) return [];
  return fs.readdirSync(directoryPath, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function highestRequiredGlibc(filePath: string): GlibcVersion | null {
  const dynamicSymbolTable = execFileSync('objdump', ['-T', filePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const requiredVersions = [...dynamicSymbolTable.matchAll(/GLIBC_(\d+\.\d+)/g)].map((match) => parseGlibcVersion(match[1]));
  return requiredVersions.reduce<GlibcVersion | null>((highest, version) => (highest === null || isNewerThan(version, highest) ? version : highest), null);
}

export function assertBinariesFitGlibcFloor({ repoRoot, builtBinaryPaths }: { repoRoot: string; builtBinaryPaths: string[] }): void {
  const floor = readDistGlibcFloor(path.join(repoRoot, 'dist-workspace.toml'));
  const embeddedModulePaths = EMBEDDED_NATIVE_MODULE_DIRECTORIES.flatMap((directory) => listFilesUnder(path.join(repoRoot, directory)));
  const checkedPaths = [...builtBinaryPaths, ...embeddedModulePaths].filter(isHostArchitectureElf);
  const offenderLines = checkedPaths.flatMap((filePath) => {
    const required = highestRequiredGlibc(filePath);
    if (required === null || !isNewerThan(required, floor)) return [];
    return [`  ${path.relative(repoRoot, filePath)} needs GLIBC_${formatGlibcVersion(required)}`];
  });
  if (offenderLines.length === 0) return;
  throw new Error(`shipped files need a newer glibc than the installer floor ${formatGlibcVersion(floor)} in dist-workspace.toml; raise [dist.min-glibc-version] or pin the dependency:\n${offenderLines.join('\n')}`);
}
