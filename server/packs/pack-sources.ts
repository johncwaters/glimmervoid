import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACK_FILE_NAME, PackHeader, PackSourcesFile } from '../../shared/contracts/pack.ts';
import type { PackRow, PackSourceRow } from '../../shared/contracts/control/pack-messages.ts';
import { errorMessage } from '../../shared/text.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { firstLine } from '../core/text-core.ts';
import { runGit } from '../git/git-exec.ts';
import { writeTextAtomic } from '../json-file.ts';
import { packSourceOf } from './core/pack-sources-core.ts';
import { PACK_MAX_TOTAL_BYTES, PACKS_DIR_NAME } from './pack-files.ts';
import { installPack, removeInstalledPack } from './pack-install.ts';

const PACK_SOURCES_DIR_NAME = 'pack-sources';
const PACK_SOURCES_FILE_NAME = 'pack-sources.json';
const GIT_TIMEOUT_MS = 120_000;
const PACK_FOLDER_MAX_DEPTH = 2;
const MAX_CHILD_FOLDERS_PER_LEVEL = 200;
const SKIPPED_FOLDER_NAMES: readonly string[] = ['node_modules'];
const SAFE_GIT_CONFIG = ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.symlinks=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];

type SourceEntry = PackSourcesFile['sources'][number];
type SourcePack = { name: string; dir: string };
type SourceOutcome = { ok: true; text: string } | { ok: false; error: string };
type SourceUpdate = { isUpdated: boolean; text: string };
type GitRunner = typeof runGit;

type PackSourcesDeps = {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  packRows: () => readonly PackRow[];
  isApproved: (fingerprint: string) => boolean;
  onChange: () => void;
  runGitFn?: GitRunner;
};

async function packHereIn(folder: string): Promise<SourcePack[]> {
  const manifestPath = path.join(folder, PACK_FILE_NAME);
  const manifestStat = await fs.promises.lstat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.size > PACK_MAX_TOTAL_BYTES) return [];
  const manifestText = await fs.promises.readFile(manifestPath, 'utf8').catch(() => null);
  const header = manifestText === null ? null : PackHeader.safeParse(parseJsonOrNull(manifestText));
  return header?.success ? [{ name: header.data.name, dir: folder }] : [];
}

async function packFoldersIn(folder: string, depth: number): Promise<SourcePack[]> {
  const here = depth === 0 ? [] : await packHereIn(folder);
  if (depth >= PACK_FOLDER_MAX_DEPTH) return here;
  const entries = await fs.promises.readdir(folder, { withFileTypes: true }).catch(() => []);
  const childFolders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_FOLDER_NAMES.includes(entry.name)).slice(0, MAX_CHILD_FOLDERS_PER_LEVEL);
  const nested = await Promise.all(childFolders.map((entry) => packFoldersIn(path.join(folder, entry.name), depth + 1)));
  return [...here, ...nested.flat()].sort((left, right) => left.name.localeCompare(right.name));
}

function gitFailureText(step: string, error: string): string {
  return `${step} failed: ${firstLine(error) || 'git gave no reason'}`;
}

