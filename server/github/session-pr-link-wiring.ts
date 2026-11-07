import type { EventEmitter } from 'node:events';
import type { LinkedPr, SessionPrLinks } from '../../shared/contracts/my-prs.ts';
import { comparablePrKey } from '../../shared/contracts/github-prs.ts';
import type { GithubLaneStore } from './github-store-wiring.ts';
import { runGit } from '../git/git-exec.ts';
import { githubRepoSlugFromRemote } from './core/team-review-core.ts';
import {
  candidatesForRepo, commitsAheadArgs, distinctBaseRefNames, hookPrLink, openPrCandidatesByRepo,
  parseRevListShas, partitionByCommitsAhead, shaPrLink, shouldLinkSession, shouldRefreshHookPrs,
} from '../core/session-pr-link-core.ts';
import type { CommitsAheadOfBase, PrLinkSession, ShaJoinCandidate } from '../core/session-pr-link-core.ts';

interface PrLinkableSession extends PrLinkSession, Pick<EventEmitter, 'on' | 'off'> {
  path: string;
  readonly worktreeDir: string | null;
  readonly isWorkspace: boolean;
  readonly linkedPrs: readonly LinkedPr[];
  linkPr(link: LinkedPr): void;
}

interface HookEventNotice {
  event: string;
  payload: Record<string, unknown>;
}

interface ShaJoinGit {
  originUrl(args: { projectPath: string }): Promise<string | null>;
  isAncestor(args: { projectPath: string; ancestorSha: string; descendantSha: string }): Promise<{ ok: boolean; isAncestor: boolean }>;
}

interface SessionPrLinkWiringOptions {
  store: Pick<GithubLaneStore, 'setWatchedKeys' | 'getSnapshot' | 'requestRefresh'> & {
    subscribe(event: 'snapshot-changed', listener: () => void): () => void;
  };
  now?: () => number;
  git?: ShaJoinGit;
  log?: Pick<Console, 'warn'>;
}

interface ShaJoinRun {
  pendingCandidates: Map<string, ShaJoinCandidate[]> | null;
  settled: Promise<void>;
}

const REV_LIST_TIMEOUT_MS = 20_000;
const REV_LIST_MAX_BUFFER = 16 * 1024 * 1024;

async function listCommitsAhead(projectPath: string, baseRefName: string): Promise<string[] | null> {
  const revList = await runGit(commitsAheadArgs(baseRefName), { cwd: projectPath, timeoutMs: REV_LIST_TIMEOUT_MS, maxBuffer: REV_LIST_MAX_BUFFER });
  return revList.ok ? parseRevListShas(revList.out) : null;
}

