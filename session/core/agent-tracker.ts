import { clock } from '../../shared/clock.ts';

const DEFAULT_AGENT_TTL_MS = 30 * 60 * 1000;

type TimestampMap = Map<string, number>;
type AgentStopOutcome = 'removed' | 'orphan' | 'duplicate' | 'ignored';
type ExpiredWorkKind = 'subagent' | 'shell';
type ExpiredOpenWork = Record<ExpiredWorkKind, number>;
type LateFinish = { kind: ExpiredWorkKind; minutesPastLimit: number };
type ExpiredWork = { kind: ExpiredWorkKind; startedAtMs: number };

function addAgent(map: TimestampMap, agentId: string | null | undefined, ts: number): boolean {
  if (!agentId) return false;
  const had = map.has(agentId);
  map.set(agentId, ts);
  return !had;
}

function removeAgent(map: TimestampMap, agentId: string | null | undefined): boolean {
  if (!agentId) return false;
  return map.delete(agentId);
}

function pruneAgents(map: TimestampMap, now: number, ttlMs = DEFAULT_AGENT_TTL_MS): number {
  let removed = 0;
  for (const [id, ts] of map) {
    if (now - ts >= ttlMs) {
      map.delete(id);
      removed++;
    }
  }
  return removed;
}

const SETTLED_TASK_STATUSES = new Set([
  'completed', 'complete', 'done', 'finished', 'failed', 'error',
  'killed', 'cancelled', 'canceled', 'exited', 'idle', 'success',
]);

const ARTIFACT_COMMENT_WATCH_DESCRIPTION_PREFIX = 'live updates for artifact ';

type RawBackgroundTask = { status?: unknown; id?: unknown; type?: unknown; description?: unknown } | null;

const LEADING_ENV_ASSIGNMENT = /^[A-Z_][A-Z0-9_]*=[^\s;&|]*\s+/;
const LEADING_WRAPPER_COMMAND = /^(?:nohup|env)(?:\s+-[a-zA-Z]+)?\s+/;
const PACKAGE_MANAGER_SERVICE_SCRIPT = /^(?:npm|pnpm|yarn|bun)\s+(?:(?:--prefix|--filter|--cwd|-C)\s+\S+\s+)*(?:run\s+)?(?:(?:[\w-]+:)?(?:dev|start|serve|preview|watch|storybook)|(?:dev|start|serve|preview|watch|storybook):(?:dev|start|serve|preview|watch|local|server|web|site|app))(?=\s|$|>)/;
const EXECUTOR_SERVICE_COMMAND = /^(?:npx|pnpx|bunx)\s+(?:-[a-zA-Z]+\s+)*(?:serve|http-server|live-server|storybook|json-server)(?=\s|$|>)/;
const VITE_COMMAND = /^(?:(?:npx|pnpx|bunx)\s+(?:-[a-zA-Z]+\s+)*)?vite(?=\s|$|>)/;
const VITE_FINITE_SUBCOMMAND = /\s(?:build|optimize)(?=\s|$|>)/;
const FRAMEWORK_DEV_COMMAND = /^(?:(?:next|nuxt|astro|remix|expo)\s+(?:dev|start|preview)|gatsby\s+(?:develop|serve)|(?:webpack|rspack|parcel)\s+(?:serve|watch)|python3?\s+-m\s+http\.server|http-server|live-server|uvicorn|gunicorn|nodemon|watchexec|ngrok|flask\s+run|rails\s+(?:s|server)|hugo\s+server|jekyll\s+serve|mkdocs\s+serve|php\s+-S|caddy\s+run|cloudflared\s+tunnel|kubectl\s+port-forward|cargo\s+watch|tsx\s+watch|node\s+--watch|tail\s+(?:-[a-zA-Z]*f|--follow))(?=\s|$|>)/;
const DOCKER_COMPOSE_UP = /^docker[\s-]+compose\s+up(?=\s|$|>)/;
const DOCKER_DETACH_FLAG = /\s(?:-d|--detach)(?=\s|$|>)/;
const LONG_WATCH_COMMAND = /^(?:tsc|tsx|vitest|jest|esbuild|rollup)\b/;
const LONG_WATCH_FLAG = /\s(?:--watch|--watchAll)(?=\s|$|>)/;
const SHORT_WATCH_COMMAND = /^(?:tsc|esbuild|rollup)\b/;
const SHORT_WATCH_FLAG = /\s-w(?=\s|$|>)/;
const NODE_SCRIPT_COMMAND = /^node\s+(?:-[^\s]+\s+)*([^\s>]+)/;
const SERVE_SCRIPT_BASENAME = /^\.?(?:serve|dev-server|server)(?:\.(?:dev|local))?\.(?:m|c)?(?:j|t)s$/i;

