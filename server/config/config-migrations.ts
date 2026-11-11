import path from 'node:path';
import { BranchGcFileSettings, configIssueMessage } from '../../shared/contracts/index.ts';
import { isRecord } from '../../shared/coerce.ts';
import type { GlimmervoidConfig } from './config-types.ts';
import { DEFAULT_CONFIG } from './config-defaults.ts';
import type { DefaultConfig } from './config-defaults.ts';

type BranchGcBlock = DefaultConfig['branchGc'];

function collectBranchGcIssues(branchGc: unknown): { block: BranchGcBlock; issues: string[] } {
  if (!isRecord(branchGc)) return { block: { ...DEFAULT_CONFIG.branchGc }, issues: [] };
  const accepted: Record<string, unknown> = {};
  const issues: string[] = [];
  for (const [field, value] of Object.entries(branchGc)) {
    if (!Object.hasOwn(BranchGcFileSettings.shape, field)) {
      issues.push(`[config] Ignoring unknown branchGc.${field}; it is not a branchGc setting, so the default block applies.`);
      continue;
    }
    const parsed = BranchGcFileSettings.safeParse({ [field]: value });
    if (!parsed.success) {
      issues.push(`[config] Ignoring invalid branchGc.${field}; using the default instead: ${configIssueMessage(parsed.error)}`);
      continue;
    }
    accepted[field] = value;
  }
  return { block: { ...DEFAULT_CONFIG.branchGc, ...accepted }, issues };
}

function resolveBranchGc(branchGc: unknown): BranchGcBlock {
  return collectBranchGcIssues(branchGc).block;
}

function resolveBranchGcAndWarn(branchGc: unknown): BranchGcBlock {
  const resolved = collectBranchGcIssues(branchGc);
  for (const issue of resolved.issues) console.warn(issue);
  return resolved.block;
}

const RETIRED_PROJECT_FLAGS = Object.freeze(['unconfined', 'unguarded']);

function retiredGuardrailKeysWarning(config: GlimmervoidConfig): string | null {
  const projects: unknown[] = Array.isArray(config.projects) ? config.projects : [];
  const guardrails = config.guardrails;
  const retiredKeys = [
    ...(Object.hasOwn(config, 'sandbox') ? ['sandbox'] : []),
    ...(isRecord(guardrails) ? Object.keys(guardrails).filter((key) => key !== 'unreadablePaths').map((key) => `guardrails.${key}`) : []),
    ...RETIRED_PROJECT_FLAGS.filter((key) => projects.some((project) => isRecord(project) && Object.hasOwn(project, key))).map((key) => `projects[].${key}`),
  ];
  if (retiredKeys.length === 0) return null;
  return `[sane-yolo] config.json still has ${retiredKeys.join(', ')}; these keys are ignored (unreadablePaths moved to saneYoloUnreadablePaths)`;
}

function isAbsoluteOrHomePath(entry: unknown): entry is string {
  if (typeof entry !== 'string') return false;
  const trimmedEntry = entry.trim();
  return trimmedEntry === '~' || trimmedEntry.startsWith('~/') || path.isAbsolute(trimmedEntry);
}

function migrateGuardrailsUnreadablePaths(config: GlimmervoidConfig): string | null {
  const guardrails = config.guardrails;
  if (!isRecord(guardrails) || !Object.hasOwn(guardrails, 'unreadablePaths')) return null;
  const { unreadablePaths: legacyUnreadablePaths, ...remainingGuardrails } = guardrails;
  config.guardrails = remainingGuardrails;
  if (config.saneYoloUnreadablePaths !== undefined) return '[config] Dropped guardrails.unreadablePaths: saneYoloUnreadablePaths is already set and takes its place.';
  const legacyEntries: unknown[] = Array.isArray(legacyUnreadablePaths) ? legacyUnreadablePaths : [];
  config.saneYoloUnreadablePaths = legacyEntries.filter(isAbsoluteOrHomePath);
  return '[config] Moved guardrails.unreadablePaths to saneYoloUnreadablePaths: Sane YOLO now refuses reads of those folders.';
}

function dropRetiredUpdateChannel(config: GlimmervoidConfig): string | null {
  if (!Object.hasOwn(config, 'updateChannel')) return null;
  delete config.updateChannel;
  return '[config] Removed updateChannel: Glimmervoid now updates only to published releases.';
}

function dropRetiredBenchmarks(config: GlimmervoidConfig): string | null {
  if (!Object.hasOwn(config, 'benchmarks')) return null;
  delete config.benchmarks;
  return '[config] Removed benchmarks: Benchmarks folded into Arena, which races on review cases with no setting.';
}

