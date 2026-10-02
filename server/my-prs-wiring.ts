import { MyPrsStatus } from '../shared/contracts/my-prs.ts';
import type { MyPrMergeRequest, MyPrMergeResult, MyPrsStatus as MyPrsStatusType } from '../shared/contracts/my-prs.ts';
import { myPrMergeRefusal } from '../shared/my-pr-merge.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import * as core from './core/my-prs-core.ts';
import { createLaneRunner } from './lane-runner.ts';
import type { SharedClock } from './lane-runner.ts';
import { createMyPrsPoller } from './my-prs-poller.ts';
import { bootStaggerDelay } from './boot-stagger.ts';
import { createPrGh } from './pr-gh.ts';
import type { PrGh } from './pr-gh.ts';
import { prKey, readTeamReviewSettings } from './core/team-review-core.ts';
import type { TeamReviewSettingsSource } from './core/team-review-core.ts';

type MyPrsPoller = ReturnType<typeof createMyPrsPoller>;
type MyPrsPollerDependencies = Parameters<typeof createMyPrsPoller>[0];
type MyPrMergeOutcome = Omit<MyPrMergeResult, 'key'>;

const MERGE_ERROR_MAX_CHARACTERS = 300;

function firstErrorLine(text: string): string {
  const line = text.split('\n').map((candidate) => candidate.trim()).find(Boolean) ?? 'GitHub refused the merge';
  return line.slice(0, MERGE_ERROR_MAX_CHARACTERS);
}

interface MyPrsWiringOptions {
  config: TeamReviewSettingsSource;
  broadcast: (status: MyPrsStatusType) => void;
  log?: Pick<Console, 'warn'>;
  github?: MyPrsPollerDependencies['github'] & Pick<PrGh, 'mergePr'>;
  createPoller?: (dependencies: MyPrsPollerDependencies) => MyPrsPoller;
  clock?: SharedClock;
}

export function createMyPrsWiring({ config, broadcast, log = console, github = createPrGh(glimmervoidHomeDir()), createPoller = createMyPrsPoller, clock }: MyPrsWiringOptions) {
  const settings = () => readTeamReviewSettings(config);
  const gate = () => core.myPrsShouldStart(settings());
  const emptyStatus = () => {
    const verdict = gate();
    return core.myPrsStatus({ ts: Date.now(), configured: verdict.start, reason: verdict.reason ?? null });
  };
  const runner = createLaneRunner<MyPrsPoller>({
    tag: core.MY_PRS_LANE_ID,
    gate,
    cfgKey: () => JSON.stringify({ enabled: settings().enabled, org: settings().org, autoRebaseMyPrs: settings().autoRebaseMyPrs }),
    emptyStatus,
    broadcast: (status) => {
      const parsed = MyPrsStatus.safeParse(status);
      if (parsed.success) broadcast(parsed.data);
    },
    createPoller: ({ onTickComplete }) => createPoller({
      org: settings().org, shouldAutoRebase: settings().autoRebaseMyPrs, github, log, onTickComplete, clock, firstTickDelayMs: bootStaggerDelay,
    }),
  });
  function getStatus(): MyPrsStatusType {
    const parsed = MyPrsStatus.safeParse(runner.getStatus());
    return parsed.success ? parsed.data : emptyStatus();
  }
  async function refresh() {
    const poller = runner.getPoller();
    if (!poller) return { ok: false, error: 'Reviews polling is not running.' };
    return poller.refresh();
  }

  const mergesInFlight = new Set<string>();
  async function mergePr(request: MyPrMergeRequest): Promise<MyPrMergeOutcome> {
    const key = prKey(request.repo, request.number);
    const poller = runner.getPoller();
    if (!poller) return { ok: false, error: 'My pull requests is not running' };
    if (mergesInFlight.has(key)) return { ok: false, error: 'A merge for this pull request is already running' };
    const tracked = getStatus().prs.find((pr) => pr.key === key);
    const refusal = myPrMergeRefusal(tracked, request.headRefOid);
    if (refusal || !tracked) return { ok: false, error: refusal ?? 'That pull request is not one of your tracked pull requests' };
    mergesInFlight.add(key);
    try {
      const merged = await github.mergePr({ repo: tracked.repo, number: tracked.number, headSha: tracked.headRefOid, method: tracked.mergeMethod });
      if (!merged.ok) {
        log.warn(`[${core.MY_PRS_LANE_ID}] merge of ${key} failed: ${firstErrorLine(merged.err)}`);
        return { ok: false, error: firstErrorLine(merged.err) };
      }
      poller.tick().catch((error: unknown) => log.warn(`[${core.MY_PRS_LANE_ID}] refresh after merging ${key} failed: ${error instanceof Error ? error.message : String(error)}`));
      return { ok: true, kind: merged.kind };
    } finally {
      mergesInFlight.delete(key);
    }
  }
  return { startPoller: runner.startPoller, stopPoller: runner.stopPoller, restartIfConfigChanged: runner.restartIfConfigChanged, getStatus, mergePr, refresh };
}

export type { MyPrMergeOutcome };