const SERVICE_SHELL_DESCRIPTION_PATTERN = /^(?:serve\b|rebuild and serve\b|(?:start|run|launch)\s+(?:the\s+|a\s+|an\s+|local\s+|minimal\s+|before-state\s+|after-state\s+)*(?:[\w-]+\s+){0,2}(?:dev\s+)?(?:server|daemon|service|watcher)(?=$|[.,:;!?)]|\s+(?:on|at|in|for|with|from|under|using|via)\b))/i;

function stripLeadingEnvAndWrappers(rawSegment: string): string {
  let segment = rawSegment.trim();
  while (segment.length > 0) {
    const withoutEnv = segment.replace(LEADING_ENV_ASSIGNMENT, '');
    if (withoutEnv !== segment) {
      segment = withoutEnv.trimStart();
      continue;
    }
    const withoutWrapper = segment.replace(LEADING_WRAPPER_COMMAND, '');
    if (withoutWrapper !== segment) {
      segment = withoutWrapper.trimStart();
      continue;
    }
    break;
  }
  return segment;
}

function isServiceShellSegment(rawSegment: string): boolean {
  const segment = stripLeadingEnvAndWrappers(rawSegment);
  if (segment.length === 0) return false;
  if (PACKAGE_MANAGER_SERVICE_SCRIPT.test(segment)) return true;
  if (EXECUTOR_SERVICE_COMMAND.test(segment)) return true;
  if (VITE_COMMAND.test(segment) && !VITE_FINITE_SUBCOMMAND.test(segment)) return true;
  if (FRAMEWORK_DEV_COMMAND.test(segment)) return true;
  if (DOCKER_COMPOSE_UP.test(segment) && !DOCKER_DETACH_FLAG.test(segment)) return true;
  if (LONG_WATCH_COMMAND.test(segment) && LONG_WATCH_FLAG.test(segment)) return true;
  if (SHORT_WATCH_COMMAND.test(segment) && SHORT_WATCH_FLAG.test(segment)) return true;
  const nodeMatch = NODE_SCRIPT_COMMAND.exec(segment);
  if (!nodeMatch) return false;
  const scriptPath = nodeMatch[1] ?? '';
  const basename = scriptPath.slice(Math.max(scriptPath.lastIndexOf('/'), scriptPath.lastIndexOf('\\')) + 1);
  return SERVE_SCRIPT_BASENAME.test(basename);
}

function isServiceShellDescription(description: unknown): boolean {
  return typeof description === 'string' && SERVICE_SHELL_DESCRIPTION_PATTERN.test(description.trim());
}

function isServiceShellLaunch(input: { command?: unknown; description?: unknown } | null | undefined): boolean {
  if (!input) return false;
  if (typeof input.command === 'string' && input.command.split(/[\n;&|]+/).some(isServiceShellSegment)) return true;
  return isServiceShellDescription(input.description);
}

function isArtifactCommentWatch(task: RawBackgroundTask): boolean {
  return task?.type === 'monitor'
    && typeof task.description === 'string'
    && task.description.startsWith(ARTIFACT_COMMENT_WATCH_DESCRIPTION_PREFIX);
}

