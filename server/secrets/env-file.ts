import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { runGit } from '../git/git-exec.ts';
import { upsertEnvLines } from './core/env-file-core.ts';

const ENV_FILE_NAME = '.env.local';
const ENV_FILE_MODE = 0o600;

type EnvFileWrite = { ok: true; envFile: string } | { ok: false; reason: string };

async function isInsideGitWorkTree(directory: string): Promise<boolean> {
  const probe = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: directory });
  return probe.ok && probe.out.trim() === 'true';
}

async function excludeFromGit(directory: string): Promise<string | null> {
  if (!(await isInsideGitWorkTree(directory))) return null;
  if ((await runGit(['ls-files', '--error-unmatch', '--', ENV_FILE_NAME], { cwd: directory })).ok) return `${ENV_FILE_NAME} is tracked by git, so Glimmervoid will not write secrets into it`;
  if ((await runGit(['check-ignore', '-q', '--', ENV_FILE_NAME], { cwd: directory })).ok) return null;
  const excludePath = await runGit(['rev-parse', '--git-path', 'info/exclude'], { cwd: directory });
  if (!excludePath.ok) return `git could not name the exclude file: ${excludePath.err.trim()}`;
  const excludeFile = path.resolve(directory, excludePath.out.trim());
  await fsp.mkdir(path.dirname(excludeFile), { recursive: true });
  const existingExcludes = await fsp.readFile(excludeFile, 'utf8').catch(() => '');
  const separator = existingExcludes === '' || existingExcludes.endsWith('\n') ? '' : '\n';
  await fsp.appendFile(excludeFile, `${separator}${ENV_FILE_NAME}\n`);
  if ((await runGit(['check-ignore', '-q', '--', ENV_FILE_NAME], { cwd: directory })).ok) return null;
  return `a .gitignore rule keeps ${ENV_FILE_NAME} visible to git, so Glimmervoid will not write secrets into it`;
}

async function readExistingEnvFile(envFile: string): Promise<string | null> {
  const stat = await fsp.lstat(envFile).catch(() => null);
  if (stat === null) return '';
  if (!stat.isFile()) return null;
  return fsp.readFile(envFile, 'utf8');
}

async function replaceWithStagedFile(stagingFile: string, targetFile: string, text: string): Promise<void> {
  try {
    await fsp.writeFile(stagingFile, text, { mode: ENV_FILE_MODE, flag: 'wx' });
    await fsp.rename(stagingFile, targetFile);
  } finally {
    await fsp.rm(stagingFile, { force: true });
  }
}

const writeChainByDirectory = new Map<string, Promise<EnvFileWrite>>();

function writeEnvFile(directory: string, valuesByName: Readonly<Record<string, string>>): Promise<EnvFileWrite> {
  const resolvedDirectory = path.resolve(directory);
  const previousWrite = writeChainByDirectory.get(resolvedDirectory) ?? Promise.resolve<EnvFileWrite>({ ok: true, envFile: '' });
  const nextWrite = previousWrite.then(() => writeEnvFileNow(resolvedDirectory, valuesByName));
  writeChainByDirectory.set(resolvedDirectory, nextWrite);
  void nextWrite.then(() => {
    if (writeChainByDirectory.get(resolvedDirectory) === nextWrite) writeChainByDirectory.delete(resolvedDirectory);
  });
  return nextWrite;
}

async function writeEnvFileNow(directory: string, valuesByName: Readonly<Record<string, string>>): Promise<EnvFileWrite> {
  try {
    const refusal = await excludeFromGit(directory);
    if (refusal !== null) return { ok: false, reason: refusal };
    const envFile = path.join(directory, ENV_FILE_NAME);
    const existingText = await readExistingEnvFile(envFile);
    if (existingText === null) return { ok: false, reason: `${ENV_FILE_NAME} is not a plain file` };
    const stagingFile = path.join(directory, `${ENV_FILE_NAME}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    await replaceWithStagedFile(stagingFile, envFile, upsertEnvLines(existingText, valuesByName));
    await fsp.chmod(envFile, ENV_FILE_MODE);
    return { ok: true, envFile };
  } catch (error) {
    return { ok: false, reason: `could not write ${ENV_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export { writeEnvFile };
export type { EnvFileWrite };
