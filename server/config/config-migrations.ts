import path from 'node:path';
import { BranchGcFileSettings, configIssueMessage } from '../../shared/contracts/index.ts';
import { repoParts } from '../../shared/contracts/github-ids.ts';
import { isRecord } from '../../shared/coerce.ts';
import { vaultManagerOf } from '../../shared/contracts/secrets.ts';
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

function dropRetiredHintCards(config: GlimmervoidConfig): string | null {
  if (!Object.hasOwn(config, 'hintCards')) return null;
  delete config.hintCards;
  return '[config] Removed hintCards: hint cards folded into Usage, Your day.';
}

function dropRetiredPlanReview(config: GlimmervoidConfig): string | null {
  if (!Object.hasOwn(config, 'planReview')) return null;
  delete config.planReview;
  return '[config] Removed planReview: the plan view is gone and plans go through boards.';
}

function dropRetiredCoherence(config: GlimmervoidConfig): string | null {
  if (!Object.hasOwn(config, 'coherence')) return null;
  delete config.coherence;
  return '[config] Removed coherence: Glimmervoid no longer runs Coherence in sessions.';
}

function dropRetiredIssues(config: GlimmervoidConfig): string | null {
  if (!Object.hasOwn(config, 'issues')) return null;
  delete config.issues;
  return '[config] Removed issues: the Issues tab is gone.';
}

function dropRetiredHosts(config: GlimmervoidConfig): string | null {
  if (!Object.hasOwn(config, 'hosts')) return null;
  delete config.hosts;
  return '[config] Removed hosts: linked hosts are gone; sessions on those machines keep running there.';
}

function dropRetiredCoderSessions(config: GlimmervoidConfig): string | null {
  const projects = Array.isArray(config.projects) ? config.projects : [];
  const keptProjects = projects.filter((project) => !Object.hasOwn(project, 'environment'));
  const droppedProjectCount = projects.length - keptProjects.length;
  const droppedKeys = ['coder', 'remoteSessions'].filter((key) => Object.hasOwn(config, key));
  if (droppedProjectCount === 0 && droppedKeys.length === 0) return null;
  for (const key of droppedKeys) Reflect.deleteProperty(config, key);
  if (droppedProjectCount > 0) config.projects = keptProjects;
  const removed = [...droppedKeys, ...(droppedProjectCount > 0 ? [`${droppedProjectCount} Coder workspace session${droppedProjectCount === 1 ? '' : 's'}`] : [])];
  return `[config] Removed ${removed.join(', ')}: remote Coder sessions are gone; delete leftover gv-* workspaces with coder delete.`;
}

function isRetiredSecretReference(entry: unknown): boolean {
  return isRecord(entry) && Object.hasOwn(entry, 'reference');
}

function dropRetiredSecretReferences(config: GlimmervoidConfig): string | null {
  const byProject = isRecord(config.secrets) ? config.secrets.byProject : null;
  if (!isRecord(byProject)) return null;
  let droppedCount = 0;
  for (const [project, entries] of Object.entries(byProject)) {
    if (!isRecord(entries)) continue;
    const keptEntries = Object.fromEntries(Object.entries(entries).filter(([, entry]) => !isRetiredSecretReference(entry)));
    droppedCount += Object.keys(entries).length - Object.keys(keptEntries).length;
    if (Object.keys(keptEntries).length === 0) delete byProject[project];
    if (Object.keys(keptEntries).length > 0) byProject[project] = keptEntries;
  }
  if (droppedCount === 0) return null;
  return `[config] Removed ${droppedCount} saved secret approval${droppedCount === 1 ? '' : 's'} that named a vault item: secrets now read from the vault set in Settings > Vault, so each name asks again once.`;
}


function retiredVaultCompanionMessage(vault: Record<string, unknown>): string | null {
  const droppedKeys = (['host', 'port', 'token'] as const).filter((key) => Object.hasOwn(vault, key));
  if (droppedKeys.length === 0) return null;
  for (const key of droppedKeys) delete vault[key];
  return `[config] Removed ${droppedKeys.map((key) => `vault.${key}`).join(', ')}: the 1Password vault companion is gone, and secrets read from the vault set in Settings > Vault.`;
}

