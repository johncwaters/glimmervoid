import * as core from './core/team-review-core.ts';
import type { ReviewStateEntry } from './core/team-review-core.ts';
import { drainPending, firstLine, raceWithAbort } from './ephemeral-session.ts';
import { createTickLoop } from './lane-runner.ts';
import type { TickOutcome } from './lane-runner.ts';

interface TeamReviewCandidate extends core.PullRequestCandidate {
  number: number;
  headRefOid: string;
  headRefName: string;
  mergeable: string;
  title?: string;
  url?: string;
}

interface KeyedPr extends TeamReviewCandidate {
  key: string;
}

interface PrEntry extends ReviewStateEntry {
  wasConflicting?: boolean;
  reason?: string;
}

type PrState = Record<string, PrEntry | undefined>;

interface PrWorkspace {
  cwd: string;
  isGit: boolean;
  reason?: string;
  branch?: string | null;
}

interface PrGitWorkspace {
  listWorktreeBranches(input: { projectPath: string }): Promise<{ branch: string; cwd: string }[]>;
  create(input: { projectPath: string; teamId: string; label: string; forkFromHead?: boolean; worktreeBase?: string }): Promise<PrWorkspace | null>;
  discard(input: { projectPath: string; workspace: PrWorkspace }): Promise<unknown>;
  removeWorktreeByPath(input: { projectPath: string; cwd: string; branch: string }): Promise<unknown>;
}

interface ReviewProject {
  id: string;
  path: string;
  slug: string;
  name?: string;
}

interface SpawnReviewArgs {
  projectPath: string;
  cwd: string;
  pr: KeyedPr;
  slug: string;
  conflicting: boolean;
  timeoutMs: number;
  signal?: AbortSignal | null;
}

interface ReviewVerdict {
  verdict: string;
  summary?: string;
}

