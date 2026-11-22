import { DEFAULT_INTERVAL_MS, DEFAULT_STALE_DAYS, createBranchGcPoller } from './branch-gc-poller.ts';
import { bootStaggerDelay } from './boot-stagger.ts';
import { DEFAULT_BRANCH_GC_PREFIXES } from './core/branch-gc-core.ts';
import type { BranchGcGitWorkspace, BranchGcPoller } from './branch-gc-poller.ts';
import { createLaneRunner } from './lanes/lane-runner.ts';
import type { LaneRunnerGate } from './lanes/lane-runner.ts';
import { emptyLaneStatus } from './lanes/lane-status.ts';
import type { BranchGcFileSettings } from '../shared/contracts/index.ts';

interface BranchGcWiringConfig {
  integrationBranch?: string | null;
  worktreeRoot?: string;
  projects?: { id?: string; path?: string }[];
  branchGc?: BranchGcFileSettings | null;
}

interface BranchGcWiringOptions {
  config: BranchGcWiringConfig;
  gitWorkspace: BranchGcGitWorkspace;
  liveSessionIds: () => Set<string>;
  liveWorktreePaths: () => Set<string> | Promise<Set<string>>;
  log?: Console;
  decisionTrace?: (entry: Record<string, unknown>) => void;
  createPoller?: typeof createBranchGcPoller;
}

interface BranchGcWiring {
  start(): void;
  stop(): Promise<void>;
  restartIfConfigChanged(): void;
}

function branchGcShouldStart(): LaneRunnerGate {
  return { start: true };
}

function branchGcCfgKey(config: BranchGcWiringConfig): string {
  return JSON.stringify(config.branchGc ?? null);
}

function createBranchGcWiring({
  config,
  gitWorkspace,
  liveSessionIds,
  liveWorktreePaths,
  log = console,
  decisionTrace = (entry: Record<string, unknown>) => log.info(`[branch-gc] decision ${JSON.stringify(entry)}`),
  createPoller = createBranchGcPoller,
}: BranchGcWiringOptions): BranchGcWiring {
  const runner = createLaneRunner<BranchGcPoller>({
    tag: 'branch-gc',
    gate: branchGcShouldStart,
    cfgKey: () => branchGcCfgKey(config),
    emptyStatus: () => emptyLaneStatus('branch-gc-status', branchGcShouldStart()),
    createPoller: ({ onTickComplete }) => createPoller({
      gitWorkspace,
      getConfig: () => config,
      liveSessionIds,
      liveWorktreePaths,
      staleDays: DEFAULT_STALE_DAYS,
      deleteUnmerged: config.branchGc?.deleteUnmerged === true,
      prefixes: config.branchGc?.prefixes ?? DEFAULT_BRANCH_GC_PREFIXES,
      pruneWorktrees: true,
      dryRun: config.branchGc?.dryRun ?? false,
      intervalMs: DEFAULT_INTERVAL_MS,
      firstTickDelayMs: bootStaggerDelay,
      log,
      decisionTrace,
      onTickComplete,
    }),
  });

  return {
    start: runner.startPoller,
    stop: runner.stopPoller,
    restartIfConfigChanged: runner.restartIfConfigChanged,
  };
}

export { createBranchGcWiring };