function explicitVaultManagerMessage(vault: Record<string, unknown>): string | null {
  const managerFromLookIn = vaultManagerOf({ lookIn: vault.lookIn });
  const isOnePasswordWithoutVault = vault.manager === '1password' && managerFromLookIn === 'age';
  if (vault.manager !== undefined && !isOnePasswordWithoutVault) return null;
  vault.manager = managerFromLookIn;
  if (managerFromLookIn === '1password') return '[config] Set vault.manager to 1password: the age file is now the default source, and your 1Password vault stays in use.';
  return '[config] Secrets now read from the age file on this machine: no 1Password vault was set. Change it under Settings > Vault.';
}

function migrateVaultSettings(config: GlimmervoidConfig): string | null {
  const vault: unknown = config.vault;
  if (!isRecord(vault)) return null;
  const messages = [retiredVaultCompanionMessage(vault), explicitVaultManagerMessage(vault)].filter((message) => message !== null);
  return messages.length === 0 ? null : messages.join('\n');
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
]);

const RETIRED_SETTING_PATHS: readonly string[] = Object.freeze([
  'detectBackgroundAgents',
  'recordSignals',
  'trace',
  'detectScheduledWakeups',
  'worktree.autoRebase',
  'worktree.syncOnStart',
  'worktree.cloneDependencies',
  'worktree.rerere',
  'worktreeAutoRebase',
  'worktreeSyncOnStart',
  'worktreeCloneDependencies',
  'worktreeRerere',
  'telegramNotifications',
  'slack.enabled',
  'teamReview.keepMergeableEnabled',
  'teamReview.mergeQueueEnabled',
  'teamReview.keepMergeableTimeoutMinutes',
  'usage.yourDay',
  'posthog.intervalMinutes',
  'posthog.investigationTimeoutSeconds',
  'posthog.fixTimeoutSeconds',
  'posthog.userEscalationThreshold',
  'posthog.trafficSpikeMultiplier',
  'posthog.trafficSpikeMinUsers',
  'posthog.trafficSpikeCooldownMinutes',
  'posthog.trafficSpikeBaselineDays',
  'posthog.recurrenceDedupe',
  'posthog.recurrenceWindowDays',
  'posthog.transientRecurrenceLimit',
  'community.intervalMinutes',
  'usage.vendors',
  'usage.scanIntervalMinutes',
  'usage.warehouseRetainDays',
  'usage.sessionBlockHours',
  'usage.fetchPricing',
  'usage.planLimits',
  'usage.costMode',
  'notifyDebounceMs',
  'phoneEscalationMs',
  'branchGc.enabled',
  'branchGc.worktrees',
  'branchGc.staleDays',
  'branchGc.intervalMs',
  'taskTitle.refiner.model',
  'taskTitle.refiner.minIntervalSeconds',
  'taskTitle.refiner.timeoutSeconds',
  'questionManager.model',
  'replayBufferKB',
  'cursorBlink',
  'teamReview.team',
  'workflows.maxActionsPerPoll',
]);

function deleteRetiredPath(root: Record<string, unknown>, dottedPath: string): boolean {
  const segments = dottedPath.split('.');
  const parents: { container: Record<string, unknown>; key: string }[] = [];
  let cursor: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!isRecord(next)) return false;
    parents.push({ container: cursor, key: segment });
    cursor = next;
  }
  const leaf = segments[segments.length - 1];
  if (!Object.hasOwn(cursor, leaf)) return false;
  delete cursor[leaf];
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const { container, key } = parents[index];
    const child = container[key];
    if (!isRecord(child) || Object.keys(child).length > 0) break;
    delete container[key];
  }
  return true;
}

function dropRetiredSettings(config: Record<string, unknown>): string | null {
  const dropped = RETIRED_SETTING_PATHS.filter((settingPath) => deleteRetiredPath(config, settingPath));
  if (dropped.length === 0) return null;
  return `[config] Removed ${dropped.join(', ')}: Glimmervoid now owns these behaviors.`;
}

function nestWorktreeKeys(config: Record<string, unknown>): string | null {
  if (!WORKTREE_KEY_MOVES.some((move) => Object.hasOwn(config, move.from))) return null;
  const outcome = moveKeysIntoBlock(config, blockOf(config, 'worktree'), WORKTREE_KEY_MOVES);
  return keyMoveMessage(outcome, (move) => ({ from: move.from, to: `worktree.${move.to}` }));
}