function createSessionPrLinkWiring({ store, now = Date.now, git, log = console }: SessionPrLinkWiringOptions) {
  const attachedSessions = new WeakSet<PrLinkableSession>();
  const joinableSessions = new Set<PrLinkableSession>();
  const repoSlugBySession = new WeakMap<PrLinkableSession, Promise<string | null>>();
  const joinRunBySession = new Map<PrLinkableSession, ShaJoinRun>();
  const linkedKeysBySession = new WeakMap<PrLinkableSession, Set<string>>();
  const linkCountByKey = new Map<string, number>();

  function updateSessionLinks(session: PrLinkableSession, links: readonly LinkedPr[]): void {
    const previousKeys = linkedKeysBySession.get(session) ?? new Set<string>();
    const nextKeys = new Set(links.map(comparablePrKey));
    const addedKeys = [...nextKeys].filter((key) => !previousKeys.has(key));
    let hasWatchChanges = false;
    for (const key of previousKeys) {
      if (nextKeys.has(key)) continue;
      const remainingLinks = (linkCountByKey.get(key) ?? 1) - 1;
      if (remainingLinks > 0) {
        linkCountByKey.set(key, remainingLinks);
        continue;
      }
      linkCountByKey.delete(key);
      hasWatchChanges = true;
    }
    for (const key of addedKeys) {
      const previousCount = linkCountByKey.get(key) ?? 0;
      linkCountByKey.set(key, previousCount + 1);
      if (previousCount === 0) hasWatchChanges = true;
    }
    linkedKeysBySession.set(session, nextKeys);
    if (hasWatchChanges) store.setWatchedKeys('session-links', [...linkCountByKey.keys()]);
    for (const key of addedKeys) store.requestRefresh(key);
  }

  function attachSession(session: PrLinkableSession): void {
    if (attachedSessions.has(session) || !shouldLinkSession(session)) return;
    attachedSessions.add(session);
    joinableSessions.add(session);
    function onHookEvent({ event, payload }: HookEventNotice): void {
      const link = hookPrLink(event, payload, now());
      if (link) session.linkPr(link);
      if (!shouldRefreshHookPrs(event, payload)) return;
      const keys = new Set(session.linkedPrs.map(comparablePrKey));
      if (link) keys.add(comparablePrKey(link));
      for (const key of keys) store.requestRefresh(key);
    }
    function onPrLinksChange({ links }: SessionPrLinks): void {
      updateSessionLinks(session, links);
    }
    function detach(): void {
      joinableSessions.delete(session);
      updateSessionLinks(session, []);
      linkedKeysBySession.delete(session);
      session.off('hook-event', onHookEvent);
      session.off('pr-links-change', onPrLinksChange);
      session.off('teardown', detach);
    }
    session.on('hook-event', onHookEvent);
    session.on('pr-links-change', onPrLinksChange);
    session.on('teardown', detach);
    updateSessionLinks(session, session.linkedPrs);
  }

  function repoSlugFor(session: PrLinkableSession, projectPath: string, shaJoinGit: ShaJoinGit): Promise<string | null> {
    const cached = repoSlugBySession.get(session);
    if (cached) return cached;
    const resolving = shaJoinGit.originUrl({ projectPath })
      .then((remoteUrl) => remoteUrl ? githubRepoSlugFromRemote(remoteUrl) : null)
      .catch(() => null);
    repoSlugBySession.set(session, resolving);
    return resolving;
  }

  function linkBySha(session: PrLinkableSession, candidate: ShaJoinCandidate): void {
    if (!joinableSessions.has(session)) return;
    const link = shaPrLink(candidate, now());
    if (link) session.linkPr(link);
  }

  async function joinSession(session: PrLinkableSession, candidatesByRepo: Map<string, ShaJoinCandidate[]>, shaJoinGit: ShaJoinGit): Promise<void> {
    if (session.isWorkspace || !joinableSessions.has(session)) return;
    const projectPath = session.worktreeDir ?? session.path;
    const candidates = candidatesForRepo(candidatesByRepo, await repoSlugFor(session, projectPath, shaJoinGit));
    if (candidates.length === 0) return;
    const commitsAhead: CommitsAheadOfBase[] = [];
    for (const baseRefName of distinctBaseRefNames(candidates)) {
      const commitShas = await listCommitsAhead(projectPath, baseRefName);
      if (commitShas) commitsAhead.push({ baseRefName, commitShas });
    }
    const { matched, unmatched } = partitionByCommitsAhead(candidates, commitsAhead);
    for (const candidate of matched) linkBySha(session, candidate);
    for (const candidate of unmatched) {
      const ancestry = await shaJoinGit.isAncestor({ projectPath, ancestorSha: 'HEAD', descendantSha: candidate.headRefOid });
      if (ancestry.ok && ancestry.isAncestor) linkBySha(session, candidate);
    }
  }

  async function drainJoinRun(session: PrLinkableSession, firstCandidates: Map<string, ShaJoinCandidate[]>, run: ShaJoinRun, shaJoinGit: ShaJoinGit): Promise<void> {
    let candidatesByRepo: Map<string, ShaJoinCandidate[]> | null = firstCandidates;
    while (candidatesByRepo) {
      await joinSession(session, candidatesByRepo, shaJoinGit)
        .catch((error: unknown) => log.warn(`[session-pr-link] SHA join failed: ${error instanceof Error ? error.message : String(error)}`));
      candidatesByRepo = run.pendingCandidates;
      run.pendingCandidates = null;
    }
    joinRunBySession.delete(session);
  }

  function scheduleJoin(session: PrLinkableSession, candidatesByRepo: Map<string, ShaJoinCandidate[]>, shaJoinGit: ShaJoinGit): Promise<void> {
    const activeRun = joinRunBySession.get(session);
    if (activeRun) {
      activeRun.pendingCandidates = candidatesByRepo;
      return activeRun.settled;
    }
    const run: ShaJoinRun = { pendingCandidates: null, settled: Promise.resolve() };
    joinRunBySession.set(session, run);
    run.settled = drainJoinRun(session, candidatesByRepo, run, shaJoinGit);
    return run.settled;
  }

  async function onSnapshotChanged(): Promise<void> {
    const snapshot = store.getSnapshot();
    const watch = snapshot.watches['my-prs-open'];
    if (!git || !watch?.isLoaded || snapshot.freshness.error !== null) return;
    const prs = watch.keys.flatMap((key) => snapshot.prs[key] ? [snapshot.prs[key]] : []);
    const candidatesByRepo = openPrCandidatesByRepo(prs);
    if (candidatesByRepo.size === 0) return;
    await Promise.all([...joinableSessions].map((session) => scheduleJoin(session, candidatesByRepo, git)));
  }

  store.subscribe('snapshot-changed', onSnapshotChanged);

  return { attachSession };
}

export { createSessionPrLinkWiring };
