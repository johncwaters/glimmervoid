import { DEFAULT_BRANCH_GC_PREFIXES } from '../core/branch-gc-core.ts';
import type { CustomAgentDeclaration } from '../../shared/contracts/index.ts';
import { DEFAULT_WORKFLOW_MAX_ACTIONS_PER_POLL, DEFAULT_WORKFLOW_MAX_CONCURRENT_SESSIONS } from '../../shared/contracts/workflows.ts';
import type { WorkflowRule } from '../../shared/contracts/workflows.ts';
import { DEFAULT_SESSION_MEMORY_RESERVE_MB } from '../core/memory-admission-core.ts';
import type { ProjectEntry, GlimmervoidConfig } from './config-types.ts';
import { DEFAULT_MODELS } from '../../shared/contracts/agent-models.ts';

const DEFAULT_CONFIG = {
  port: 3000,
  notifyDebounceMs: 3000,

  phoneEscalationMs: 300000,
  cursorBlink: false,
  debugMode: false,
  streamerMode: false,
  viewTabOrder: [] as string[],
  remoteSessions: false,
  hintCards: false,

  detectBackgroundAgents: true,

  detectScheduledWakeups: true,

  replayBufferKB: 512,

  sessionMemoryReserveMB: DEFAULT_SESSION_MEMORY_RESERVE_MB,

  recordSignals: true,

  trace: {
    enabled: true,
  },

  planReview: {
    enabled: true,
  },

  taskTitle: {
    refiner: { enabled: true, model: DEFAULT_MODELS.taskTitleRefiner, minIntervalSeconds: 60, timeoutSeconds: 60 },
  },
  telemetry: {
    enabled: true,
  },

  checkForUpdates: true,
  updateChannel: 'release' as const,

  autoResume: true,

  skipPermissionsByDefault: false,

  saneYolo: true,
  saneYoloUnreadablePaths: [] as string[],

  telegramNotifications: false,

  integrationBranch: null as string | null,

  worktreeRoot: '',

  worktreeShare: ['.env*', '.claude'],

  worktreeAutoRebase: true,
  worktreeSyncOnStart: true,
  worktreeCloneDependencies: true,

  worktreeRerere: true,
  shareCommitProvenance: true,
  branchGc: {
    enabled: true,
    worktrees: true,
    prefixes: [...DEFAULT_BRANCH_GC_PREFIXES],
    dryRun: false,
    staleDays: 14,
    deleteUnmerged: false,
    intervalMs: 6 * 60 * 60 * 1000,
  },
  repoRoots: [] as string[],

  customAgents: [] as CustomAgentDeclaration[],
  packs: [] as string[],

  remote: {
    enabled: false,

    port: null as number | null,

    publicHost: '',

    allowedOrigins: [] as string[],
  },
  workflows: {
    enabled: true,
    maxConcurrentSessions: DEFAULT_WORKFLOW_MAX_CONCURRENT_SESSIONS,
    maxActionsPerPoll: DEFAULT_WORKFLOW_MAX_ACTIONS_PER_POLL,
    rules: [] as WorkflowRule[],
  },
  projects: [] as ProjectEntry[],
};

type DefaultConfig = typeof DEFAULT_CONFIG;

const DEFAULT_CONFIG_BY_KEY: GlimmervoidConfig = DEFAULT_CONFIG;

export { DEFAULT_CONFIG, DEFAULT_CONFIG_BY_KEY };
export type { DefaultConfig };
