import path from 'node:path';
import { IssueKey, IssuesState } from '../shared/contracts/issues.ts';
import type { CachedIssueRow, IssuesStatus as IssuesStatusType } from '../shared/contracts/issues.ts';
import type { ReviewsRefreshResult } from '../shared/contracts/reviews.ts';
import type { GlimmervoidConfig } from './config-store.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import * as core from './core/issues-core.ts';
import { readGithubTeams } from './core/github-teams-core.ts';
import { createIssuesPoller } from './issues-poller.ts';
import { createLaneRunner } from './lane-runner.ts';
import type { SharedClock } from './lane-runner.ts';
import { createJsonStateStore } from './json-file.ts';
import { bootStaggerDelay } from './boot-stagger.ts';
import { createPrGh } from './pr-gh.ts';
import type { PrGh } from './pr-gh.ts';
import type { createGitWorkspace } from './git-workspace.ts';
import { errorMessage } from '../shared/text.ts';
import { createSerialQueue } from './spawn-gate.ts';

export function createIssuesStateIo(statePath: string, log: Pick<Console, 'warn'>) {
  let loaded = core.emptyIssuesState();
  let hasLoaded = false;
  const store = createJsonStateStore({
    name: 'issues cache', filePath: statePath,
    parse: (raw) => IssuesState.safeParse(raw).data ?? null,
    adopt: (state) => { loaded = state ?? core.emptyIssuesState(); hasLoaded = true; },
    warn: (message, fields) => log.warn(`[issues] ${message} ${JSON.stringify(fields)}`),
  });
  return {
    async readState() { await store.load(); return loaded; },
    isLoaded: () => hasLoaded,
    async writeState(state: IssuesState) {
      const parsed = IssuesState.parse(state);
      await store.write(parsed, () => `${JSON.stringify(parsed, null, 2)}\n`);
      loaded = parsed;
    },
  };
}

interface IssuesWiringOptions {
  config: GlimmervoidConfig;
  gitWorkspace: Pick<ReturnType<typeof createGitWorkspace>, 'originUrl'>;
  broadcast: (status: IssuesStatusType) => void;
  hasSession: (id: string) => boolean;
  github?: Pick<PrGh, 'viewer' | 'searchIssues' | 'listRepoIssues' | 'issueLinkedPullRequests' | 'rateLimitWaitMs'>;
  homeDir?: string;
  clock?: SharedClock;
  log?: Pick<Console, 'warn'>;
}