function extractBackgroundTasks(payload: unknown): DeclaredEntry[] | null {
  if (!payload) return null;
  const v = (payload as { background_tasks?: unknown }).background_tasks;
  if (!Array.isArray(v)) return null;
  const entries: DeclaredEntry[] = [];
  for (const raw of v) {
    const t = raw as RawBackgroundTask;
    const status = t && typeof t.status === 'string' ? t.status.toLowerCase() : null;
    if (status && SETTLED_TASK_STATUSES.has(status)) continue;
    if (isArtifactCommentWatch(t)) continue;
    const type = t && typeof t.type === 'string' && t.type ? t.type : null;
    const isService = type === 'shell' && isServiceShellLaunch({ command: t?.description, description: t?.description });
    entries.push({
      id: t && typeof t.id === 'string' && t.id ? t.id : null,
      type,
      ...(isService ? { isService: true } : {}),
    });
  }
  return entries;
}

const WEAK_TASK_TYPES = new Set<string | null | undefined>(['shell', 'monitor']);

const NON_GATING_TASK_TYPES = new Set<string | null | undefined>(['dream', 'monitor']);

const DEFAULT_SHELL_TASK_TTL_MS = 60 * 60 * 1000;

interface DeclaredEntry {
  id?: string | null;
  type?: string | null;
  isService?: boolean;
}

function isServiceShellEntry(entry: DeclaredEntry, serviceShellIds?: ReadonlySet<string> | null): boolean {
  if (entry.type !== 'shell') return false;
  if (entry.isService === true) return true;
  return Boolean(entry.id && serviceShellIds?.has(entry.id));
}

function isNonGatingEntry(entry: DeclaredEntry, serviceShellIds?: ReadonlySet<string> | null): boolean {
  return NON_GATING_TASK_TYPES.has(entry.type) || isServiceShellEntry(entry, serviceShellIds);
}

const DEFAULT_TEAMMATE_TASK_TTL_MS = 90 * 1000;

type RunningBackgroundTask = { id: string; type: string | null };

function backgroundTaskChanges(announcedIds: ReadonlySet<string>, declaredEntries: readonly DeclaredEntry[]): { started: RunningBackgroundTask[]; stoppedIds: string[] } {
  const runningTasks = declaredEntries.flatMap((entry) => entry.id && entry.type !== 'subagent' ? [{ id: entry.id, type: entry.type ?? null }] : []);
  const runningIds = new Set(runningTasks.map((task) => task.id));
  return {
    started: runningTasks.filter((task) => !announcedIds.has(task.id)),
    stoppedIds: [...announcedIds].filter((id) => !runningIds.has(id)),
  };
}

const IN_TURN_NOTIFICATION_DELIVERY_WINDOW_MS = 10 * 1000;

function declaredActiveCount(
  entries: readonly DeclaredEntry[] | null,
  idleIds: ReadonlySet<string> | null,
  ageMs: number | ((entry: DeclaredEntry) => number) = 0, weakTtlMs = DEFAULT_SHELL_TASK_TTL_MS, idleNameCount = 0,
  teammateTtlMs = DEFAULT_TEAMMATE_TASK_TTL_MS, agentTtlMs = DEFAULT_AGENT_TTL_MS,
  serviceShellIds: ReadonlySet<string> | null = null,
): number {
  if (!entries) return 0;
  let activeCount = 0;
  let teammateCount = 0;
  for (const entry of entries) {
    const entryAgeMs = typeof ageMs === 'function' ? ageMs(entry) : ageMs;
    if (entry.id && idleIds && idleIds.has(entry.id)) continue;
    if (isNonGatingEntry(entry, serviceShellIds)) continue;
    if (entryAgeMs >= declaredEntryTtlMs(entry.type, weakTtlMs, teammateTtlMs, agentTtlMs)) continue;
    activeCount++;
    if (entry.type === 'teammate') teammateCount++;
  }
  return activeCount - Math.min(idleNameCount, teammateCount);
}

