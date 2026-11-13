import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACK_FILE_NAME, PackHeader, PackSourcesFile } from '../../shared/contracts/pack.ts';
import type { PackRow, PackSourceRow } from '../../shared/contracts/control/pack-messages.ts';
import { canonicalizePath } from '../../shared/canonical-paths.ts';
import { errorMessage } from '../../shared/text.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { firstLine } from '../core/text-core.ts';
import { runGit } from '../git/git-exec.ts';
import { writeTextAtomic } from '../json-file.ts';
import { PACK_ICON_MAX_BYTES, SOURCE_ICONS_MAX_BYTES, packIconDataUrl, sourcePackDetails } from './core/pack-core.ts';
import { packSourceOf } from './core/pack-sources-core.ts';
import { PACK_MAX_TOTAL_BYTES, PACKS_DIR_NAME, readPackDir } from './pack-files.ts';
import { installPack, readInstalledFingerprints, removeHandPlacedPack, removeInstalledPack } from './pack-install.ts';

const PACK_SOURCES_DIR_NAME = 'pack-sources';
const PACK_SOURCES_FILE_NAME = 'pack-sources.json';
export const EXAMPLES_SOURCE_SLUG = 'glimmervoid-examples';
const EXAMPLES_SOURCE_URL = 'Ships with Glimmervoid';
const EXAMPLES_FOLLOW_DEBOUNCE_MS = 1000;
const EXAMPLES_REWATCH_MS = 30_000;
const GIT_TIMEOUT_MS = 120_000;
const PACK_FOLDER_MAX_DEPTH = 2;
const MAX_CHILD_FOLDERS_PER_LEVEL = 200;
const SKIPPED_FOLDER_NAMES: readonly string[] = ['node_modules'];
const SAFE_GIT_CONFIG = ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.symlinks=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];

type SourceEntry = PackSourcesFile['sources'][number];
type SourcePack = { name: string; dir: string } & ReturnType<typeof sourcePackDetails>;
type SourcePackRow = PackSourceRow['packs'][number];
type SourceOutcome = { ok: true; text: string } | { ok: false; error: string };
type SourceUpdate = { isUpdated: boolean; text: string; enabledPacks: string[] };
type GitRunner = typeof runGit;

type PackSourcesDeps = {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  examplePacksDir: string;
  log: { warn: (text: string) => void };
  packRows: () => readonly PackRow[];
  isApproved: (fingerprint: string) => boolean;
  onChange: () => void;
  runGitFn?: GitRunner;
  examplesRewatchMs?: number;
};

async function packHereIn(folder: string): Promise<SourcePack[]> {
  const manifestPath = path.join(folder, PACK_FILE_NAME);
  const manifestStat = await fs.promises.lstat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.size > PACK_MAX_TOTAL_BYTES) return [];
  const manifestText = await fs.promises.readFile(manifestPath, 'utf8').catch(() => null);
  const header = manifestText === null ? null : PackHeader.safeParse(parseJsonOrNull(manifestText));
  return header?.success ? [{ name: header.data.name, dir: folder, ...sourcePackDetails(header.data) }] : [];
}

async function iconBytesOf(pack: SourcePack): Promise<Buffer | null> {
  if (pack.iconPath === null) return null;
  const iconPath = path.join(pack.dir, pack.iconPath);
  const [realPackDir, realIconPath] = await Promise.all([fs.promises.realpath(pack.dir), fs.promises.realpath(iconPath)]).catch(() => [null, null]);
  if (realPackDir === null || realIconPath === null || !realIconPath.startsWith(`${realPackDir}${path.sep}`)) return null;
  const iconStat = await fs.promises.lstat(iconPath).catch(() => null);
  if (!iconStat?.isFile() || iconStat.size > PACK_ICON_MAX_BYTES) return null;
  return fs.promises.readFile(iconPath).catch(() => null);
}