interface KeyMove {
  from: string;
  to: string;
}

interface KeyMoveOutcome {
  movedKeys: KeyMove[];
  droppedKeys: KeyMove[];
}

function moveKeysIntoBlock(source: Record<string, unknown>, block: Record<string, unknown>, moves: readonly KeyMove[]): KeyMoveOutcome {
  const outcome: KeyMoveOutcome = { movedKeys: [], droppedKeys: [] };
  for (const move of moves) {
    if (!Object.hasOwn(source, move.from)) continue;
    const movedValue = source[move.from];
    delete source[move.from];
    if (block[move.to] !== undefined) {
      outcome.droppedKeys.push(move);
      continue;
    }
    block[move.to] = movedValue;
    outcome.movedKeys.push(move);
  }
  return outcome;
}

function keyMoveMessage(outcome: KeyMoveOutcome, describeKey: (move: KeyMove) => { from: string; to: string }): string | null {
  const moved = outcome.movedKeys.map(describeKey).map((path) => `${path.from} to ${path.to}`);
  const dropped = outcome.droppedKeys.map(describeKey).map((path) => `${path.from} (${path.to} is already set and takes its place)`);
  const parts = [moved.length > 0 ? `Moved ${moved.join(', ')}` : '', dropped.length > 0 ? `Dropped ${dropped.join(', ')}` : ''].filter((part) => part !== '');
  if (parts.length === 0) return null;
  return `[config] ${parts.join('. ')}.`;
}

function blockOf(config: Record<string, unknown>, blockName: string): Record<string, unknown> {
  const existingBlock = config[blockName];
  if (isRecord(existingBlock)) return existingBlock;
  const createdBlock: Record<string, unknown> = {};
  config[blockName] = createdBlock;
  return createdBlock;
}

function moveWatcherUrlToRemote(config: Record<string, unknown>): string | null {
  if (!Object.hasOwn(config, 'watcher')) return null;
  const watcher = config.watcher;
  delete config.watcher;
  if (!isRecord(watcher) || !Object.hasOwn(watcher, 'url')) return '[config] Removed the empty watcher block: a doorman on another machine is now remote.doormanUrl.';
  const outcome = moveKeysIntoBlock(watcher, blockOf(config, 'remote'), [{ from: 'url', to: 'doormanUrl' }]);
  return keyMoveMessage(outcome, (move) => ({ from: `watcher.${move.from}`, to: `remote.${move.to}` }));
}

const WORKTREE_KEY_MOVES: readonly KeyMove[] = Object.freeze([
  { from: 'worktreeRoot', to: 'root' },
  { from: 'worktreeShare', to: 'share' },
  { from: 'integrationBranch', to: 'integrationBranch' },
  { from: 'worktreeAutoRebase', to: 'autoRebase' },
  { from: 'worktreeSyncOnStart', to: 'syncOnStart' },
  { from: 'worktreeCloneDependencies', to: 'cloneDependencies' },
  { from: 'worktreeRerere', to: 'rerere' },
]);

function nestWorktreeKeys(config: Record<string, unknown>): string | null {
  if (!WORKTREE_KEY_MOVES.some((move) => Object.hasOwn(config, move.from))) return null;
  const outcome = moveKeysIntoBlock(config, blockOf(config, 'worktree'), WORKTREE_KEY_MOVES);
  return keyMoveMessage(outcome, (move) => ({ from: move.from, to: `worktree.${move.to}` }));
}

function moveRenamedKeys(config: Record<string, unknown>): string[] {
  return [moveWatcherUrlToRemote(config), nestWorktreeKeys(config)].filter((message) => message !== null);
}

function migrateRemoteEnabled(config: GlimmervoidConfig): string | null {
  const remote = config.remote;
  if (!isRecord(remote) || !Object.hasOwn(remote, 'enabled')) return null;
  const { enabled: wasEnabled, port: configuredPort, ...remainingRemote } = remote;
  if (wasEnabled !== true) {
    config.remote = remainingRemote;
    return '[config] Dropped remote.enabled and remote.port: the remote listener is always on, behind pairing, on a port the system picks.';
  }
  config.remote = configuredPort === undefined ? remainingRemote : { ...remainingRemote, port: configuredPort };
  return '[config] Dropped remote.enabled: the remote listener is always on, behind pairing.';
}

export { dropRetiredBenchmarks, dropRetiredUpdateChannel, resolveBranchGc, resolveBranchGcAndWarn, retiredGuardrailKeysWarning, migrateGuardrailsUnreadablePaths, migrateRemoteEnabled, moveRenamedKeys };