function isOnlyBackgroundTasks(
  entries: readonly DeclaredEntry[] | null,
  countedAgents: TimestampMap,
  idleIds: ReadonlySet<string>,
  ageMs: (entry: DeclaredEntry) => number,
  weakTtlMs: number,
  idleNameCount: number,
  teammateTtlMs: number,
  agentTtlMs: number,
  serviceShellIds: ReadonlySet<string> | null = null,
): boolean {
  if (!entries || countedAgents.size > 0) return false;
  const shellEntries = entries.filter((entry) => entry.type === 'shell');
  const otherEntries = entries.filter((entry) => entry.type !== 'shell');
  const count = (selectedEntries: DeclaredEntry[]) => declaredActiveCount(
    selectedEntries, idleIds, ageMs, weakTtlMs, idleNameCount, teammateTtlMs, agentTtlMs, serviceShellIds,
  );
  return count(shellEntries) > 0 && count(otherEntries) === 0;
}

function declaredEntryTtlMs(
  type: string | null | undefined,
  weakTtlMs: number,
  teammateTtlMs: number,
  agentTtlMs: number,
): number {
  if (WEAK_TASK_TYPES.has(type)) return weakTtlMs;
  if (type === 'teammate') return teammateTtlMs;
  return agentTtlMs;
}

interface NextDrainInputs {
  countedAgents?: TimestampMap | null;
  declaredEntries?: readonly DeclaredEntry[] | null;
  declaredTs?: number;
  declaredFirstSeenTs?: ReadonlyMap<string, number>;
  idleIds?: ReadonlySet<string> | null;
  serviceShellIds?: ReadonlySet<string> | null;
  now?: number;
  agentTtlMs?: number;
  weakTtlMs?: number;
  teammateTtlMs?: number;
  undeliveredTaskExpiries?: TimestampMap | null;
}

function declaredEntryAgeStartTs(
  entry: DeclaredEntry,
  declaredTs: number,
  declaredFirstSeenTs: ReadonlyMap<string, number> | undefined,
): number {
  if (!WEAK_TASK_TYPES.has(entry.type) || !entry.id) return declaredTs;
  return declaredFirstSeenTs?.get(entry.id) ?? declaredTs;
}

function msUntilNextDrain({
  countedAgents = null,
  declaredEntries = null,
  declaredTs = 0,
  declaredFirstSeenTs = undefined,
  idleIds = null,
  serviceShellIds = null,
  now = 0,
  agentTtlMs = DEFAULT_AGENT_TTL_MS,
  weakTtlMs = DEFAULT_SHELL_TASK_TTL_MS,
  teammateTtlMs = DEFAULT_TEAMMATE_TASK_TTL_MS,
  undeliveredTaskExpiries = null,
}: NextDrainInputs = {}): number | null {
  let earliestExpiry: number | null = null;
  const consider = (expiresAt: number): void => {
    if (expiresAt <= now) return;
    if (earliestExpiry === null || expiresAt < earliestExpiry) earliestExpiry = expiresAt;
  };
  if (countedAgents) {
    for (const ts of countedAgents.values()) consider(ts + agentTtlMs);
  }
  if (undeliveredTaskExpiries) {
    for (const expiresAt of undeliveredTaskExpiries.values()) consider(expiresAt);
  }
  if (declaredEntries) {
    for (const e of declaredEntries) {
      if (e.id && idleIds && idleIds.has(e.id)) continue;
      if (isNonGatingEntry(e, serviceShellIds)) continue;
      const ageStartTs = declaredEntryAgeStartTs(e, declaredTs, declaredFirstSeenTs);
      consider(ageStartTs + declaredEntryTtlMs(e.type, weakTtlMs, teammateTtlMs, agentTtlMs));
    }
  }
  if (earliestExpiry === null) return null;
  return earliestExpiry - now;
}

function evictDepartedTeammateNames(
  idleTeammateNames: TimestampMap,
  declaredTeammateIds: ReadonlySet<string>,
  currentEntries: readonly DeclaredEntry[],
): Set<string> {
  const currentTeammateIds = new Set<string>(
    currentEntries.flatMap((e) => (e.type === 'teammate' && e.id ? [e.id] : [])),
  );
  let departedCount = 0;
  for (const id of declaredTeammateIds) {
    if (!currentTeammateIds.has(id)) departedCount++;
  }
  for (const name of idleTeammateNames.keys()) {
    if (departedCount <= 0) break;
    idleTeammateNames.delete(name);
    departedCount--;
  }
  return currentTeammateIds;
}

