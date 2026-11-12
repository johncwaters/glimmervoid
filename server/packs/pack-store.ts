import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { PackRow, PacksStatus } from '../../shared/contracts/control/pack-messages.ts';
import { PACK_FILE_NAME, PacksState } from '../../shared/contracts/pack.ts';
import type { PackMcpServer, PackOnDisk } from '../../shared/contracts/pack.ts';
import { canonicalizePath } from '../../shared/canonical-paths.ts';
import { errorMessage } from '../../shared/text.ts';
import { loadJsonStateFile, writeTextAtomic } from '../json-file.ts';
import { NO_OPERATOR_MCP_SERVER_NAMES, approvedPackPanels, declaredPackSecretsOf, approvedPackThemes, packMcpServers, packMcpServersForAgent, packRow, pendingPackNote } from './core/pack-core.ts';
import type { OperatorMcpServerNames } from './core/pack-core.ts';
import { readCodexOperatorServerNames, readOperatorMcpServerNames } from './operator-mcp-servers.ts';
import { PACKS_DIR_NAME, packDirsUnder, readExamplePacks, readPackDir } from './pack-files.ts';
import type { ShippedExamplePack } from './pack-files.ts';

const PACK_RELOAD_DEBOUNCE_MS = 300;
const EXAMPLE_PACK_REFERENCE_PREFIX = 'example:';

type PackRead = Awaited<ReturnType<typeof readPackDir>>;
type PackStoreLogger = { warn: (...parts: unknown[]) => void };
type ApprovedPacks = { packs: PackOnDisk[]; warnings: string[] };
type PackApproveResult = { ok: true } | { ok: false; error: string };
type ListedPathAppender = (listedPath: string) => Promise<{ ok: true; listedPaths: string[] } | { ok: false; error: string }>;

type PackStore = EventEmitter & {
  start(): Promise<void>;
  stop(): void;
  setListedPaths(listedPaths: readonly string[]): void;
  statusFrame(): PacksStatus;
  servableFile(packName: string, accessKey: string, filePath: string): Buffer | null;
  approvedPacks(): Promise<ApprovedPacks>;
  approve(fingerprint: string): Promise<PackApproveResult>;
  isApproved(fingerprint: string): boolean;
  panelPackDir(packName: string): string | null;
  mcpServersForSession(agentId: string, cwd: string): Promise<PackMcpServer[]>;
  sharedMcpServers(agentId: string): PackMcpServer[];
  addExample(name: string): Promise<PackApproveResult>;
  declaredSecrets(): { name: string; packs: string[] }[];
};

