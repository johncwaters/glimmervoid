import { MyPrsStatus } from '../shared/contracts/my-prs.ts';
import type { MyPrsStatus as MyPrsStatusType } from '../shared/contracts/my-prs.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import * as core from './core/my-prs-core.ts';
import { createLaneRunner } from './lane-runner.ts';
import { createMyPrsPoller } from './my-prs-poller.ts';
import { createPrGh } from './pr-gh.ts';
import { readTeamReviewSettings } from './core/team-review-core.ts';
import type { TeamReviewSettingsSource } from './core/team-review-core.ts';

type MyPrsPoller = ReturnType<typeof createMyPrsPoller>;
type MyPrsPollerDependencies = Parameters<typeof createMyPrsPoller>[0];

interface MyPrsWiringOptions {
  config: TeamReviewSettingsSource;
  broadcast: (status: MyPrsStatusType) => void;
  log?: Pick<Console, 'warn'>;
  github?: MyPrsPollerDependencies['github'];
  createPoller?: (dependencies: MyPrsPollerDependencies) => MyPrsPoller;
}

export function createMyPrsWiring({ config, broadcast, log = console, github = createPrGh(glimmervoidHomeDir()), createPoller = createMyPrsPoller }: MyPrsWiringOptions) {
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
      org: settings().org, shouldAutoRebase: settings().autoRebaseMyPrs, github, log, onTickComplete,
    }),
  });
  function getStatus(): MyPrsStatusType {
    const parsed = MyPrsStatus.safeParse(runner.getStatus());
    return parsed.success ? parsed.data : emptyStatus();
  }
  return { startPoller: runner.startPoller, stopPoller: runner.stopPoller, restartIfConfigChanged: runner.restartIfConfigChanged, getStatus };
}