interface TaskRegistryOptions {
  agentTtlMs?: number;
  shellTaskTtlMs?: number;
  teammateTaskTtlMs?: number;
  now?: () => number;
}

interface TaskRegistryBreakdown {
  counted: number;
  declared: number;
  idleNames: number;
  idleTasks: number;
}

interface TaskRegistryInspection {
  counted: TimestampMap;
  observedAgentIdsThisTurn: Set<string>;
  orphanAgentStops: TimestampMap;
  declared: DeclaredEntry[] | null;
  declaredTs: number;
  declaredFirstSeenTs: TimestampMap;
  idleTaskIds: Set<string>;
  idleTeammateNames: TimestampMap;
  declaredTeammateIds: Set<string>;
  launchedBackgroundTasks: TimestampMap;
  undeliveredTaskExpiries: TimestampMap;
}

interface TaskRegistry {
  noteAgentStart(agentId: string | null | undefined, ts: number): boolean;
  noteAgentStop(agentId: string | null | undefined): AgentStopOutcome;
  hasOrphanStopEvidence(): boolean;
  resetTurnEvidence(): void;
  reconcileDeclared(entries: DeclaredEntry[], isBetweenTurns: boolean): void;
  clearDeclared(): boolean;
  hasDeclared(): boolean;
  noteTaskCreated(options: { taskId?: string | null; name?: string | null }): void;
  noteTaskCompleted(options: { taskId?: string | null; name?: string | null }): void;
  noteTeammateIdle(name: string, ts: number): void;
  regateByAgentId(agentId: unknown): void;
  noteBackgroundTaskLaunched(taskId: string, isService?: boolean): void;
  noteTaskNotificationsDelivered(taskIds: readonly string[]): void;
  expiredOpenWork(): ExpiredOpenWork;
  agentWorkExpiryCount(): number;
  shellWorkExpiryCount(): number;
  drainLateFinishes(): LateFinish[];
  activeCount(): number;
  isOnlyBackgroundTasks(): boolean;
  hasLiveMonitor(): boolean;
  getBreakdown(): TaskRegistryBreakdown;
  msUntilNextDrain(at: number): number | null;
  clear(): void;
  inspect(): TaskRegistryInspection;
}