export function createPackStore({ homeDir, statePath, env, log, examplePacksDir = null, appendListedPath = null, reloadDebounceMs = PACK_RELOAD_DEBOUNCE_MS }: {
  homeDir: string;
  examplePacksDir?: string | null;
  appendListedPath?: ListedPathAppender | null;
  statePath: string | null;
  env: NodeJS.ProcessEnv;
  log: PackStoreLogger;
  reloadDebounceMs?: number;
}): PackStore {
  const emitter = new EventEmitter();
  const accessKeySecret = crypto.randomBytes(32);
  let approvedFingerprints = new Set<string>();
  let approvalsLoadError: string | null = null;
  let approvalWrites: Promise<unknown> = Promise.resolve();
  const packsDir = path.join(homeDir, PACKS_DIR_NAME);
  const readsByDir = new Map<string, PackRead>();
  const reloadTimersByDir = new Map<string, NodeJS.Timeout>();
  const listedWatchersByDir = new Map<string, fs.FSWatcher | null>();
  let homePackDirs: string[] = [];
  let homeWarning: string | null = null;
  let homeWatcher: fs.FSWatcher | null = null;
  let isStopped = false;
  let operatorMcpServerNames: OperatorMcpServerNames = NO_OPERATOR_MCP_SERVER_NAMES;
  let examplePacks: ShippedExamplePack[] = [];

  async function refreshOperatorMcpServerNames(): Promise<void> {
    operatorMcpServerNames = await readOperatorMcpServerNames(env);
  }

  function watchQuietly(target: string, onChange: (changedName: string | null) => void, isRecursive: boolean): fs.FSWatcher | null {
    try {
      const watcher = fs.watch(canonicalizePath(target), { recursive: isRecursive }, (_event, changedName) => onChange(changedName === null ? null : String(changedName)));
      watcher.on('error', (error) => log.warn(`[packs] stopped watching ${target}: ${errorMessage(error)}`));
      return watcher;
    } catch (error) {
      const isMissing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      if (!isMissing) log.warn(`[packs] could not watch ${target}: ${errorMessage(error)}`);
      return null;
    }
  }

  async function rereadPack(packDir: string): Promise<void> {
    const isListed = listedWatchersByDir.has(packDir);
    const isUnderHome = path.dirname(packDir) === packsDir;
    const hasManifest = await fs.promises.access(path.join(packDir, PACK_FILE_NAME)).then(() => true, () => false);
    if (isStopped) return;
    if (isUnderHome) homePackDirs = hasManifest ? [...new Set([...homePackDirs, packDir])].sort() : homePackDirs.filter((dir) => dir !== packDir);
    if (!hasManifest && !isListed) {
      readsByDir.delete(packDir);
      emitter.emit('changed');
      emitter.emit('removed');
      return;
    }
    readsByDir.set(packDir, await readPackDir(packDir, env));
    await refreshOperatorMcpServerNames();
    if (!isStopped) emitter.emit('changed');
  }

  function scheduleReread(packDir: string): void {
    const pending = reloadTimersByDir.get(packDir);
    if (pending) clearTimeout(pending);
    reloadTimersByDir.set(packDir, setTimeout(() => {
      reloadTimersByDir.delete(packDir);
      void rereadPack(packDir);
    }, reloadDebounceMs));
  }

  async function refresh(): Promise<void> {
    const found = await packDirsUnder(homeDir);
    const knownDirs = [...new Set([...found.packDirs, ...listedWatchersByDir.keys()])];
    const [freshReads, freshExamples] = await Promise.all([
      Promise.all(knownDirs.map(async (packDir) => [packDir, await readPackDir(packDir, env)] as const)),
      examplePacksDir === null ? Promise.resolve([]) : readExamplePacks(examplePacksDir),
      refreshOperatorMcpServerNames(),
    ]);
    if (isStopped) return;
    const hasDroppedPack = [...readsByDir.keys()].some((packDir) => !knownDirs.includes(packDir));
    examplePacks = freshExamples;
    homeWarning = found.warning;
    homePackDirs = found.packDirs;
    readsByDir.clear();
    for (const [packDir, read] of freshReads) readsByDir.set(packDir, read);
    if (hasDroppedPack) emitter.emit('removed');
  }

  async function rescanHomePacks(): Promise<void> {
    await refresh();
    if (!isStopped) emitter.emit('changed');
  }

  function onHomePacksChange(changedName: string | null): void {
    const topSegment = changedName?.split(/[\\/]/)[0] ?? '';
    if (topSegment === '') {
      void rescanHomePacks();
      return;
    }
    scheduleReread(path.join(packsDir, topSegment));
  }

  function watchHomePacks(): void {
    if (isStopped) return;
    homeWatcher?.close();
    homeWatcher = watchQuietly(packsDir, onHomePacksChange, true);
    if (homeWatcher) return;
    homeWatcher = watchQuietly(homeDir, (changedName) => {
      if (changedName !== PACKS_DIR_NAME) return;
      watchHomePacks();
      void rescanHomePacks();
    }, false);
  }

  function listedPackDir(listedPath: string): string {
    const exampleName = listedPath.startsWith(EXAMPLE_PACK_REFERENCE_PREFIX) ? listedPath.slice(EXAMPLE_PACK_REFERENCE_PREFIX.length) : null;
    if (exampleName === null || examplePacksDir === null) return path.resolve(homeDir, listedPath);
    return path.join(examplePacksDir, path.basename(exampleName));
  }

  function setListedPaths(listedPaths: readonly string[]): void {
    const wantedDirs = new Set(listedPaths.map(listedPackDir));
    for (const [packDir, watcher] of listedWatchersByDir) {
      if (wantedDirs.has(packDir)) continue;
      watcher?.close();
      listedWatchersByDir.delete(packDir);
      if (!homePackDirs.includes(packDir)) readsByDir.delete(packDir);
      emitter.emit('changed');
    }
    for (const packDir of wantedDirs) {
      if (listedWatchersByDir.has(packDir) || isStopped) continue;
      listedWatchersByDir.set(packDir, watchQuietly(packDir, () => scheduleReread(packDir), true));
      void rereadPack(packDir);
    }
  }

  function currentReads(): { packDir: string; read: PackRead }[] {
    const takenNames = new Set<string>();
    const takenServerNames = new Set<string>();
    return [...new Set([...homePackDirs, ...listedWatchersByDir.keys()])].flatMap((packDir): { packDir: string; read: PackRead }[] => {
      const read = readsByDir.get(packDir);
      if (!read) return [];
      if (!read.ok) return [{ packDir, read }];
      const name = read.pack.header.name;
      if (takenNames.has(name)) return [{ packDir, read: { ok: false, errors: [`another pack is already named '${name}'`] } }];
      takenNames.add(name);
      const takenServer = packMcpServers(read.pack).find((server) => takenServerNames.has(server.name));
      if (takenServer) return [{ packDir, read: { ok: false, errors: [`another pack already adds an MCP server named '${takenServer.name}'`] } }];
      for (const server of packMcpServers(read.pack)) takenServerNames.add(server.name);
      return [{ packDir, read }];
    });
  }

  function rows(): PackRow[] {
    return currentReads().map(({ packDir, read }) => packRow(packDir, read, approvedFingerprints, operatorMcpServerNames));
  }

  function packEntriesInUse(): { packDir: string; pack: PackOnDisk }[] {
    return currentReads().flatMap(({ packDir, read }) => (read.ok && approvedFingerprints.has(read.pack.fingerprint) && read.pack.missingRequires.length === 0 ? [{ packDir, pack: read.pack }] : []));
  }

  function packsInUse(): PackOnDisk[] {
    return packEntriesInUse().map(({ pack }) => pack);
  }

  function statusFrame(): PacksStatus {
    const inUse = packsInUse();
    return { type: 'packs-status', packs: rows(), examples: exampleRows(), themes: approvedPackThemes(inUse), panels: approvedPackPanels(inUse, packAccessKey), warnings: homeWarning === null ? [] : [homeWarning] };
  }

  function packAccessKey(pack: PackOnDisk): string {
    return crypto.createHmac('sha256', accessKeySecret).update(`${pack.header.name}\0${pack.fingerprint}`).digest('hex');
  }

  function servableFile(packName: string, accessKey: string, filePath: string): Buffer | null {
    const offeredKey = Buffer.from(accessKey);
    const pack = packsInUse().find((candidate) => {
      const expectedKey = Buffer.from(packAccessKey(candidate));
      return candidate.header.name === packName && expectedKey.length === offeredKey.length && crypto.timingSafeEqual(expectedKey, offeredKey);
    });
    return pack?.filesByPath.get(filePath) ?? null;
  }

  async function approvedPacks(): Promise<ApprovedPacks> {
    await refresh();
    const packs: PackOnDisk[] = [];
    const warnings = homeWarning === null ? [] : [homeWarning];
    for (const { packDir, read } of currentReads()) {
      if (!read.ok) {
        warnings.push(`The pack at ${packDir} was skipped: ${read.errors[0] ?? 'unreadable'}`);
        continue;
      }
      if (approvedFingerprints.has(read.pack.fingerprint)) {
        packs.push(read.pack);
        continue;
      }
      warnings.push(pendingPackNote(packRow(packDir, read, approvedFingerprints, operatorMcpServerNames)));
    }
    return { packs, warnings };
  }

  async function loadApprovals(): Promise<void> {
    if (!statePath) return;
    const outcome = await loadJsonStateFile({ filePath: statePath, parse: (raw) => PacksState.safeParse(raw).data ?? null });
    if (outcome.status === 'unreadable' || outcome.status === 'corrupt') {
      approvalsLoadError = `${statePath} could not be read: ${errorMessage(outcome.error)}`;
      log.warn(`[packs] ${approvalsLoadError}`);
      return;
    }
    if (outcome.status === 'quarantined') log.warn(`[packs] ${statePath} was unreadable and moved to ${outcome.movedTo}`);
    approvalsLoadError = null;
    approvedFingerprints = new Set(outcome.status === 'loaded' ? outcome.value.approvedFingerprints : []);
  }

  async function persistApproval(fingerprint: string): Promise<PackApproveResult> {
    if (!statePath) return { ok: false, error: 'Pack approvals have nowhere to be saved.' };
    if (approvalsLoadError) return { ok: false, error: `Approvals were not saved because ${approvalsLoadError}` };
    const persisted: PacksState = { approvedFingerprints: [...new Set([...approvedFingerprints, fingerprint])] };
    try {
      await writeTextAtomic(statePath, `${JSON.stringify(persisted, null, 2)}\n`, { mkdir: true });
    } catch (error) {
      return { ok: false, error: `Could not save the approval to ${statePath}: ${errorMessage(error)}` };
    }
    approvedFingerprints = new Set(persisted.approvedFingerprints);
    return { ok: true };
  }

  async function approveNow(fingerprint: string): Promise<PackApproveResult> {
    await refresh();
    const isPending = rows().some((row) => row.state === 'pending' && row.fingerprint === fingerprint);
    if (!isPending) return { ok: false, error: 'That pack changed or is already approved; check the list again.' };
    const saved = await persistApproval(fingerprint);
    if (saved.ok && !isStopped) emitter.emit('changed');
    return saved;
  }

  function approve(fingerprint: string): Promise<PackApproveResult> {
    const approval = approvalWrites.then(() => approveNow(fingerprint));
    approvalWrites = approval.catch(() => undefined);
    return approval;
  }

  async function start(): Promise<void> {
    await loadApprovals();
    watchHomePacks();
    await rescanHomePacks();
  }

  function stop(): void {
    isStopped = true;
    homeWatcher?.close();
    for (const watcher of listedWatchersByDir.values()) watcher?.close();
    for (const timer of reloadTimersByDir.values()) clearTimeout(timer);
    listedWatchersByDir.clear();
    reloadTimersByDir.clear();
    emitter.removeAllListeners();
  }

  function panelPackDir(packName: string): string | null {
    const entry = packEntriesInUse().find(({ pack }) => pack.header.name === packName && pack.ui?.ok === true && pack.ui.value.panels.length > 0);
    return entry?.packDir ?? null;
  }

  function exampleRows(): PacksStatus['examples'] {
    const reads = currentReads();
    const addedNames = new Set(reads.flatMap(({ read }) => (read.ok ? [read.pack.header.name] : [])));
    const addedDirs = new Set(reads.map(({ packDir }) => packDir));
    return examplePacks.map((example) => ({ name: example.name, description: example.description, isAdded: addedNames.has(example.name) || addedDirs.has(example.dir) }));
  }

  async function addExample(name: string): Promise<PackApproveResult> {
    const example = examplePacks.find((candidate) => candidate.name === name);
    if (!example) return { ok: false, error: `This install ships no example pack named ${name}.` };
    if (exampleRows().some((row) => row.name === name && row.isAdded)) return { ok: false, error: `A pack named ${name} is already installed.` };
    if (appendListedPath === null) return { ok: false, error: 'Packs cannot be added from here.' };
    const appended = await appendListedPath(`${EXAMPLE_PACK_REFERENCE_PREFIX}${example.name}`);
    if (!appended.ok) return appended;
    setListedPaths(appended.listedPaths);
    return { ok: true };
  }

  function declaredSecrets(): { name: string; packs: string[] }[] {
    return declaredPackSecretsOf(currentReads().flatMap(({ read }) => (read.ok && approvedFingerprints.has(read.pack.fingerprint) ? [read.pack] : [])));
  }

  async function mcpServersForSession(agentId: string, cwd: string): Promise<PackMcpServer[]> {
    const packs = packsInUse();
    if (packs.every((pack) => packMcpServers(pack).length === 0)) return [];
    const codexNames = agentId === 'codex' ? await readCodexOperatorServerNames(env, cwd) : operatorMcpServerNames.codex;
    return packMcpServersForAgent(agentId, packs, { ...operatorMcpServerNames, codex: codexNames });
  }

  function sharedMcpServers(agentId: string): PackMcpServer[] {
    return packMcpServersForAgent(agentId, packsInUse(), operatorMcpServerNames);
  }

  return Object.assign(emitter, { start, stop, mcpServersForSession, sharedMcpServers, addExample, declaredSecrets, setListedPaths, statusFrame, servableFile, approvedPacks, approve, panelPackDir, isApproved: (fingerprint: string) => approvedFingerprints.has(fingerprint) });
}