function moveLegacyTeamReviewTeam(config: Record<string, unknown>): string | null {
  const teamReview = config.teamReview;
  if (!isRecord(teamReview) || !Object.hasOwn(teamReview, 'team')) return null;
  const legacyTeam = typeof teamReview.team === 'string' ? teamReview.team.trim() : '';
  const legacyOrg = typeof teamReview.org === 'string' ? teamReview.org.trim() : '';
  delete teamReview.team;
  if (Object.keys(teamReview).length === 0) delete config.teamReview;
  const github = config.github;
  const existingTeams = isRecord(github) && Array.isArray(github.teams) ? github.teams : [];
  if (existingTeams.length > 0) return '[config] Dropped teamReview.team (github.teams is already set and takes its place).';
  if (!legacyOrg || !legacyTeam) return '[config] Removed teamReview.team: github.teams takes its place.';
  const teamEntry = `${legacyOrg}/${legacyTeam}`;
  if (repoParts(teamEntry) === null) return '[config] Removed invalid teamReview.team: set github.teams as org/team-slug instead.';
  blockOf(config, 'github').teams = [teamEntry];
  return `[config] Moved teamReview.team to github.teams (${teamEntry}).`;
}

function moveRenamedKeys(config: Record<string, unknown>): string[] {
  return [moveWatcherUrlToRemote(config), nestWorktreeKeys(config), moveLegacyTeamReviewTeam(config)].filter((message) => message !== null);
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

const LEGACY_CODEMAP_CHECK = { id: 'codemap', commandPrefix: 'glimmervoid codemap check ' };

function isLegacyCodemapCheck(check: unknown): boolean {
  return isRecord(check) && check.id === LEGACY_CODEMAP_CHECK.id && typeof check.command === 'string' && check.command.startsWith(LEGACY_CODEMAP_CHECK.commandPrefix);
}

function withoutLegacyCodemapCheck(entry: Record<string, unknown>): Record<string, unknown> | null {
  const checks = Array.isArray(entry.checks) ? entry.checks.filter((check) => !isLegacyCodemapCheck(check)) : [];
  if (checks.length === 0) return null;
  if (!isRecord(entry.gate) || !Array.isArray(entry.gate.required)) return { ...entry, checks };
  const required = entry.gate.required.filter((checkId) => checkId !== LEGACY_CODEMAP_CHECK.id);
  return { ...entry, checks, gate: { ...entry.gate, enabled: entry.gate.enabled === true && required.length > 0, required } };
}

function dropLegacyCodemapChecks(config: GlimmervoidConfig): string | null {
  const verification = config.verification;
  if (!isRecord(verification) || !isRecord(verification.repos)) return null;
  const legacyRepoKeys = Object.keys(verification.repos).filter((repoKey) => {
    const entry = isRecord(verification.repos) ? verification.repos[repoKey] : null;
    return isRecord(entry) && Array.isArray(entry.checks) && entry.checks.some(isLegacyCodemapCheck);
  });
  if (legacyRepoKeys.length === 0) return null;
  const repos: Record<string, unknown> = { ...verification.repos };
  for (const repoKey of legacyRepoKeys) {
    const entry = repos[repoKey];
    const migrated = isRecord(entry) ? withoutLegacyCodemapCheck(entry) : null;
    if (migrated) repos[repoKey] = migrated;
    if (!migrated) delete repos[repoKey];
  }
  config.verification = { ...verification, repos };
  return `[config] Dropped the codemap check from verification.repos for ${legacyRepoKeys.join(', ')}: the import gate is now built in and follows the code map setup.`;
}

export { dropLegacyCodemapChecks, dropRetiredBenchmarks, dropRetiredCoderSessions, dropRetiredCoherence, dropRetiredHintCards, dropRetiredHosts, dropRetiredIssues, dropRetiredSecretReferences, dropRetiredSettings, migrateVaultSettings, dropRetiredPlanReview, dropRetiredUpdateChannel, resolveBranchGc, resolveBranchGcAndWarn, retiredGuardrailKeysWarning, migrateGuardrailsUnreadablePaths, migrateRemoteEnabled, moveRenamedKeys };
