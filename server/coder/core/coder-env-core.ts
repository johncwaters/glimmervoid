import path from 'node:path';
import { z } from 'zod';
import { STATES } from '../../../shared/states.ts';
import type { SessionState } from '../../../shared/states.ts';

const CODER_ENV_READY_POLL_MS = 3_000;
const CODER_ENV_READY_CEILING_MS = 960_000;
const CODER_ENV_IDLE_TICK_MS = 60_000;
const GLIMMERVOID_WORKSPACE_RE = /^gv-[0-9a-f]{12}$/;
const IDLE_STOP_STATES: ReadonlySet<SessionState> = new Set([STATES.IDLE, STATES.COMPLETE, STATES.DORMANT]);

const CODER_ENVIRONMENT_DEFAULTS: Readonly<{ idleStopMinutes: number; stopAfter: string; maxLive: number; deleteAfterStoppedDays: number }> = Object.freeze({
  idleStopMinutes: 30,
  stopAfter: '4h',
  maxLive: 2,
  deleteAfterStoppedDays: 3,
});

interface CoderEnvironmentSettings {
  name: string;
  template: string;
  parameters?: Record<string, string>;
  nodePath: string;
  checkoutRoot: string;
  readyUrl?: string;
  idleStopMinutes?: number;
  stopAfter?: string;
  maxLive?: number;
  deleteAfterStoppedDays?: number;
  hourlyCostUsd?: number;
}

type ResolvedCoderEnvironment = CoderEnvironmentSettings & { idleStopMinutes: number; stopAfter: string; maxLive: number; deleteAfterStoppedDays: number };

const CoderWorkspaceListing = z.array(z.object({
  name: z.string(),
  latest_build: z.object({
    status: z.string(),
    transition: z.string(),
    updated_at: z.string().optional(),
    resources: z.array(z.object({
      agents: z.array(z.object({ lifecycle_state: z.string() }).loose()).optional(),
    }).loose()).optional(),
  }).loose(),
}).loose());

type CoderWorkspaceStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'failed' | 'deleting' | 'other';

interface CoderWorkspace {
  name: string;
  status: CoderWorkspaceStatus;
  areAgentsReady: boolean;
  stoppedAtMs: number | null;
}

interface WorkspaceMapping {
  projectId: string;
  workspace: string;
  wasActive: boolean;
}

interface ReconcilePlan {
  resume: WorkspaceMapping[];
  stop: WorkspaceMapping[];
  delete: string[];
  keptUnmapped: string[];
}

type ReadinessVerdict = { kind: 'ready' } | { kind: 'waiting' } | { kind: 'failed'; reason: string };

const DAY_MS = 86_400_000;

const KNOWN_STATUSES: ReadonlySet<string> = new Set(['running', 'stopped', 'starting', 'stopping', 'failed', 'deleting']);

function resolveCoderEnvironment(environment: CoderEnvironmentSettings): ResolvedCoderEnvironment {
  return {
    ...environment,
    idleStopMinutes: environment.idleStopMinutes ?? CODER_ENVIRONMENT_DEFAULTS.idleStopMinutes,
    stopAfter: environment.stopAfter ?? CODER_ENVIRONMENT_DEFAULTS.stopAfter,
    maxLive: environment.maxLive ?? CODER_ENVIRONMENT_DEFAULTS.maxLive,
    deleteAfterStoppedDays: environment.deleteAfterStoppedDays ?? CODER_ENVIRONMENT_DEFAULTS.deleteAfterStoppedDays,
  };
}

function normalizeStatus(status: string): CoderWorkspaceStatus {
  return KNOWN_STATUSES.has(status) ? (status as CoderWorkspaceStatus) : 'other';
}

function stoppedAtMs(status: CoderWorkspaceStatus, updatedAt: string | undefined): number | null {
  if (status !== 'stopped' || updatedAt === undefined) return null;
  const parsedMs = Date.parse(updatedAt);
  return Number.isNaN(parsedMs) ? null : parsedMs;
}

function parseGlimmervoidWorkspaces(listingJson: string): CoderWorkspace[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(listingJson);
  } catch {
    return null;
  }
  const parsed = CoderWorkspaceListing.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data
    .filter((workspace) => GLIMMERVOID_WORKSPACE_RE.test(workspace.name))
    .map((workspace) => {
      const agents = (workspace.latest_build.resources ?? []).flatMap((resource) => resource.agents ?? []);
      const status = normalizeStatus(workspace.latest_build.status);
      return {
        name: workspace.name,
        status,
        areAgentsReady: agents.length > 0 && agents.every((agent) => agent.lifecycle_state === 'ready'),
        stoppedAtMs: stoppedAtMs(status, workspace.latest_build.updated_at),
      };
    });
}