export function createIssuesWiring({ config, gitWorkspace, broadcast, hasSession, homeDir = glimmervoidHomeDir(), github = createPrGh(homeDir), clock, log = console }: IssuesWiringOptions) {
  const stateIo = createIssuesStateIo(path.join(homeDir, core.ISSUES_STATE_FILENAME), log);
  const teams = () => readGithubTeams(config).map((team) => `${team.org}/${team.slug}`);
  let cachedState = core.emptyIssuesState();
  let stateLoad: Promise<void> | null = null;
  let hasLoadedState = false;
  let hasWritesBeforeLoad = false;
  const stateWrites = createSerialQueue();
  function pruneSessionLinks(): Record<string, string> {
    const sessionIds = new Set(Object.values(cachedState.sessionLinks).filter(hasSession));
    cachedState = { ...cachedState, sessionLinks: core.pruneIssueSessionLinks(cachedState.sessionLinks, sessionIds) };
    return cachedState.sessionLinks;
  }
  function adoptLoadedState(loaded: IssuesState): Promise<void> {
    hasLoadedState = true;
    if (!hasWritesBeforeLoad) {
      cachedState = loaded;
      return Promise.resolve();
    }
    cachedState = { ...cachedState, sessionLinks: { ...loaded.sessionLinks, ...cachedState.sessionLinks } };
    return writeState(cachedState);
  }
  function loadState(): Promise<void> {
    if (hasLoadedState) return Promise.resolve();
    stateLoad ??= stateIo.readState().then((loaded) => {
      stateLoad = null;
      if (!stateIo.isLoaded()) return;
      return adoptLoadedState(loaded);
    });
    return stateLoad;
  }
  function writeState(state: IssuesState): Promise<void> {
    if (!hasLoadedState) hasWritesBeforeLoad = true;
    cachedState = { ...state, sessionLinks: pruneSessionLinks() };
    const snapshot = cachedState;
    return stateWrites.run(() => stateIo.writeState(snapshot));
  }
  const emptyStatus = () => core.issuesStatus({ ts: Date.now(), ...core.issuesCachedSourcesGate(cachedState.issues, teams()), issues: cachedState.issues, sessionLinks: pruneSessionLinks(), lastSyncAt: cachedState.lastSyncAt });
  let pollerStatus: IssuesStatusType | null = null;
  const currentStatus = () => core.issuesStatus({ ...(pollerStatus ?? emptyStatus()), sessionLinks: pruneSessionLinks() });

  async function lookupOriginUrls(repoPaths: readonly string[]): Promise<Map<string, string | null>> {
    const originUrlByRepoPath = new Map<string, string | null>();
    for (const repoPath of repoPaths) {
      if (originUrlByRepoPath.has(repoPath)) continue;
      originUrlByRepoPath.set(repoPath, await gitWorkspace.originUrl({ projectPath: path.resolve(repoPath) }));
    }
    return originUrlByRepoPath;
  }

  async function resolveProjects(cachedIssues: readonly CachedIssueRow[]): Promise<core.IssuesProjectRepo[]> {
    const repoPaths = config.projects.filter((project) => project.id).flatMap(core.issuesRepoPaths);
    return core.resolveIssuesProjects(config.projects, await lookupOriginUrls(repoPaths), cachedIssues);
  }

  async function projectRepoSlugs(projectId: string): Promise<string[]> {
    const project = config.projects.find((candidate) => candidate.id === projectId);
    if (!project) return [];
    const repoPaths = [project.path, ...core.issuesRepoPaths(project)];
    const memberProject = { id: projectId, path: project.path, repos: repoPaths };
    return core.resolveIssuesProjects([memberProject], await lookupOriginUrls(repoPaths), []).map((entry) => entry.repo);
  }

  const runner = createLaneRunner({
    tag: core.ISSUES_LANE_ID, gate: () => ({ start: true }),
    cfgKey: () => JSON.stringify({ projects: config.projects.map((project) => ({ id: project.id, path: project.path, repos: project.repos })), teams: teams() }),
    emptyStatus, broadcast: () => broadcast(currentStatus()),
    createPoller: ({ onTickComplete }) => createIssuesPoller({
      teams: teams(), resolveProjects, github, clock, log, firstTickDelayMs: bootStaggerDelay,
      onTickComplete: (status) => { pollerStatus = status; onTickComplete(status); },
      getSessionLinks: pruneSessionLinks,
      readState: async () => { await loadState(); return cachedState; }, writeState,
    }),
  });
  async function refresh(): Promise<ReviewsRefreshResult> {
    const poller = runner.getPoller();
    if (!poller) return { ok: false, error: 'Issues polling is not running.' };
    return poller.refresh();
  }
  async function startPoller(): Promise<void> {
    try {
      await loadState();
      runner.startPoller();
    } catch (error: unknown) {
      log.warn(`[issues] cache load failed: ${errorMessage(error)}`);
    }
  }
  async function getLinkedSessionId(issueKey: string): Promise<string | null> {
    await loadState();
    return pruneSessionLinks()[issueKey.toLowerCase()] ?? null;
  }
  async function linkSession(issueKey: string, sessionId: string): Promise<void> {
    const key = IssueKey.parse(issueKey).toLowerCase();
    await loadState();
    const currentLinks = pruneSessionLinks();
    cachedState = { ...cachedState, sessionLinks: { ...currentLinks, [key]: sessionId } };
    const saved = writeState(cachedState);
    broadcast(currentStatus());
    await saved;
  }
  async function stopPoller(): Promise<void> {
    await runner.stopPoller();
    await stateWrites.idle();
  }
  return {
    startPoller, stopPoller, restartIfConfigChanged: runner.restartIfConfigChanged,
    getStatus: currentStatus, refresh, projectRepoSlugs, getLinkedSessionId, linkSession,
  };
}