interface TeamReviewPollerDependencies {
  projects?: ReviewProject[];
  listCandidates: (project: ReviewProject) => Promise<TeamReviewCandidate[]>;
  gitWorkspace: PrGitWorkspace;
  getWorktreeBase?: (projectPath: string) => string | undefined;
  spawnReview: (args: SpawnReviewArgs) => Promise<ReviewVerdict | null | undefined>;
  readState?: () => Promise<PrState>;
  writeState?: (state: PrState) => Promise<void>;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  log?: Pick<Console, 'warn'>;
  onTickComplete?: (status: Record<string, unknown>) => void;
  now?: () => number;
  intervalMinutes?: number;
  maxConcurrentReviews?: number;
  reviewTimeoutSeconds?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createTeamReviewPoller(deps: TeamReviewPollerDependencies) {
  const {
    projects = [], listCandidates, gitWorkspace, getWorktreeBase = () => undefined, spawnReview,
    readState = async () => ({}), writeState = async () => {},
    setIntervalFn = (fn, ms) => setInterval(fn, ms), clearIntervalFn = clearInterval,
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = clearTimeout,
    log = console, onTickComplete = () => {}, now = () => Date.now(),
  } = deps;
  const maxConcurrentReviews = deps.maxConcurrentReviews || 3;
  const reviewTimeoutSeconds = deps.reviewTimeoutSeconds || 900;
  let state: PrState = {};

  const loop = createTickLoop({
    tag: 'team-review', intervalMs: (deps.intervalMinutes || 15) * 60000,
    tick: () => runTick(), writeState: () => writeState(state), setIntervalFn, clearIntervalFn, log,
  });
  const persist = () => loop.persist();

  function inFlightCount(): number {
    return Object.values(state).filter((entry) => entry?.inFlight).length;
  }

  async function finishReview(pr: KeyedPr, verdict: string, summary: string | undefined, wasConflicting: boolean): Promise<void> {
    const entry: PrEntry = state[pr.key] || {};
    entry.phase = core.phaseForVerdict(verdict);
    entry.inFlight = false;
    entry.wasConflicting = wasConflicting;
    entry.reviewedHead = pr.headRefOid;
    if (entry.phase === core.ERROR_PHASE) entry.reason = firstLine(summary || 'review failed');
    if (entry.phase !== core.ERROR_PHASE) delete entry.reason;
    state[pr.key] = entry;
    await persist();
  }

  function spawnWithTimeout(args: Omit<SpawnReviewArgs, 'signal'>, onPending: (pending: Promise<unknown>) => void): Promise<ReviewVerdict> {
    return raceWithAbort<ReviewVerdict>({
      timeoutMs: args.timeoutMs, setTimeoutFn, clearTimeoutFn,
      onTimeout: () => ({ verdict: 'ERROR', summary: 'review timed out' }),
      onEmpty: () => ({ verdict: 'ERROR', summary: 'no verdict' }),
      start: (signal) => {
        const pending = Promise.resolve(spawnReview({ ...args, signal }))
          .catch((error: unknown) => ({ verdict: 'ERROR', summary: firstLine(errorMessage(error)) }));
        onPending(pending);
        return pending;
      },
    });
  }

  async function runReview(project: ReviewProject, pr: KeyedPr): Promise<void> {
    const conflicting = pr.mergeable === 'CONFLICTING';
    let workspace: PrWorkspace | null = null;
    let cwd = project.path;
    if (conflicting) {
      const branches = await gitWorkspace.listWorktreeBranches({ projectPath: project.path });
      if (branches.some((branch) => branch.branch === pr.headRefName)) {
        await finishReview(pr, 'ERROR', 'branch checked out locally, resolve manually', true);
        return;
      }
      const created = await gitWorkspace.create({
        projectPath: project.path, teamId: core.TEAM_REVIEW_LANE_ID, label: `pr-${pr.number}`,
        forkFromHead: true, worktreeBase: getWorktreeBase(project.path),
      });
      if (!created?.isGit) {
        await finishReview(pr, 'ERROR', created?.reason || 'cannot isolate worktree', true);
        return;
      }
      workspace = created;
      cwd = created.cwd;
    }
    let pendingSpawn: Promise<unknown> | null = null;
    try {
      const review = await spawnWithTimeout({
        projectPath: project.path, cwd, pr, slug: project.slug, conflicting,
        timeoutMs: reviewTimeoutSeconds * 1000,
      }, (pending) => { pendingSpawn = pending; });
      await finishReview(pr, review.verdict, review.summary, conflicting);
    } catch (error) {
      await finishReview(pr, 'ERROR', firstLine(errorMessage(error)), conflicting);
    } finally {
      if (workspace) {
        await drainPending(pendingSpawn);
        await gitWorkspace.discard({ projectPath: project.path, workspace });
      }
    }
  }

  function pruneVanished(slug: string, liveKeys: Set<string>): boolean {
    let isDirty = false;
    for (const key of Object.keys(state)) {
      if (!key.startsWith(`${slug}#`) || liveKeys.has(key)) continue;
      delete state[key];
      isDirty = true;
    }
    return isDirty;
  }

  async function tickProject(project: ReviewProject) {
    const listed = await listCandidates(project);
    const raw: KeyedPr[] = listed.map((pr) => ({ ...pr, key: core.prKey(project.slug, pr.number) }));
    const actionable = core.filterActionablePrs(raw, { allowForks: true });
    const isDirty = pruneVanished(project.slug, new Set(raw.map((pr) => pr.key)));
    let slots = maxConcurrentReviews - inFlightCount();
    let started = false;
    for (const pr of core.planReviews(actionable, state)) {
      if (slots <= 0 || loop.isStopped()) break;
      const entry: PrEntry = state[pr.key] || {};
      entry.inFlight = true;
      delete entry.reason;
      state[pr.key] = entry;
      started = true;
      slots -= 1;
      loop.track(runReview(project, pr).catch((error: unknown) => {
        log.warn(`[team-review] review crashed for ${pr.key}: ${errorMessage(error)}`);
      }));
    }
    return {
      dirty: isDirty || started,
      summary: {
        projectId: project.id, name: project.name || project.slug, repoSlug: project.slug,
        lastTickAt: now(),
        prs: actionable.map((pr) => ({
          key: pr.key, number: pr.number, title: pr.title || '',
          url: pr.url || `https://github.com/${project.slug}/pull/${pr.number}`,
          headSha: pr.headRefOid, phase: state[pr.key]?.phase || null,
          inFlight: state[pr.key]?.inFlight === true,
          wasConflicting: state[pr.key]?.wasConflicting === true,
          reason: state[pr.key]?.reason || null,
        })),
      },
    };
  }

  async function runTick(): Promise<TickOutcome | undefined> {
    let isDirty = false;
    let failures = 0;
    const summaries: Record<string, unknown>[] = [];
    for (const project of projects) {
      const outcome = await tickProject(project).catch((error: unknown) => {
        log.warn(`[team-review] tick failed for ${project.id}: ${errorMessage(error)}`);
        failures += 1;
        return null;
      });
      if (!outcome) continue;
      if (outcome.dirty) isDirty = true;
      summaries.push(outcome.summary);
    }
    if (isDirty) await persist();
    onTickComplete({ type: 'team-review-status', ts: now(), projects: summaries });
    if (projects.length > 0 && failures === projects.length) return { failed: true };
    return undefined;
  }

  async function pruneOrphanWorktrees(): Promise<void> {
    for (const project of projects) {
      const branches = await gitWorkspace.listWorktreeBranches({ projectPath: project.path }).catch(() => []);
      for (const branch of branches) {
        if (!branch.branch.startsWith(core.TEAM_REVIEW_BRANCH_PREFIX)) continue;
        await gitWorkspace.removeWorktreeByPath({ projectPath: project.path, cwd: branch.cwd, branch: branch.branch }).catch(() => {});
      }
    }
  }

  async function start(): Promise<void> {
    await loop.start(async () => {
      state = (await readState()) || {};
      for (const entry of Object.values(state)) {
        if (entry) entry.inFlight = false;
      }
      await pruneOrphanWorktrees();
    });
  }

  return { start, stop: loop.stop, tick: loop.tick, _state: () => state };
}

export { createTeamReviewPoller };
export type { KeyedPr, PrEntry, PrGitWorkspace, PrState, ReviewProject, SpawnReviewArgs, TeamReviewCandidate, TeamReviewPollerDependencies };
