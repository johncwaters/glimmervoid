import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PACK_FILE_NAME, PackHeader, PackPrFlows } from '../../shared/contracts/pack.ts';
import type { PackOnDisk, PackSection } from '../../shared/contracts/pack.ts';
import { withoutGlimmervoidSecrets } from '../../session/core/spawn-env.ts';
import { errorMessage } from '../../shared/text.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import type { z } from 'zod';

const PACK_MAX_TOTAL_BYTES = 1024 * 1024;
export const PACKS_DIR_NAME = 'packs';
const PACKS_STATE_FILE_NAME = 'packs-state.json';

export function packsStatePath(homeDir: string): string {
  return path.join(homeDir, PACKS_STATE_FILE_NAME);
}

export type PackRead = { ok: true; pack: PackOnDisk } | { ok: false; errors: string[] };
type PackFilesRead = { ok: true; filesByPath: Map<string, Buffer> } | { ok: false; error: string };

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function readPackFiles(packDir: string): Promise<PackFilesRead> {
  const filesByPath = new Map<string, Buffer>();
  const pendingDirs = [''];
  let totalBytes = 0;
  while (pendingDirs.length > 0) {
    const relativeDir = pendingDirs.pop() ?? '';
    for (const entry of await fs.promises.readdir(path.join(packDir, relativeDir), { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isSymbolicLink()) return { ok: false, error: `${relativePath} is a symlink, and a pack holds only its own files` };
      if (entry.isDirectory()) {
        pendingDirs.push(relativePath);
        continue;
      }
      if (!entry.isFile()) return { ok: false, error: `${relativePath} is not a regular file` };
      totalBytes += (await fs.promises.lstat(path.join(packDir, relativePath))).size;
      if (totalBytes > PACK_MAX_TOTAL_BYTES) return { ok: false, error: 'the pack is over 1 MiB' };
      filesByPath.set(relativePath, await fs.promises.readFile(path.join(packDir, relativePath)));
    }
  }
  return { ok: true, filesByPath };
}

function packFingerprint(filesByPath: ReadonlyMap<string, Buffer>): string {
  const fileHashes = [...filesByPath].map(([relativePath, bytes]) => [relativePath, sha256(bytes)]).sort(([left = ''], [right = '']) => left.localeCompare(right));
  return sha256(JSON.stringify(fileHashes));
}

async function isProgramOnPath(program: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, program);
    const isExecutableFile = await fs.promises.access(candidate, fs.constants.X_OK)
      .then(async () => (await fs.promises.stat(candidate)).isFile())
      .catch(() => false);
    if (isExecutableFile) return true;
  }
  return false;
}

async function missingRequires(requires: PackHeader['requires'], env: NodeJS.ProcessEnv): Promise<string[]> {
  const commandEnv = withoutGlimmervoidSecrets(env);
  const missingPrograms: string[] = [];
  for (const program of requires.programs) {
    if (!await isProgramOnPath(program, env)) missingPrograms.push(`program ${program}`);
  }
  return [...requires.env.filter((name) => !commandEnv[name]).map((name) => `env ${name}`), ...missingPrograms];
}

function issueLines(error: z.ZodError, sectionLabel: string): string[] {
  return error.issues.map((issue) => `${[sectionLabel, ...issue.path.map(String)].join('.')}: ${issue.message}`);
}

function parseSection<Value>(schema: z.ZodType<Value>, raw: unknown, sectionName: string): PackSection<Value> | null {
  if (raw === undefined) return null;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: issueLines(parsed.error, `${PACK_FILE_NAME} ${sectionName}`) };
}

async function readPackDirUnguarded(packDir: string, env: NodeJS.ProcessEnv): Promise<PackRead> {
  if (/[{}]/.test(packDir)) return { ok: false, errors: [`${packDir} has { or } in its path, which a command placeholder would misread`] };
  const stats = await fs.promises.lstat(packDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) return { ok: false, errors: [`${packDir} is not a directory; a symlinked pack is refused`] };
  const read = await readPackFiles(packDir);
  if (!read.ok) return { ok: false, errors: [read.error] };
  const manifest = read.filesByPath.get(PACK_FILE_NAME);
  if (!manifest) return { ok: false, errors: [`there is no ${PACK_FILE_NAME}`] };
  const header = PackHeader.safeParse(parseJsonOrNull(manifest.toString('utf8')));
  if (!header.success) return { ok: false, errors: header.error.issues.map((issue) => `${PACK_FILE_NAME} ${issue.path.join('.') || '(root)'}: ${issue.message}`) };
  return {
    ok: true,
    pack: {
      dir: packDir, header: header.data, fingerprint: packFingerprint(read.filesByPath), filesByPath: read.filesByPath,
      prFlows: parseSection(PackPrFlows, header.data.prFlows, 'prFlows'), missingRequires: await missingRequires(header.data.requires, env),
    },
  };
}

export async function readPackDir(packDir: string, env: NodeJS.ProcessEnv): Promise<PackRead> {
  const absoluteDir = path.resolve(packDir);
  try {
    return await readPackDirUnguarded(absoluteDir, env);
  } catch (error) {
    return { ok: false, errors: [`could not read ${absoluteDir}: ${errorMessage(error)}`] };
  }
}

export async function packDirsUnder(homeDir: string): Promise<{ packDirs: string[]; warning: string | null }> {
  const packsDir = path.join(homeDir, PACKS_DIR_NAME);
  const entries = await fs.promises.readdir(packsDir, { withFileTypes: true }).then(
    (dirEntries) => ({ ok: true as const, dirEntries }),
    (error: NodeJS.ErrnoException) => ({ ok: false as const, error }),
  );
  if (!entries.ok && entries.error.code === 'ENOENT') return { packDirs: [], warning: null };
  if (!entries.ok) return { packDirs: [], warning: `The packs folder ${packsDir} could not be read, so its packs were skipped: ${errorMessage(entries.error)}` };
  const packDirs: string[] = [];
  for (const entry of entries.dirEntries) {
    const packDir = path.join(packsDir, entry.name);
    const hasManifest = await fs.promises.access(path.join(packDir, PACK_FILE_NAME)).then(() => true, () => false);
    if (hasManifest) packDirs.push(packDir);
  }
  return { packDirs: packDirs.sort(), warning: null };
}