function decideReadiness({ workspace, elapsedMs, isReadyUrlUp }: {
  workspace: CoderWorkspace | undefined;
  elapsedMs: number;
  isReadyUrlUp: boolean | null;
}): ReadinessVerdict {
  if (workspace?.status === 'failed') return { kind: 'failed', reason: `Coder workspace ${workspace.name} failed to build` };
  const isAgentReady = workspace?.status === 'running' && workspace.areAgentsReady;
  if (isAgentReady && isReadyUrlUp !== false) return { kind: 'ready' };
  if (elapsedMs < CODER_ENV_READY_CEILING_MS) return { kind: 'waiting' };
  const waitedSeconds = Math.round(CODER_ENV_READY_CEILING_MS / 1000);
  if (isAgentReady) return { kind: 'failed', reason: `readyUrl did not answer within ${waitedSeconds} s` };
  return { kind: 'failed', reason: `Coder workspace was not ready within ${waitedSeconds} s` };
}

function shouldIdleStop({ sessionState, idleSinceMs, nowMs, idleStopMinutes }: {
  sessionState: SessionState;
  idleSinceMs: number | null;
  nowMs: number;
  idleStopMinutes: number;
}): boolean {
  if (!IDLE_STOP_STATES.has(sessionState) || idleSinceMs === null) return false;
  return nowMs - idleSinceMs >= idleStopMinutes * 60_000;
}

function planReconcile({ workspaces, mappings, busyWorkspaces, nowMs, deleteAfterStoppedDays }: {
  workspaces: readonly CoderWorkspace[];
  mappings: readonly WorkspaceMapping[];
  busyWorkspaces: ReadonlySet<string>;
  nowMs: number;
  deleteAfterStoppedDays: number;
}): ReconcilePlan {
  const mappedNames = new Set(mappings.map((mapping) => mapping.workspace));
  const listedNames = new Set(workspaces.map((workspace) => workspace.name));
  const idleMappings = mappings.filter((mapping) => !busyWorkspaces.has(mapping.workspace));
  const presentMappings = idleMappings.filter((mapping) => listedNames.has(mapping.workspace));
  const unmapped = workspaces.filter((workspace) => !mappedNames.has(workspace.name) && !busyWorkspaces.has(workspace.name) && workspace.status !== 'deleting');
  const isStale = (workspace: CoderWorkspace) => workspace.stoppedAtMs !== null && nowMs - workspace.stoppedAtMs >= deleteAfterStoppedDays * DAY_MS;
  return {
    resume: presentMappings.filter((mapping) => mapping.wasActive),
    stop: presentMappings.filter((mapping) => !mapping.wasActive),
    delete: unmapped.filter(isStale).map((workspace) => workspace.name),
    keptUnmapped: unmapped.filter((workspace) => !isStale(workspace)).map((workspace) => workspace.name),
  };
}

function failedProvisionCleanup({ didCreate, didStart }: { didCreate: boolean; didStart: boolean }): 'delete' | 'stop' | null {
  if (didCreate) return 'delete';
  if (didStart) return 'stop';
  return null;
}

function sharingRefusal(sharingStatusOutput: string): string | null {
  const sharedWith = sharingStatusOutput.split('\n').map((line) => line.trim()).filter(Boolean);
  if (sharedWith.length === 0) return null;
  return 'Coder workspace is shared with other users or groups; Glimmervoid refuses to launch an agent in it';
}

function liveLimitRefusal({ liveCount, maxLive, environmentName }: { liveCount: number; maxLive: number; environmentName: string }): string | null {
  if (liveCount < maxLive) return null;
  return `${environmentName} already has ${liveCount} of ${maxLive} live workspaces; close one first`;
}

const CODER_ERROR_DETAIL_LIMIT = 200;

function remoteCheckoutDirectory({ checkoutRoot, workspace }: { checkoutRoot: string; workspace: string }): string {
  return path.posix.join(checkoutRoot, workspace);
}

function coderErrorDetail(stderr: unknown): string | null {
  if (typeof stderr !== 'string') return null;
  const errorLine = stderr.split('\n').map((line) => line.trim()).findLast((line) => line.startsWith('error:'));
  if (!errorLine) return null;
  return errorLine.slice('error:'.length).trim().slice(0, CODER_ERROR_DETAIL_LIMIT) || null;
}

export {
  coderErrorDetail, remoteCheckoutDirectory, CODER_ENV_READY_POLL_MS, CODER_ENV_IDLE_TICK_MS, resolveCoderEnvironment, parseGlimmervoidWorkspaces, decideReadiness, shouldIdleStop, planReconcile,
  failedProvisionCleanup, sharingRefusal, liveLimitRefusal,
};
export type { CoderEnvironmentSettings, CoderWorkspace, ReadinessVerdict, ReconcilePlan, ResolvedCoderEnvironment, WorkspaceMapping };
