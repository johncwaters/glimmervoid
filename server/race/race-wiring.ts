import { randomUUID } from 'node:crypto';

import type { RaceContestant, RaceRecord, RaceSpec } from '../../shared/contracts/race.ts';
import { errorMessage } from '../../shared/text.ts';
import type { RaceStore } from './race-store.ts';

type ContestantLaunch = (contestant: RaceContestant, race: { raceId: string; startSha: string }) => { ok: true; sessionId: string } | { ok: false; error: string };

interface RaceStartPoint {
  startSha: string;
  baseBranch: string;
}

interface RaceGit {
  fetchOrigin: (args: { projectPath: string }) => Promise<{ ok: boolean }>;
  listIntegrationTips: (args: { projectPath: string; integrationBranch: string | null }) => Promise<{ ok: boolean } | { ok: true; integrationTips: { branch: string; sha: string | null }[] }>;
}

interface RaceWiringDependencies {
  store: RaceStore;
  git: RaceGit;
  integrationBranch: () => string | null;
  broadcast: (frame: { type: 'race-status'; races: RaceRecord[] }) => void;
  log: Pick<Console, 'log' | 'warn'>;
  now?: () => number;
}

function createRaceWiring({ store, git, integrationBranch, broadcast, log, now = Date.now }: RaceWiringDependencies) {
  const raceById = new Map<string, RaceRecord>();

  function status(): { type: 'race-status'; races: RaceRecord[] } {
    return { type: 'race-status', races: [...raceById.values()].sort((left, right) => right.createdAt - left.createdAt) };
  }

  async function loadRaces(raceIds: readonly string[]): Promise<void> {
    for (const raceId of raceIds) {
      const record = await store.read(raceId);
      if (record) raceById.set(record.id, record);
    }
    if (raceById.size > 0) broadcast(status());
  }

  async function resolveStartPoint(repoPath: string): Promise<RaceStartPoint | null> {
    const fetched = await git.fetchOrigin({ projectPath: repoPath });
    if (!fetched.ok) log.warn(`[race] fetching origin in ${repoPath} failed; starting from the local integration branch`);
    const tips = await git.listIntegrationTips({ projectPath: repoPath, integrationBranch: integrationBranch() });
    const tip = 'integrationTips' in tips ? tips.integrationTips[0] : null;
    if (!tip?.sha) return null;
    return { startSha: tip.sha, baseBranch: tip.branch };
  }

  async function saveRecord(record: RaceRecord): Promise<string | null> {
    try {
      await store.write(record);
      return null;
    } catch (error) {
      log.warn(`[race] could not save race ${record.id}: ${errorMessage(error)}`);
      return errorMessage(error);
    }
  }

  async function start(spec: RaceSpec, launch: ContestantLaunch): Promise<{ ok: true; raceId: string; error: string | null } | { ok: false; error: string }> {
    const startPoint = await resolveStartPoint(spec.repoPath);
    if (!startPoint) return { ok: false, error: `Could not find the integration branch of ${spec.repoPath}.` };
    const raceId = randomUUID();
    const sessionIdByContestant: Record<string, string> = {};
    const savedBeforeLaunch = await saveRecord({ id: raceId, spec, ...startPoint, createdAt: now(), sessionIdByContestant });
    if (savedBeforeLaunch !== null) return { ok: false, error: `Could not save the race, so no contestant started: ${savedBeforeLaunch}` };
    const failures: string[] = [];
    for (const contestant of spec.contestants) {
      const launched = launch(contestant, { raceId, startSha: startPoint.startSha });
      if (launched.ok) sessionIdByContestant[contestant.id] = launched.sessionId;
      if (!launched.ok) failures.push(`${contestant.label}: ${launched.error}`);
    }
    if (Object.keys(sessionIdByContestant).length === 0) return { ok: false, error: failures.join(' ') };
    const record: RaceRecord = { id: raceId, spec, ...startPoint, createdAt: now(), sessionIdByContestant };
    raceById.set(raceId, record);
    const savedAfterLaunch = await saveRecord(record);
    if (savedAfterLaunch !== null) failures.push(`(the race file could not be updated: ${savedAfterLaunch})`);
    broadcast(status());
    log.log(`[race] started ${spec.title} with ${Object.keys(sessionIdByContestant).length} contestants from ${startPoint.baseBranch} at ${startPoint.startSha}`);
    return { ok: true, raceId, error: failures.length > 0 ? `Started with problems: ${failures.join(' ')}` : null };
  }

  return { status, loadRaces, start };
}

type RaceWiring = ReturnType<typeof createRaceWiring>;

export { createRaceWiring };
export type { RaceWiring };
