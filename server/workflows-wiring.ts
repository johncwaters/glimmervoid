import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkflowsState } from '../shared/contracts/workflows.ts';
import type { WorkflowsState as WorkflowsStateType } from '../shared/contracts/workflows.ts';
import { bootStaggerDelay } from './boot-stagger.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import * as core from './core/workflows-core.ts';
import type { PlannedWorkflowAction } from './core/workflows-core.ts';
import { MY_PRS_FIX_CHECKOUT_DIRNAME } from './core/my-prs-core.ts';
import { prKey, readTeamReviewSettings } from './core/team-review-core.ts';
import type { TeamReviewSettingsSource } from './core/team-review-core.ts';
import { drainPending, firstLine } from './ephemeral-session.ts';
import { createJsonStateStore } from './json-file.ts';
import { createLaneRunner } from './lane-runner.ts';
import type { SharedClock } from './lane-runner.ts';
import type { createSandboxedPrStaging } from './my-prs-wiring.ts';
import { createPrGh } from './pr-gh.ts';
import { allowSandboxedSpawn } from './sandbox-deps.ts';
import type { SandboxSpawnRefusal } from './sandbox-deps.ts';
import { emptyGhConfigDir, makeTeamReviewWorkDir } from './team-review-wiring.ts';
import { createWorkflowSessionQueue, createWorkflowsPoller } from './workflows-poller.ts';
import type { SpawnSession, WorkflowsPoller, WorkflowsPollerDependencies } from './workflows-poller.ts';

type SpawnAction = PlannedWorkflowAction & { action: { type: 'spawn'; promptTemplate: string } };

