import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PR_PACK_FILE_NAME, PrPack } from '../../shared/contracts/pr-pack.ts';
import { withoutGlimmervoidSecrets } from '../../session/core/spawn-env.ts';
import type { PrPackOnDisk } from '../../shared/contracts/pr-pack.ts';
import { errorMessage } from '../../shared/text.ts';
import { parseJsonOrNull } from '../core/json-core.ts';

const PACK_MAX_TOTAL_BYTES = 1024 * 1024;
const PACKS_DIR_NAME = 'packs';

type PackFile = { relativePath: string; bytes: Buffer };
type PackRead = { ok: true; pack: PrPackOnDisk } | { ok: false; errors: string[] };

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readPackFiles(packDir: string): { ok: true; files: PackFile[] } | { ok: false; error: string } {
  const files: PackFile[] = [];
  const pendingDirs = [''];
  let totalBytes = 0;
  while (pendingDirs.length > 0) {
    const relativeDir = pendingDirs.pop() ?? '';
    for (const entry of fs.readdirSync(path.join(packDir, relativeDir), { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isSymbolicLink()) return { ok: false, error: `${relativePath} is a symlink, and a pack holds only its own files` };
      if (entry.isDirectory()) {
        pendingDirs.push(relativePath);
        continue;
      }
      if (!entry.isFile()) return { ok: false, error: `${relativePath} is not a regular file` };
      totalBytes += fs.lstatSync(path.join(packDir, relativePath)).size;
      if (totalBytes > PACK_MAX_TOTAL_BYTES) return { ok: false, error: 'the pack is over 1 MiB' };
      files.push({ relativePath, bytes: fs.readFileSync(path.join(packDir, relativePath)) });
    }
  }
  return { ok: true, files };
}

function packFingerprint(files: readonly PackFile[]): string {
  const fileHashes = files.map((file) => [file.relativePath, sha256(file.bytes)]).sort(([left = ''], [right = '']) => left.localeCompare(right));
  return sha256(JSON.stringify(fileHashes));
}

function isProgramOnPath(program: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(path.delimiter).filter(Boolean).some((dir) => {
    const candidate = path.join(dir, program);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function missingRequires(requires: PrPack['requires'], env: NodeJS.ProcessEnv): string[] {
  const commandEnv = withoutGlimmervoidSecrets(env);
  return [
    ...requires.env.filter((name) => !commandEnv[name]).map((name) => `env ${name}`),
    ...requires.programs.filter((program) => !isProgramOnPath(program, env)).map((program) => `program ${program}`),
  ];
}

function readPackDirUnguarded(packDir: string, env: NodeJS.ProcessEnv): PackRead {
  if (/[{}]/.test(packDir)) return { ok: false, errors: [`${packDir} has { or } in its path, which a command placeholder would misread`] };
  const stats = fs.lstatSync(packDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) return { ok: false, errors: [`${packDir} is not a directory; a symlinked pack is refused`] };
  const read = readPackFiles(packDir);
  if (!read.ok) return { ok: false, errors: [read.error] };
  const manifest = read.files.find((file) => file.relativePath === PR_PACK_FILE_NAME);
  if (!manifest) return { ok: false, errors: [`there is no ${PR_PACK_FILE_NAME}`] };
  const parsed = PrPack.safeParse(parseJsonOrNull(manifest.bytes.toString('utf8')));
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((issue) => `${PR_PACK_FILE_NAME} ${issue.path.join('.') || '(root)'}: ${issue.message}`) };
  return { ok: true, pack: { dir: packDir, pack: parsed.data, fingerprint: packFingerprint(read.files), missingRequires: missingRequires(parsed.data.requires, env) } };
}

export function readPackDir(packDir: string, env: NodeJS.ProcessEnv): PackRead {
  const absoluteDir = path.resolve(packDir);
  try {
    return readPackDirUnguarded(absoluteDir, env);
  } catch (error) {
    return { ok: false, errors: [`could not read ${absoluteDir}: ${errorMessage(error)}`] };
  }
}

function packDirsUnder(homeDir: string): { packDirs: string[]; warning: string | null } {
  const packsDir = path.join(homeDir, PACKS_DIR_NAME);
  if (!fs.existsSync(packsDir)) return { packDirs: [], warning: null };
  try {
    const packDirs = fs.readdirSync(packsDir, { withFileTypes: true })
      .map((entry) => path.join(packsDir, entry.name))
      .filter((packDir) => fs.existsSync(path.join(packDir, PR_PACK_FILE_NAME)))
      .sort();
    return { packDirs, warning: null };
  } catch (error) {
    return { packDirs: [], warning: `The packs folder ${packsDir} could not be read, so its packs were skipped: ${errorMessage(error)}` };
  }
}

export function loadPacks({ homeDir, configPaths, env }: { homeDir: string; configPaths: readonly string[]; env: NodeJS.ProcessEnv }): { packs: PrPackOnDisk[]; warnings: string[] } {
  const packs: PrPackOnDisk[] = [];
  const homePacks = packDirsUnder(homeDir);
  const warnings: string[] = homePacks.warning === null ? [] : [homePacks.warning];
  const packDirs = [...new Set([...homePacks.packDirs, ...configPaths.map((configPath) => path.resolve(homeDir, configPath))])];
  for (const packDir of packDirs) {
    const read = readPackDir(packDir, env);
    if (!read.ok) {
      warnings.push(`The pack at ${packDir} was skipped: ${read.errors[0] ?? 'unreadable'}`);
      continue;
    }
    if (packs.some((loaded) => loaded.pack.name === read.pack.pack.name)) {
      warnings.push(`The pack at ${packDir} was skipped: another pack is already named '${read.pack.pack.name}'`);
      continue;
    }
    packs.push(read.pack);
  }
  return { packs, warnings };
}