export function createPackSources({ homeDir, env, packRows, isApproved, onChange, runGitFn = runGit }: PackSourcesDeps) {
  const sourcesDir = path.join(homeDir, PACK_SOURCES_DIR_NAME);
  const ledgerPath = path.join(homeDir, PACK_SOURCES_FILE_NAME);
  const installDeps = { homeDir, env, packRows, isApproved };
  const gitEnv: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const gitOptions = (cwd: string) => ({ cwd, replaceEnv: gitEnv, timeoutMs: GIT_TIMEOUT_MS, preferStderr: true });
  let rows: PackSourceRow[] = [];
  let changes: Promise<unknown> = Promise.resolve();

  function serialized(change: () => Promise<SourceOutcome>): Promise<SourceOutcome> {
    const running = changes.then(change).then(async (outcome) => {
      await refreshRows();
      onChange();
      return outcome;
    });
    changes = running.catch(() => undefined);
    return running;
  }

  async function readSources(): Promise<{ ok: true; sources: SourceEntry[] } | { ok: false; error: string }> {
    const text = await fs.promises.readFile(ledgerPath, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? '{}' : null));
    if (text === null) return { ok: false, error: `${ledgerPath} could not be read, so pack sources are left alone` };
    const ledger = PackSourcesFile.safeParse(parseJsonOrNull(text));
    if (!ledger.success) return { ok: false, error: `${ledgerPath} is not a valid pack sources record, so pack sources are left alone; the operator can fix or delete it` };
    return { ok: true, sources: ledger.data.sources };
  }

  async function writeSources(sources: readonly SourceEntry[]): Promise<void> {
    await writeTextAtomic(ledgerPath, `${JSON.stringify({ sources }, null, 2)}\n`, { mkdir: true });
  }

  async function refreshRows(): Promise<void> {
    const read = await readSources();
    if (!read.ok) {
      rows = [];
      return;
    }
    rows = await Promise.all(read.sources.map(async (source) => {
      const dir = path.join(sourcesDir, source.slug);
      const packs = await packFoldersIn(dir, 0);
      const missingText = await fs.promises.stat(dir).then(() => null, () => `${dir} is missing; remove the source and add it again`);
      return { url: source.url, slug: source.slug, dir, packs: packs.map((pack) => ({ ...pack, isEnabled: source.enabledPacks.includes(pack.name) })), error: missingText };
    }));
  }

  async function withSource(slug: string, act: (source: SourceEntry, sources: SourceEntry[]) => Promise<SourceOutcome>): Promise<SourceOutcome> {
    const read = await readSources();
    if (!read.ok) return read;
    const source = read.sources.find((candidate) => candidate.slug === slug);
    if (!source) return { ok: false, error: `No pack source ${slug}; list them in Settings, Packs` };
    return act(source, read.sources);
  }

  async function addNow(requestedUrl: string): Promise<SourceOutcome> {
    const target = packSourceOf(requestedUrl);
    if (!target.ok) return target;
    const read = await readSources();
    if (!read.ok) return read;
    if (read.sources.some((source) => source.slug === target.slug)) return { ok: false, error: `${target.url} is already a pack source; update it instead` };
    const cloneDir = path.join(sourcesDir, target.slug);
    await fs.promises.mkdir(sourcesDir, { recursive: true });
    await fs.promises.rm(cloneDir, { recursive: true, force: true });
    const cloned = await runGitFn([...SAFE_GIT_CONFIG, 'clone', '--depth', '1', '--single-branch', '--no-tags', '--', target.url, cloneDir], gitOptions(sourcesDir));
    if (!cloned.ok) {
      await fs.promises.rm(cloneDir, { recursive: true, force: true });
      return { ok: false, error: gitFailureText(`git clone ${target.url}`, cloned.err) };
    }
    await writeSources([...read.sources, { url: target.url, slug: target.slug, enabledPacks: [] }]);
    const packs = await packFoldersIn(cloneDir, 0);
    const packsText = packs.length === 0 ? 'it holds no pack folders' : `its packs: ${packs.map((pack) => pack.name).join(', ')}`;
    return { ok: true, text: `Added the pack source ${target.slug} from ${target.url}; ${packsText}. Each stays off until the operator enables it in Settings, Packs, and then waits for approval.` };
  }

  async function reinstallEnabled(source: SourceEntry): Promise<{ isComplete: boolean; lines: string[] }> {
    const packs = await packFoldersIn(path.join(sourcesDir, source.slug), 0);
    const lines: string[] = [];
    let isComplete = true;
    for (const name of source.enabledPacks) {
      const pack = packs.find((candidate) => candidate.name === name);
      if (!pack) {
        lines.push(`${name} is gone from the source; its installed copy stays until removed`);
        continue;
      }
      const installed = await installPack(pack.dir, installDeps);
      if (!installed.ok) isComplete = false;
      lines.push(installed.ok ? `${name} reinstalled; it waits for approval again if any file changed` : `${name} was not reinstalled: ${installed.error}`);
    }
    return { isComplete, lines };
  }

  async function updateOne(source: SourceEntry): Promise<SourceUpdate> {
    const cloneDir = path.join(sourcesDir, source.slug);
    const fetched = await runGitFn([...SAFE_GIT_CONFIG, 'fetch', '--depth', '1', '--no-tags', 'origin', 'HEAD'], gitOptions(cloneDir));
    if (!fetched.ok) return { isUpdated: false, text: `${source.slug}: ${gitFailureText('git fetch', fetched.err)}` };
    const reset = await runGitFn([...SAFE_GIT_CONFIG, 'reset', '--hard', 'FETCH_HEAD'], gitOptions(cloneDir));
    if (!reset.ok) return { isUpdated: false, text: `${source.slug}: ${gitFailureText('git reset', reset.err)}` };
    const reinstalled = await reinstallEnabled(source);
    return { isUpdated: reinstalled.isComplete, text: [`${source.slug}: updated from ${source.url}`, ...reinstalled.lines.map((line) => `  ${line}`)].join('\n') };
  }

  async function updateNow(slug: string | null): Promise<SourceOutcome> {
    const read = await readSources();
    if (!read.ok) return read;
    const chosen = slug === null ? read.sources : read.sources.filter((source) => source.slug === slug);
    if (chosen.length === 0) return { ok: false, error: slug === null ? 'There are no pack sources to update' : `No pack source ${slug}` };
    const updates: SourceUpdate[] = [];
    for (const source of chosen) updates.push(await updateOne(source));
    const text = updates.map((update) => update.text).join('\n');
    return updates.every((update) => update.isUpdated) ? { ok: true, text } : { ok: false, error: text };
  }

  function enableNow(slug: string, packName: string, isEnabled: boolean): Promise<SourceOutcome> {
    return withSource(slug, async (source, sources) => {
      const pack = (await packFoldersIn(path.join(sourcesDir, slug), 0)).find((candidate) => candidate.name === packName);
      if (isEnabled && !pack) return { ok: false, error: `${slug} has no pack named ${packName}` };
      const isOwned = source.enabledPacks.includes(packName);
      if (!isEnabled && !isOwned) return { ok: true, text: `${packName} is already off` };
      const otherOwner = sources.find((candidate) => candidate.slug !== slug && candidate.enabledPacks.includes(packName));
      if (isEnabled && otherOwner) return { ok: false, error: `${packName} is already enabled from ${otherOwner.url}; turn it off there first` };
      const isPlacedElsewhere = !isOwned && await fs.promises.lstat(path.join(homeDir, PACKS_DIR_NAME, packName)).then(() => true, () => false);
      if (isEnabled && isPlacedElsewhere) return { ok: false, error: `A pack named ${packName} is already installed outside this source; remove it first` };
      const outcome = isEnabled && pack ? await installPack(pack.dir, installDeps) : await removeInstalledPack(packName, homeDir, env);
      if (!outcome.ok && isEnabled) return outcome;
      const enabledPacks = isEnabled ? [...new Set([...source.enabledPacks, packName])] : source.enabledPacks.filter((name) => name !== packName);
      await writeSources(sources.map((candidate) => (candidate.slug === slug ? { ...candidate, enabledPacks } : candidate)));
      if (isEnabled) return { ok: true, text: `Installed ${packName} from ${slug}; it waits for approval` };
      return { ok: true, text: outcome.ok ? `Removed ${packName}` : `${packName} is off; ${outcome.error}` };
    });
  }

  function removeNow(slug: string): Promise<SourceOutcome> {
    return withSource(slug, async (source, sources) => {
      const notes: string[] = [];
      for (const name of source.enabledPacks) {
        const removed = await removeInstalledPack(name, homeDir, env);
        if (!removed.ok) notes.push(removed.error);
      }
      try {
        await fs.promises.rm(path.join(sourcesDir, slug), { recursive: true, force: true });
      } catch (error: unknown) {
        return { ok: false, error: `Could not delete ${path.join(sourcesDir, slug)}: ${errorMessage(error)}` };
      }
      await writeSources(sources.filter((candidate) => candidate.slug !== slug));
      return { ok: true, text: [`Removed the pack source ${slug}`, ...notes].join('; ') };
    });
  }

  return {
    start: () => serialized(async () => ({ ok: true, text: '' })),
    rows: (): readonly PackSourceRow[] => rows,
    add: (url: string) => serialized(() => addNow(url)),
    update: (slug: string | null) => serialized(() => updateNow(slug)),
    setPackEnabled: (slug: string, packName: string, isEnabled: boolean) => serialized(() => enableNow(slug, packName, isEnabled)),
    remove: (slug: string) => serialized(() => removeNow(slug)),
  };
}

export type PackSources = ReturnType<typeof createPackSources>;