async function sourcePackRows(packs: readonly SourcePack[], enabledPacks: readonly string[]): Promise<SourcePackRow[]> {
  const rows: SourcePackRow[] = [];
  let remainingIconBytes = SOURCE_ICONS_MAX_BYTES;
  for (const { iconPath, ...pack } of packs) {
    const iconBytes = remainingIconBytes <= 0 ? null : await iconBytesOf({ ...pack, iconPath });
    const isIconInBudget = iconBytes !== null && iconBytes.length <= remainingIconBytes;
    if (isIconInBudget) remainingIconBytes -= iconBytes.length;
    rows.push({ ...pack, isEnabled: enabledPacks.includes(pack.name), iconDataUrl: isIconInBudget ? packIconDataUrl(iconBytes) : null });
  }
  return rows;
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

export function createPackSources({ homeDir, env, examplePacksDir, log, packRows, isApproved, onChange, runGitFn = runGit, examplesRewatchMs = EXAMPLES_REWATCH_MS }: PackSourcesDeps) {
  const sourcesDir = path.join(homeDir, PACK_SOURCES_DIR_NAME);
  const ledgerPath = path.join(homeDir, PACK_SOURCES_FILE_NAME);
  const installDeps = { homeDir, env, packRows, isApproved };
  const envWithoutGit = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')));
  const gitEnv: NodeJS.ProcessEnv = { ...envWithoutGit, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: sourcesDir };
  const gitOptions = (cwd: string) => ({ cwd, replaceEnv: gitEnv, timeoutMs: GIT_TIMEOUT_MS, preferStderr: true });
  let rows: PackSourceRow[] = [];
  let changes: Promise<unknown> = Promise.resolve();
  let examplesWatcher: fs.FSWatcher | null = null;
  let followTimer: NodeJS.Timeout | null = null;
  let lifecycle: 'running' | 'stopped' = 'running';
  let lastWatchFailure = '';

  const isBuiltIn = (source: SourceEntry) => source.slug === EXAMPLES_SOURCE_SLUG;
  const dirOf = (source: SourceEntry) => (isBuiltIn(source) ? examplePacksDir : path.join(sourcesDir, source.slug));

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
    const examplesSource = ledger.data.sources.find(isBuiltIn) ?? { url: EXAMPLES_SOURCE_URL, slug: EXAMPLES_SOURCE_SLUG, enabledPacks: [] };
    return { ok: true, sources: [...ledger.data.sources.filter((source) => !isBuiltIn(source)), examplesSource] };
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
      const dir = dirOf(source);
      const packs = await packFoldersIn(dir, 0);
      const missingFix = isBuiltIn(source) ? 'this install of Glimmervoid ships no example packs' : 'remove the source and add it again';
      const missingText = await fs.promises.stat(dir).then(() => null, () => `${dir} is missing; ${missingFix}`);
      return { url: source.url, slug: source.slug, dir, isBuiltIn: isBuiltIn(source), packs: await sourcePackRows(packs, source.enabledPacks), error: missingText };
    }));
  }

  async function withSource(slug: string, act: (source: SourceEntry, sources: SourceEntry[]) => Promise<SourceOutcome>): Promise<SourceOutcome> {
    const read = await readSources();
    if (!read.ok) return read;
    const source = read.sources.find((candidate) => candidate.slug === slug);
    if (!source) return { ok: false, error: `No pack source ${slug}; list them in the Packs tab` };
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
    return { ok: true, text: `Added the pack source ${target.slug} from ${target.url}; ${packsText}. Each stays off until the operator enables it in the Packs tab, and then waits for approval.` };
  }

  async function isInstalledCopyCurrent(pack: SourcePack, installedFingerprints: Readonly<Record<string, string>> | null): Promise<boolean> {
    const recordedFingerprint = installedFingerprints?.[pack.name];
    if (recordedFingerprint === undefined) return false;
    const read = await readPackDir(pack.dir, env);
    return read.ok && read.pack.fingerprint === recordedFingerprint;
  }

  async function isGlimmervoidInstall(packName: string): Promise<boolean> {
    const recordedFingerprint = (await readInstalledFingerprints(homeDir))?.[packName];
    if (recordedFingerprint === undefined) return false;
    const read = await readPackDir(path.join(homeDir, PACKS_DIR_NAME, packName), env);
    return read.ok && read.pack.fingerprint === recordedFingerprint;
  }

  async function withFollowedFingerprints(source: SourceEntry, enabledPacks: readonly string[]): Promise<SourceEntry> {
    if (!isBuiltIn(source)) return { ...source, enabledPacks: [...enabledPacks] };
    const installedFingerprints = (await readInstalledFingerprints(homeDir)) ?? {};
    const followed = enabledPacks.flatMap((name) => (installedFingerprints[name] === undefined ? [] : [[name, installedFingerprints[name]] as const]));
    return { ...source, enabledPacks: [...enabledPacks], installedFingerprintsByName: Object.fromEntries(followed) };
  }

  async function reinstallEnabled(source: SourceEntry, isOnlyChanged: boolean): Promise<{ isComplete: boolean; lines: string[]; enabledPacks: string[] }> {
    const packs = await packFoldersIn(dirOf(source), 0);
    const installedFingerprints = isOnlyChanged ? await readInstalledFingerprints(homeDir) : null;
    const lines: string[] = [];
    const enabledPacks: string[] = [];
    let isComplete = true;
    for (const name of source.enabledPacks) {
      const installedCheck = await fs.promises.lstat(path.join(homeDir, PACKS_DIR_NAME, name)).then(() => 'present' as const, (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? 'removed' as const : errorMessage(error)));
      if (installedCheck !== 'present' && installedCheck !== 'removed') {
        enabledPacks.push(name);
        isComplete = false;
        lines.push(`${name} was not reinstalled, because its installed folder could not be read: ${installedCheck}`);
        continue;
      }
      if (installedCheck === 'removed') {
        lines.push(`${name} was removed since it was enabled, so it is off now and not reinstalled`);
        continue;
      }
      const followedFingerprint = source.installedFingerprintsByName?.[name];
      if (isOnlyChanged && followedFingerprint !== undefined && installedFingerprints?.[name] !== followedFingerprint) {
        lines.push(`${name} was replaced by another install, so it is off here and no longer follows Glimmervoid`);
        continue;
      }
      enabledPacks.push(name);
      const pack = packs.find((candidate) => candidate.name === name);
      if (!pack) {
        lines.push(`${name} is gone from the source; its installed copy stays until removed`);
        continue;
      }
      if (isOnlyChanged && await isInstalledCopyCurrent(pack, installedFingerprints)) continue;
      const installed = await installPack(pack.dir, installDeps);
      if (!installed.ok) isComplete = false;
      lines.push(installed.ok ? `${name} reinstalled; it waits for approval again if any file changed` : `${name} was not reinstalled: ${installed.error}`);
    }
    return { isComplete, lines, enabledPacks };
  }

  async function isOwnClone(cloneDir: string): Promise<boolean> {
    const cloneStat = await fs.promises.lstat(cloneDir).catch(() => null);
    if (!cloneStat?.isDirectory()) return false;
    const gitStat = await fs.promises.lstat(path.join(cloneDir, '.git')).catch(() => null);
    if (!gitStat?.isDirectory()) return false;
    const realSourcesDir = await fs.promises.realpath(sourcesDir).catch(() => null);
    const realCloneDir = await fs.promises.realpath(cloneDir).catch(() => null);
    return realSourcesDir !== null && realCloneDir !== null && path.dirname(realCloneDir) === realSourcesDir;
  }

  async function updateOne(source: SourceEntry): Promise<SourceUpdate> {
    const cloneDir = path.join(sourcesDir, source.slug);
    if (!await isOwnClone(cloneDir)) return { isUpdated: false, enabledPacks: source.enabledPacks, text: `${source.slug}: ${cloneDir} is not the clone Glimmervoid made; remove the source and add it again` };
    const cloneGit = [...SAFE_GIT_CONFIG, `--git-dir=${path.join(cloneDir, '.git')}`, `--work-tree=${cloneDir}`];
    const fetched = await runGitFn([...cloneGit, 'fetch', '--depth', '1', '--no-tags', 'origin', 'HEAD'], gitOptions(cloneDir));
    if (!fetched.ok) return { isUpdated: false, enabledPacks: source.enabledPacks, text: `${source.slug}: ${gitFailureText('git fetch', fetched.err)}` };
    const reset = await runGitFn([...cloneGit, 'reset', '--hard', 'FETCH_HEAD'], gitOptions(cloneDir));
    if (!reset.ok) return { isUpdated: false, enabledPacks: source.enabledPacks, text: `${source.slug}: ${gitFailureText('git reset', reset.err)}` };
    const reinstalled = await reinstallEnabled(source, false);
    return { isUpdated: reinstalled.isComplete, enabledPacks: reinstalled.enabledPacks, text: [`${source.slug}: updated from ${source.url}`, ...reinstalled.lines.map((line) => `  ${line}`)].join('\n') };
  }

  async function updateNow(slug: string | null): Promise<SourceOutcome> {
    const read = await readSources();
    if (!read.ok) return read;
    if (slug === EXAMPLES_SOURCE_SLUG) return { ok: false, error: 'Glimmervoid examples follow Glimmervoid itself, so there is nothing to pull' };
    const chosen = slug === null ? read.sources.filter((source) => !isBuiltIn(source)) : read.sources.filter((source) => source.slug === slug);
    if (chosen.length === 0) return { ok: false, error: slug === null ? 'There are no pack sources to update' : `No pack source ${slug}` };
    const enabledPacksBySlug = new Map<string, string[]>();
    const updates: SourceUpdate[] = [];
    for (const source of chosen) {
      const update = await updateOne(source);
      enabledPacksBySlug.set(source.slug, update.enabledPacks);
      updates.push(update);
    }
    await writeSources(read.sources.map((source) => ({ ...source, enabledPacks: enabledPacksBySlug.get(source.slug) ?? source.enabledPacks })));
    const text = updates.map((update) => update.text).join('\n');
    return updates.every((update) => update.isUpdated) ? { ok: true, text } : { ok: false, error: text };
  }

  function enableNow(slug: string, packName: string, isEnabled: boolean): Promise<SourceOutcome> {
    return withSource(slug, async (source, sources) => {
      const pack = (await packFoldersIn(dirOf(source), 0)).find((candidate) => candidate.name === packName);
      if (isEnabled && !pack) return { ok: false, error: `${slug} has no pack named ${packName}` };
      const isOwned = source.enabledPacks.includes(packName);
      if (!isEnabled && !isOwned) return { ok: true, text: `${packName} is already off` };
      const otherOwner = sources.find((candidate) => candidate.slug !== slug && candidate.enabledPacks.includes(packName));
      if (isEnabled && otherOwner) return { ok: false, error: `${packName} is already enabled from ${otherOwner.url}; turn it off there first` };
      const installedDir = path.join(homeDir, PACKS_DIR_NAME, packName);
      const isPlacedElsewhere = isEnabled && !isOwned && await fs.promises.lstat(installedDir).then(() => true, () => false);
      const isInstalledByGlimmervoid = isPlacedElsewhere && await isGlimmervoidInstall(packName);
      if (isPlacedElsewhere && !isInstalledByGlimmervoid) return { ok: false, error: `${installedDir} was placed by hand, so it is left alone; remove it with Remove folder on its row above, then enable again` };
      if (isPlacedElsewhere && !isBuiltIn(source)) return { ok: false, error: `${packName} is already installed outside this source; remove it first with glimmervoid packs remove ${packName}` };
      const outcome = isEnabled && pack ? await installPack(pack.dir, installDeps) : await removeInstalledPack(packName, homeDir, env);
      if (!outcome.ok && isEnabled) return outcome;
      const enabledPacks = isEnabled ? [...new Set([...source.enabledPacks, packName])] : source.enabledPacks.filter((name) => name !== packName);
      const updatedSource = await withFollowedFingerprints(source, enabledPacks);
      await writeSources(sources.map((candidate) => (candidate.slug === slug ? updatedSource : candidate)));
      if (isEnabled) return { ok: true, text: `Installed ${packName} from ${slug}; it waits for approval` };
      return { ok: true, text: outcome.ok ? `Removed ${packName}` : `${packName} is off; ${outcome.error}` };
    });
  }

  function removeNow(slug: string): Promise<SourceOutcome> {
    return withSource(slug, async (source, sources) => {
      if (isBuiltIn(source)) return { ok: false, error: 'Glimmervoid examples ship with Glimmervoid and stay listed; turn off the packs you do not want instead' };
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

  function followExamplesNow(): Promise<SourceOutcome> {
    return withSource(EXAMPLES_SOURCE_SLUG, async (source, sources) => {
      if (source.enabledPacks.length === 0) return { ok: true, text: '' };
      const followed = await reinstallEnabled(source, true);
      const updatedSource = await withFollowedFingerprints(source, followed.enabledPacks);
      if (JSON.stringify(updatedSource) !== JSON.stringify(source)) await writeSources(sources.map((candidate) => (isBuiltIn(candidate) ? updatedSource : candidate)));
      const text = followed.lines.join('\n');
      return followed.isComplete ? { ok: true, text } : { ok: false, error: text };
    });
  }

  async function followExamples(): Promise<SourceOutcome> {
    const outcome = await serialized(followExamplesNow);
    if (!outcome.ok) log.warn(`[packs] could not follow the Glimmervoid examples: ${outcome.error}`);
    return outcome;
  }

  function scheduleFollow(delayMs: number): void {
    if (lifecycle === 'stopped') return;
    if (followTimer) clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      followTimer = null;
      watchExamples();
      void followExamples();
    }, delayMs);
  }

  function watchExamples(): void {
    examplesWatcher?.close();
    examplesWatcher = null;
    if (lifecycle === 'stopped') return;
    try {
      examplesWatcher = fs.watch(canonicalizePath(examplePacksDir), { recursive: true }, () => scheduleFollow(EXAMPLES_FOLLOW_DEBOUNCE_MS));
      examplesWatcher.on('error', (error) => {
        log.warn(`[packs] stopped watching ${examplePacksDir}: ${errorMessage(error)}`);
        scheduleFollow(EXAMPLES_FOLLOW_DEBOUNCE_MS);
      });
      lastWatchFailure = '';
    } catch (error: unknown) {
      const failure = errorMessage(error);
      if (failure !== lastWatchFailure) log.warn(`[packs] could not watch ${examplePacksDir}; trying again every ${examplesRewatchMs / 1000} s: ${failure}`);
      lastWatchFailure = failure;
      scheduleFollow(examplesRewatchMs);
    }
  }

  return {
    start: async () => {
      const outcome = await followExamples();
      watchExamples();
      return outcome;
    },
    stop: () => {
      lifecycle = 'stopped';
      if (followTimer) clearTimeout(followTimer);
      followTimer = null;
      examplesWatcher?.close();
      examplesWatcher = null;
    },
    rows: (): readonly PackSourceRow[] => rows,
    add: (url: string) => serialized(() => addNow(url)),
    update: (slug: string | null) => serialized(() => updateNow(slug)),
    setPackEnabled: (slug: string, packName: string, isEnabled: boolean) => serialized(() => enableNow(slug, packName, isEnabled)),
    removeHandPlacedFolder: (packDir: string) => serialized(async () => {
      const removed = await removeHandPlacedPack(packDir, homeDir, env);
      return removed.ok ? { ok: true, text: `Removed ${removed.dir}` } : removed;
    }),
    remove: (slug: string) => serialized(() => removeNow(slug)),
  };
}

export type PackSources = ReturnType<typeof createPackSources>;