function createTaskRegistry({
  agentTtlMs = DEFAULT_AGENT_TTL_MS,
  shellTaskTtlMs = DEFAULT_SHELL_TASK_TTL_MS,
  teammateTaskTtlMs = DEFAULT_TEAMMATE_TASK_TTL_MS,
  now = clock.nowMs,
}: TaskRegistryOptions = {}): TaskRegistry {
  const countedAgents: TimestampMap = new Map();
  const observedAgentIdsThisTurn = new Set<string>();
  const orphanAgentStops: TimestampMap = new Map();
  let declaredEntries: DeclaredEntry[] | null = null;
  let declaredTs = 0;
  const declaredFirstSeenTs: TimestampMap = new Map();
  const idleTaskIds = new Set<string>();
  const idleTeammateNames: TimestampMap = new Map();
  let declaredTeammateIds = new Set<string>();
  const launchedBackgroundTasks: TimestampMap = new Map();
  const serviceShellIds = new Set<string>();
  const undeliveredTaskExpiries: TimestampMap = new Map();
  const expiredWorkById = new Map<string, ExpiredWork>();
  let pendingLateFinishes: LateFinish[] = [];
  let agentWorkExpiries = 0;
  let shellWorkExpiries = 0;
  const expiredDeclaredShellKeys = new Set<string>();
  let breakdown: TaskRegistryBreakdown = { counted: 0, declared: 0, idleNames: 0, idleTasks: 0 };
  const limitMsByKind: Record<ExpiredWorkKind, number> = { subagent: agentTtlMs, shell: shellTaskTtlMs };

  function moveExpiredWork(map: TimestampMap, kind: ExpiredWorkKind, at: number): void {
    for (const [id, startedAtMs] of map) {
      if (at - startedAtMs < limitMsByKind[kind]) continue;
      map.delete(id);
      expiredWorkById.set(id, { kind, startedAtMs });
      if (kind === 'subagent') agentWorkExpiries += 1;
    }
  }

  function noteFinish(kind: ExpiredWorkKind, startedAtMs: number | undefined, at: number): void {
    if (startedAtMs === undefined) return;
    const msPastLimit = at - startedAtMs - limitMsByKind[kind];
    if (msPastLimit < 0) return;
    pendingLateFinishes.push({ kind, minutesPastLimit: Math.floor(msPastLimit / 60_000) });
  }

  function finishExpiredWork(id: string, kind: ExpiredWorkKind, at: number): void {
    const expired = expiredWorkById.get(id);
    if (expired?.kind !== kind) return;
    expiredWorkById.delete(id);
    noteFinish(kind, expired.startedAtMs, at);
  }

  function finishExpiredWorkMissingFrom(liveIds: ReadonlySet<string>, kind: ExpiredWorkKind, at: number): void {
    for (const id of [...expiredWorkById.keys()]) {
      if (!liveIds.has(id)) finishExpiredWork(id, kind, at);
    }
  }

  function finishWork(map: TimestampMap, id: string, kind: ExpiredWorkKind, at: number): void {
    noteFinish(kind, map.get(id), at);
    finishExpiredWork(id, kind, at);
  }

  function entryAgeMs(entry: DeclaredEntry, at: number): number {
    return at - declaredEntryAgeStartTs(entry, declaredTs, declaredFirstSeenTs);
  }

  function pruneUndeliveredTasks(at: number): number {
    let expiredCount = 0;
    for (const [taskId, expiresAt] of undeliveredTaskExpiries) {
      if (at < expiresAt) continue;
      undeliveredTaskExpiries.delete(taskId);
      expiredCount += 1;
    }
    return expiredCount;
  }

  function countExpiredDeclaredShells(entries: readonly DeclaredEntry[], at: number): void {
    entries.forEach((entry, index) => {
      if (entry.type !== 'shell' || isNonGatingEntry(entry, serviceShellIds) || entryAgeMs(entry, at) < shellTaskTtlMs) return;
      const shellKey = entry.id ?? `#${index}`;
      if (expiredDeclaredShellKeys.has(shellKey)) return;
      expiredDeclaredShellKeys.add(shellKey);
      shellWorkExpiries += 1;
    });
  }

  function reap(at: number): void {
    moveExpiredWork(countedAgents, 'subagent', at);
    pruneAgents(orphanAgentStops, at, agentTtlMs);
    pruneAgents(idleTeammateNames, at, agentTtlMs);
    moveExpiredWork(launchedBackgroundTasks, 'shell', at);
    shellWorkExpiries += pruneUndeliveredTasks(at);
    if (declaredEntries === null) return;
    countExpiredDeclaredShells(declaredEntries, at);
    const hasUnexpiredEntry = declaredEntries.some((entry) => entryAgeMs(entry, at)
      < declaredEntryTtlMs(entry.type, shellTaskTtlMs, teammateTaskTtlMs, agentTtlMs));
    if (hasUnexpiredEntry) return;
    if (declaredEntries.some((entry) => !WEAK_TASK_TYPES.has(entry.type))) agentWorkExpiries += 1;
    declaredEntries = null;
    declaredTs = 0;
  }

  return {
    noteAgentStart(agentId, ts) {
      if (agentId) {
        idleTaskIds.delete(agentId);
        observedAgentIdsThisTurn.add(agentId);
        expiredWorkById.delete(agentId);
      }
      return addAgent(countedAgents, agentId, ts);
    },

    noteAgentStop(agentId) {
      if (!agentId) return 'ignored';
      finishWork(countedAgents, agentId, 'subagent', now());
      const changed = removeAgent(countedAgents, agentId);
      if (changed) {
        observedAgentIdsThisTurn.add(agentId);
        return 'removed';
      }
      if (observedAgentIdsThisTurn.has(agentId)) return 'duplicate';
      observedAgentIdsThisTurn.add(agentId);
      orphanAgentStops.set(agentId, now());
      return 'orphan';
    },

    hasOrphanStopEvidence() {
      reap(now());
      return orphanAgentStops.size > 0;
    },

    resetTurnEvidence() {
      observedAgentIdsThisTurn.clear();
      orphanAgentStops.clear();
    },

    reconcileDeclared(entries, isBetweenTurns) {
      declaredEntries = entries;
      declaredTs = now();
      const declaredIds = new Set<string>(entries.flatMap((e) => (e.id ? [e.id] : [])));
      for (const shellKey of expiredDeclaredShellKeys) {
        if (!declaredIds.has(shellKey)) expiredDeclaredShellKeys.delete(shellKey);
      }
      const deliveryLimitMs = isBetweenTurns ? shellTaskTtlMs : IN_TURN_NOTIFICATION_DELIVERY_WINDOW_MS;
      for (const id of declaredFirstSeenTs.keys()) {
        if (!declaredIds.has(id)) {
          declaredFirstSeenTs.delete(id);
          serviceShellIds.delete(id);
        }
      }
      for (const id of declaredIds) {
        if (!declaredFirstSeenTs.has(id)) declaredFirstSeenTs.set(id, declaredTs);
      }
      finishExpiredWorkMissingFrom(declaredIds, 'shell', declaredTs);
      for (const id of launchedBackgroundTasks.keys()) {
        if (declaredIds.has(id)) continue;
        noteFinish('shell', launchedBackgroundTasks.get(id), declaredTs);
        launchedBackgroundTasks.delete(id);
        undeliveredTaskExpiries.set(id, declaredTs + deliveryLimitMs);
      }
      for (const id of idleTaskIds) {
        if (!declaredIds.has(id)) idleTaskIds.delete(id);
      }
      declaredTeammateIds = evictDepartedTeammateNames(idleTeammateNames, declaredTeammateIds, entries);
      const rawDeclaredActive = declaredActiveCount(
        entries, idleTaskIds, (entry) => entryAgeMs(entry, declaredTs),
        shellTaskTtlMs, 0, teammateTaskTtlMs, agentTtlMs, serviceShellIds,
      );
      if (rawDeclaredActive > 0) return;
      for (const startedAtMs of countedAgents.values()) noteFinish('subagent', startedAtMs, declaredTs);
      countedAgents.clear();
      finishExpiredWorkMissingFrom(new Set(), 'subagent', declaredTs);
    },

    clearDeclared() {
      if (declaredEntries === null) return false;
      declaredEntries = null;
      declaredTs = 0;
      return true;
    },

    hasDeclared() {
      return declaredEntries !== null;
    },

    noteTaskCreated({ taskId, name }) {
      if (name) idleTeammateNames.delete(name);
      if (taskId) idleTaskIds.delete(taskId);
    },

    noteTaskCompleted({ taskId, name }) {
      if (!taskId) return;
      idleTaskIds.add(taskId);
      removeAgent(countedAgents, taskId);
      if (name) idleTeammateNames.delete(name);
    },

    noteTeammateIdle(name, ts) {
      idleTeammateNames.set(name, ts);
    },

    regateByAgentId(agentId: unknown) {
      if (typeof agentId !== 'string') return;
      for (const name of idleTeammateNames.keys()) {
        const prefix = `a${name}-`;
        if (agentId.startsWith(prefix) && /^[0-9a-f]+$/i.test(agentId.slice(prefix.length))) {
          idleTeammateNames.delete(name);
        }
      }
    },

    noteBackgroundTaskLaunched(taskId, isService = false) {
      undeliveredTaskExpiries.delete(taskId);
      expiredWorkById.delete(taskId);
      if (isService) {
        serviceShellIds.add(taskId);
        launchedBackgroundTasks.delete(taskId);
        return;
      }
      serviceShellIds.delete(taskId);
      launchedBackgroundTasks.set(taskId, now());
    },

    noteTaskNotificationsDelivered(taskIds) {
      const at = now();
      for (const taskId of taskIds) {
        finishWork(launchedBackgroundTasks, taskId, 'shell', at);
        launchedBackgroundTasks.delete(taskId);
        serviceShellIds.delete(taskId);
        undeliveredTaskExpiries.delete(taskId);
      }
    },

    expiredOpenWork() {
      reap(now());
      const expiredOpenWork: ExpiredOpenWork = { subagent: 0, shell: 0 };
      for (const work of expiredWorkById.values()) expiredOpenWork[work.kind] += 1;
      return expiredOpenWork;
    },

    agentWorkExpiryCount() {
      reap(now());
      return agentWorkExpiries;
    },

    shellWorkExpiryCount() {
      reap(now());
      return shellWorkExpiries;
    },

    drainLateFinishes() {
      const lateFinishes = pendingLateFinishes;
      pendingLateFinishes = [];
      return lateFinishes;
    },

    activeCount() {
      const at = now();
      reap(at);
      const declared = declaredActiveCount(
        declaredEntries, idleTaskIds, (entry) => entryAgeMs(entry, at),
        shellTaskTtlMs, idleTeammateNames.size, teammateTaskTtlMs, agentTtlMs, serviceShellIds,
      );
      breakdown = {
        counted: countedAgents.size,
        declared,
        idleNames: idleTeammateNames.size,
        idleTasks: idleTaskIds.size,
      };
      return Math.max(countedAgents.size, declared + undeliveredTaskExpiries.size);
    },

    isOnlyBackgroundTasks() {
      const at = now();
      reap(at);
      return isOnlyBackgroundTasks(
        declaredEntries, countedAgents, idleTaskIds, (entry) => entryAgeMs(entry, at),
        shellTaskTtlMs, idleTeammateNames.size, teammateTaskTtlMs, agentTtlMs, serviceShellIds,
      );
    },

    hasLiveMonitor() {
      const at = now();
      reap(at);
      if (declaredEntries === null) return false;
      return declaredEntries.some((entry) => (entry.type === 'monitor' || isServiceShellEntry(entry, serviceShellIds))
        && !(entry.id && idleTaskIds.has(entry.id))
        && entryAgeMs(entry, at) < shellTaskTtlMs);
    },

    getBreakdown() {
      return breakdown;
    },

    msUntilNextDrain(at) {
      return msUntilNextDrain({
        countedAgents,
        declaredEntries,
        declaredTs,
        declaredFirstSeenTs,
        idleIds: idleTaskIds,
        serviceShellIds,
        now: at,
        agentTtlMs,
        weakTtlMs: shellTaskTtlMs,
        teammateTtlMs: teammateTaskTtlMs,
        undeliveredTaskExpiries,
      });
    },

    clear() {
      countedAgents.clear();
      observedAgentIdsThisTurn.clear();
      orphanAgentStops.clear();
      declaredEntries = null;
      declaredTs = 0;
      declaredFirstSeenTs.clear();
      idleTaskIds.clear();
      idleTeammateNames.clear();
      declaredTeammateIds.clear();
      launchedBackgroundTasks.clear();
      serviceShellIds.clear();
      undeliveredTaskExpiries.clear();
      expiredDeclaredShellKeys.clear();
      expiredWorkById.clear();
      pendingLateFinishes = [];
    },

    inspect() {
      return {
        counted: new Map(countedAgents),
        observedAgentIdsThisTurn: new Set(observedAgentIdsThisTurn),
        orphanAgentStops: new Map(orphanAgentStops),
        declared: declaredEntries,
        declaredTs,
        declaredFirstSeenTs: new Map(declaredFirstSeenTs),
        idleTaskIds: new Set(idleTaskIds),
        idleTeammateNames: new Map(idleTeammateNames),
        declaredTeammateIds: new Set(declaredTeammateIds),
        launchedBackgroundTasks: new Map(launchedBackgroundTasks),
        undeliveredTaskExpiries: new Map(undeliveredTaskExpiries),
      };
    },
  };
}

export { backgroundTaskChanges, extractBackgroundTasks, isServiceShellLaunch, msUntilNextDrain, createTaskRegistry, DEFAULT_AGENT_TTL_MS, DEFAULT_SHELL_TASK_TTL_MS, DEFAULT_TEAMMATE_TASK_TTL_MS };
export type { DeclaredEntry, ExpiredOpenWork, LateFinish, TaskRegistryBreakdown };
