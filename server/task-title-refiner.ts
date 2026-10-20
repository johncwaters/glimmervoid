import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildTaskTitleRefinementPrompt, decideTaskTitleRefinement, parseRefinedSessionName, parseRefinedTaskTitle,
} from '../session/core/task-title-core.ts';
import type { TaskTitleRefinementResult } from '../session/core/task-title-core.ts';
import type { Session } from '../session/sessions.ts';
import { BrowserConfig } from '../shared/contracts/config.ts';
import { isAutoNameOf } from '../shared/session-naming.ts';
import { STATES } from '../shared/states.ts';
import { readLaneResultFile } from './lanes/lane-spawn.ts';
import type { LaneSpawn } from './lanes/lane-spawn.ts';
import { errorMessage } from '../shared/text.ts';

const PROMPT_FILE = 'task-title-prompt.txt';
const RESULT_FILE = 'task-title-result.json';
const BOOTSTRAP_PROMPT = `Read ${PROMPT_FILE} and follow its instructions`;
const TASK_TITLE_LANE_TOOLS = Object.freeze(['Read', 'Write']);
const DEFAULT_REFINER_SETTINGS = Object.freeze({ enabled: true, model: 'haiku', minIntervalSeconds: 60, timeoutSeconds: 60 });

interface TaskTitleRefinerOptions {
  getConfig: () => { taskTitle?: unknown };
  spawnLane: LaneSpawn;
  renameSession?: (session: Session, proposedName: string) => void;
  nowFn?: () => number;
  logger?: Pick<Console, 'warn'>;
}

interface RefinementRequest {
  session: Session;
  revision: number;
  currentTitle: string | null;
  recentPrompts: readonly string[];
  wantsSessionName: boolean;
}

interface RefinementOutcome {
  refinement: TaskTitleRefinementResult;
  proposedSessionName: string | null;
}

interface SessionRefinementState {
  substantivePromptsSinceRefinement: number;
  lastRefinementAt: number | null;
  recheckTimer: ReturnType<typeof setTimeout> | null;
  detach: () => void;
}

interface ActiveRefinement {
  request: RefinementRequest;
  controller: AbortController;
  promptsCountedAtStart: number;
  settled: Promise<void>;
}

const INVALID_OUTCOME: RefinementOutcome = { refinement: { action: 'invalid' }, proposedSessionName: null };

function hasAutoSessionName(session: Session): boolean {
  return isAutoNameOf(session.name, path.basename(session.path));
}