export function createWorkflowsStateIo(statePath: string, log: Pick<Console, 'warn'>) {
  let loaded: WorkflowsStateType | null = null;
  const store = createJsonStateStore<WorkflowsStateType>({
    name: 'workflows state', filePath: statePath,
    parse: (raw) => {
      const parsed = WorkflowsState.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    adopt: (state) => { loaded = state; },
    warn: (message, fields) => log.warn(`[${core.WORKFLOWS_LANE_ID}] ${message} ${JSON.stringify(fields)}`),
  });
  return {
    async readState(): Promise<WorkflowsStateType | null> {
      await store.load();
      return loaded;
    },
    async writeState(state: WorkflowsStateType): Promise<void> {
      const parsed = WorkflowsState.parse(state);
      await store.write(parsed, () => `${JSON.stringify(parsed, null, 2)}\n`);
      loaded = parsed;
    },
  };
}

export function createWorkflowSpawn({ staging, workRoot, makeWorkDir = makeTeamReviewWorkDir, log = console, sandboxRefusal = allowSandboxedSpawn }: {
  staging: ReturnType<typeof createSandboxedPrStaging>;
  workRoot: string;
  sandboxRefusal?: SandboxSpawnRefusal;
  makeWorkDir?: typeof makeTeamReviewWorkDir;
  log?: Pick<Console, 'warn'>;
}) {
  return async ({ rule, action, event }: SpawnAction, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return;
    const pr = { key: prKey(event.pr.repo, event.pr.number), repo: event.pr.repo, number: event.pr.number, baseRefName: event.pr.baseRefName, headRefOid: event.pr.headRefOid };
    const warn = (message: string) => log.warn(`[${core.WORKFLOWS_LANE_ID}] ${rule.id} session for ${pr.key}: ${firstLine(message)}`);
    const sandboxRefusalReason = sandboxRefusal();
    if (sandboxRefusalReason !== null) return warn(sandboxRefusalReason);
    const workDir = await makeWorkDir(workRoot, pr.key);
    let pendingSession: Promise<unknown> | null = null;
    try {
      const staged = await staging.stageCheckout(pr, workDir.dir, signal);
      if (signal.aborted) return;
      if ('error' in staged) return warn(`not started: ${staged.error}`);
      await fs.writeFile(path.join(workDir.dir, core.WORKFLOW_PROMPT_FILENAME), core.workflowSpawnPrompt(action.promptTemplate, event, MY_PRS_FIX_CHECKOUT_DIRNAME), 'utf8');
      await fs.mkdir(emptyGhConfigDir(workDir.dir), { recursive: true });
      const outcome = await staging.runSession({
        idPrefix: core.WORKFLOWS_LANE_ID, name: core.workflowSessionName({ rule, event }), workDir: workDir.dir, cachedClone: staged.projectPath, signal,
        onPending: (pending) => { pendingSession = pending; }, initialPrompt: core.WORKFLOW_BOOTSTRAP_PROMPT,
      });
      if (outcome === 'timed-out') warn('the session ran past its deadline');
    } finally {
      await drainPending(pendingSession);
      await workDir.cleanup();
    }
  };
}

interface WorkflowsWiringOptions {
  config: TeamReviewSettingsSource & { workflows?: unknown };
  notificationManager: { trigger(sessionName: string, category: string, message: string): unknown };
  spawnSession: SpawnSession;
  log?: Pick<Console, 'warn'>;
  homeDir?: string;
  github?: WorkflowsPollerDependencies['github'];
  clock?: SharedClock;
  sweepLeftovers?: () => Promise<void>;
  createPoller?: (dependencies: WorkflowsPollerDependencies) => WorkflowsPoller;
}

export function createWorkflowsWiring({
  config, notificationManager, spawnSession, log = console, homeDir = glimmervoidHomeDir(), github = createPrGh(homeDir), clock, sweepLeftovers, createPoller = createWorkflowsPoller,
}: WorkflowsWiringOptions) {
  const stateIo = createWorkflowsStateIo(path.join(homeDir, core.WORKFLOWS_STATE_FILENAME), log);
  const settings = () => core.resolveWorkflowsSettings(config.workflows);
  const isSpawnStillAllowed = ({ rule }: SpawnAction): boolean => {
    const resolved = settings();
    return resolved.ok && resolved.enabled && core.enabledWorkflowRules(resolved.rules).some((enabledRule) => enabledRule.id === rule.id);
  };
  const sessions = createWorkflowSessionQueue({ spawnSession, log, maxConcurrentSessions: () => core.workflowSessionLimit(settings()), isSpawnStillAllowed });
  let hasSweptLeftovers = false;
  const sweepLeftoversBeforeFirstStart = async (): Promise<void> => {
    if (hasSweptLeftovers || !sweepLeftovers) return;
    hasSweptLeftovers = true;
    await sweepLeftovers();
  };
  const teamName = () => core.workflowTeamName(readTeamReviewSettings(config));
  const gate = () => core.workflowsShouldStart(settings());
  const runner = createLaneRunner<WorkflowsPoller>({
    tag: core.WORKFLOWS_LANE_ID,
    gate,
    cfgKey: () => JSON.stringify({ settings: settings(), teamName: teamName() }),
    emptyStatus: () => ({ type: 'workflows-status', ts: Date.now(), configured: gate().start, reason: gate().reason ?? null }),
    createPoller: ({ onTickComplete }) => {
      const resolved = settings();
      return createPoller({
        rules: resolved.ok ? core.enabledWorkflowRules(resolved.rules) : [],
        maxActionsPerPoll: resolved.ok ? resolved.maxActionsPerPoll : core.DEFAULT_WORKFLOW_MAX_ACTIONS_PER_POLL,
        teamName: teamName(),
        github, log, onTickComplete, clock, firstTickDelayMs: bootStaggerDelay, beforeStart: sweepLeftoversBeforeFirstStart,
        readState: stateIo.readState, writeState: stateIo.writeState,
        notify: ({ sessionName, message }) => { notificationManager.trigger(sessionName, core.WORKFLOW_NOTIFY_CATEGORY, message); },
        startSession: sessions.enqueue,
      });
    },
  });
  return {
    startPoller: runner.startPoller,
    restartIfConfigChanged: runner.restartIfConfigChanged,
    async stopPoller(): Promise<void> {
      await Promise.all([runner.stopPoller(), sessions.stop()]);
    },
  };
}