async function refineTaskTitle(request: RefinementRequest, model: string, spawnLane: LaneSpawn, signal: AbortSignal): Promise<RefinementOutcome> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-task-title-'));
  const resultPath = path.join(workDir, RESULT_FILE);
  try {
    await fs.writeFile(path.join(workDir, PROMPT_FILE), buildTaskTitleRefinementPrompt({
      currentTitle: request.currentTitle, recentPrompts: request.recentPrompts, resultPath, wantsSessionName: request.wantsSessionName,
    }), 'utf8');
    if (signal.aborted) return INVALID_OUTCOME;
    await spawnLane({
      id: `task-title:${crypto.randomUUID()}`, name: 'Task title refinement',
      cwd: workDir, prompt: BOOTSTRAP_PROMPT, agent: 'claude-code', model, signal,
    });
    if (signal.aborted) return INVALID_OUTCOME;
    const laneResult = await readLaneResultFile(resultPath);
    return {
      refinement: parseRefinedTaskTitle(laneResult),
      proposedSessionName: request.wantsSessionName ? parseRefinedSessionName(laneResult) : null,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function createTaskTitleRefiner({ getConfig, spawnLane, renameSession, nowFn = () => Date.now(), logger = console }: TaskTitleRefinerOptions) {
  const statesBySession = new Map<Session, SessionRefinementState>();
  const queuedBySession = new Map<Session, RefinementRequest>();
  let active: ActiveRefinement | null = null;
  let isStopped = false;

  function settings() {
    const parsed = BrowserConfig.shape.taskTitle.safeParse(getConfig().taskTitle);
    if (!parsed.success) return { ...DEFAULT_REFINER_SETTINGS, enabled: false };
    const refiner = parsed.data?.refiner;
    return {
      enabled: refiner?.enabled ?? DEFAULT_REFINER_SETTINGS.enabled, model: refiner?.model?.trim() || DEFAULT_REFINER_SETTINGS.model,
      minIntervalSeconds: refiner?.minIntervalSeconds ?? DEFAULT_REFINER_SETTINGS.minIntervalSeconds,
      timeoutSeconds: refiner?.timeoutSeconds ?? DEFAULT_REFINER_SETTINGS.timeoutSeconds,
    };
  }

  function canRefine(session: Session): boolean {
    return !isStopped && !session._destroyed && !session.ephemeral && !session.customTitle && settings().enabled;
  }

  function clearRecheck(session: Session): void {
    const state = statesBySession.get(session);
    if (!state?.recheckTimer) return;
    clearTimeout(state.recheckTimer);
    state.recheckTimer = null;
  }

  function scheduleRecheck(session: Session): void {
    const state = statesBySession.get(session);
    if (!state) return;
    clearRecheck(session);
    const cooldownEndsAt = (state.lastRefinementAt ?? nowFn()) + settings().minIntervalSeconds * 1000;
    state.recheckTimer = setTimeout(() => {
      state.recheckTimer = null;
      if (session.state !== STATES.IDLE && session.state !== STATES.COMPLETE) return;
      onTurnEnd(session);
    }, Math.max(cooldownEndsAt - nowFn(), 0));
    state.recheckTimer.unref();
  }

  function decisionFor(session: Session) {
    const state = statesBySession.get(session);
    return decideTaskTitleRefinement({
      substantivePromptsSinceRefinement: state?.substantivePromptsSinceRefinement ?? 0,
      lastRefinementAt: state?.lastRefinementAt ?? null, now: nowFn(),
      minIntervalMs: settings().minIntervalSeconds * 1000,
      hasCustomTitle: Boolean(session.customTitle), isEphemeral: session.ephemeral,
    });
  }

  function startNext(): void {
    if (active || isStopped) return;
    for (const [session, request] of queuedBySession) {
      queuedBySession.delete(session);
      if (session.taskTitlePromptRevision !== request.revision) continue;
      if (!canRefine(session)) continue;
      if (request.currentTitle !== null && session.state !== STATES.IDLE && session.state !== STATES.COMPLETE) {
        scheduleRecheck(session);
        continue;
      }
      start(request);
      return;
    }
  }

  function start(request: RefinementRequest): void {
    const state = statesBySession.get(request.session);
    if (!state) return;
    const promptsCountedAtStart = state.substantivePromptsSinceRefinement;
    state.substantivePromptsSinceRefinement = 0;
    state.lastRefinementAt = nowFn();
    const { model, timeoutSeconds } = settings();
    const controller = new AbortController();
    let hasTimedOut = false;
    const timeout = setTimeout(() => {
      hasTimedOut = true;
      controller.abort();
    }, timeoutSeconds * 1000);
    timeout.unref();
    const settled = Promise.resolve().then(() => refineTaskTitle(request, model, spawnLane, controller.signal)).then(
      (outcome) => {
        if (hasTimedOut) logger.warn(`[task-title] refinement timed out after ${timeoutSeconds}s`);
        if (!controller.signal.aborted && outcome.refinement.action === 'invalid') logger.warn('[task-title] refinement returned no usable title');
        finish(request, outcome);
      },
      (error: unknown) => {
        logger.warn(`[task-title] refinement failed: ${errorMessage(error)}`);
        finish(request, INVALID_OUTCOME);
      },
    ).finally(() => clearTimeout(timeout));
    active = { request, controller, promptsCountedAtStart, settled };
  }

  function finish(request: RefinementRequest, { refinement, proposedSessionName }: RefinementOutcome): void {
    if (active?.request !== request) return;
    const wasAborted = active.controller.signal.aborted;
    const { promptsCountedAtStart } = active;
    active = null;
    if (request.session.taskTitlePromptRevision === request.revision) {
      const isApplicable = canRefine(request.session);
      const refinementToApply: TaskTitleRefinementResult = !wasAborted && isApplicable ? refinement : { action: 'invalid' };
      const state = statesBySession.get(request.session);
      if (refinementToApply.action === 'invalid' && isApplicable && state) state.substantivePromptsSinceRefinement += promptsCountedAtStart;
      request.session.applyTaskTitleRefinement(refinementToApply);
      if (!wasAborted && isApplicable && proposedSessionName) renameSession?.(request.session, proposedSessionName);
    }
    startNext();
  }

  function onTurnEnd(session: Session): void {
    clearRecheck(session);
    if (!canRefine(session)) {
      queuedBySession.delete(session);
      return;
    }
    const decision = decisionFor(session);
    if (decision.action === 'skip') {
      queuedBySession.delete(session);
      if (decision.reason === 'cooldown') scheduleRecheck(session);
      return;
    }
    const request: RefinementRequest = {
      session, revision: session.taskTitlePromptRevision, currentTitle: session.refinedTaskTitle, recentPrompts: session.recentTaskPrompts,
      wantsSessionName: Boolean(renameSession) && hasAutoSessionName(session),
    };
    queuedBySession.set(session, request);
    startNext();
  }

  function attachSession(session: Session): void {
    if (statesBySession.has(session) || session._destroyed || session.ephemeral || isStopped) return;
    const state: SessionRefinementState = { substantivePromptsSinceRefinement: 0, lastRefinementAt: null, recheckTimer: null, detach };
    statesBySession.set(session, state);
    function onPrompt(): void {
      state.substantivePromptsSinceRefinement++;
      if (session.refinedTaskTitle === null) onTurnEnd(session);
    }
    function onReset(): void {
      clearRecheck(session);
      state.substantivePromptsSinceRefinement = 0;
      state.lastRefinementAt = null;
      queuedBySession.delete(session);
      if (active?.request.session === session) active.controller.abort();
    }
    function onTitleChange(): void {
      if (!session.customTitle) return;
      clearRecheck(session);
      queuedBySession.delete(session);
      if (active?.request.session === session) active.controller.abort();
    }
    function detach(): void {
      session.off('task-prompt', onPrompt);
      session.off('task-title-reset', onReset);
      session.off('task-title-change', onTitleChange);
      session.off('teardown', detach);
      clearRecheck(session);
      statesBySession.delete(session);
      queuedBySession.delete(session);
      if (active?.request.session === session) active.controller.abort();
    }
    session.on('task-prompt', onPrompt);
    session.on('task-title-reset', onReset);
    session.on('task-title-change', onTitleChange);
    session.once('teardown', detach);
  }

  async function stop(): Promise<void> {
    isStopped = true;
    for (const state of statesBySession.values()) state.detach();
    queuedBySession.clear();
    active?.controller.abort();
    await active?.settled;
  }

  return { attachSession, onTurnEnd, stop };
}

export { TASK_TITLE_LANE_TOOLS, createTaskTitleRefiner };
