import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

type TimerClass = { watcherBackedBy: string } | { awakeOnly: string };

const TIMER_CLASS_BY_FILE: Record<string, TimerClass> = {
  'server/github/github-clock.ts': { watcherBackedBy: 'githubStore' },
  'server/github/my-prs-poller.ts': { watcherBackedBy: 'githubStore' },
  'server/github/team-review-poller.ts': { watcherBackedBy: 'githubStore' },
  'server/workflows-poller.ts': { watcherBackedBy: 'githubStore' },
  'server/github/issues-poller.ts': { watcherBackedBy: 'issues' },
  'server/radar/radar-poller.ts': { watcherBackedBy: 'posthog' },
  'server/community/community-poller.ts': { watcherBackedBy: 'community' },
  'server/lanes/lane-runner.ts': { awakeOnly: 'the shared tick loop; each lane that starts one is classified in its own file' },
  'server/branch-gc-poller.ts': { awakeOnly: 'housekeeping git fetch; nothing the operator acts on while the host sleeps' },
  'server/coder-activity-poller.ts': { awakeOnly: 'reports this host\'s own running sessions' },
  'server/coder/coder-env-poller.ts': { awakeOnly: 'reads this host\'s own coder environment' },
  'server/usage/usage-wiring.ts': { awakeOnly: 'scans local transcripts and pricing for a view read on an open dashboard' },
  'server/backend/backend-update.ts': { awakeOnly: 'update recheck runs only while a dashboard is connected' },
  'server/backend/backend-health.ts': { awakeOnly: 'local git context and health snapshots for connected dashboards' },
  'server/changes-watch.ts': { awakeOnly: 'local worktree changes for the session a dashboard is watching' },
  'server/awake-timer.ts': { awakeOnly: 'counts awake time; reads nothing outside' },
  'server/idle-stop-wiring.ts': { awakeOnly: 'decides when to ask the doorman to stop this host' },
  'server/awake-usage-wiring.ts': { awakeOnly: 'reads this host\'s awake hours from its doorman; asleep, no hours accrue' },
  'server/telemetry.ts': { awakeOnly: 'flushes usage data out; reads nothing to act on' },
  'server/outcomes-wiring.ts': { awakeOnly: 'summarizes local event loop and outcome counters' },
  'server/pairings-store.ts': { awakeOnly: 'reloads a local file' },
  'server/trace-wiring.ts': { awakeOnly: 'prunes local trace files' },
  'server/uploads-wiring.ts': { awakeOnly: 'prunes local uploads' },
  'server/race/race-wiring.ts': { awakeOnly: 'judges local races that only run while awake' },
  'server/secrets/vault-socket.ts': { awakeOnly: 'heartbeat to a connected vault companion' },
  'server/ws-heartbeat.ts': { awakeOnly: 'pings connected dashboard sockets' },
  'server/packs/core/pack-preview-core.ts': { awakeOnly: 'browser script text for a pack preview page, not a server timer' },
};

const startsTimer = /\bsetInterval(?:Fn)?\(|\bcreateTickLoop\(/;

const directRegistration = /registerProbeSource\(\s*(?:\{\s*\.\.\.)?laneAssembly\.(\w+)\.probeSource\b/g;
const loopRegistration = /for \(const (\w+) of \[([^\]]*)\]\)\s*\{\s*watcherLink\.registerProbeSource\(\1\.probeSource\)/g;

function laneKeysWithRegisteredProbeSource(backendSource: string): Set<string> {
  const laneKeys = new Set([...backendSource.matchAll(directRegistration)].map(([, laneKey]) => laneKey));
  for (const [, , laneList] of backendSource.matchAll(loopRegistration)) {
    for (const [, laneKey] of laneList.matchAll(/\blaneAssembly\.(\w+)\b/g)) laneKeys.add(laneKey);
  }
  return laneKeys;
}

test('every server timer is classified as watcher-backed or awake-only', () => {
  const timerFiles = trackedFiles(/^server\/.+\.ts$/).filter((repoPath) => !repoPath.endsWith('.test.ts') && startsTimer.test(readTracked(repoPath)));
  const unclassifiedFiles = timerFiles.filter((repoPath) => !Object.hasOwn(TIMER_CLASS_BY_FILE, repoPath));
  assert.deepEqual(unclassifiedFiles, [], 'each file that starts an interval or tick loop needs a TIMER_CLASS_BY_FILE entry: watcherBackedBy, the laneAssembly key whose probe source lets a sleeping host hear the change, or awakeOnly, why missing it while asleep is fine');
  const staleEntries = Object.keys(TIMER_CLASS_BY_FILE).filter((repoPath) => !timerFiles.includes(repoPath));
  assert.deepEqual(staleEntries, [], 'these TIMER_CLASS_BY_FILE entries start no timer any more; delete them');
});

test('every watcher-backed timer names a lane whose probe source the backend registers', () => {
  const registeredLaneKeys = laneKeysWithRegisteredProbeSource(readTracked('server/backend/backend.ts'));
  assert.ok(registeredLaneKeys.size > 0, 'server/backend/backend.ts registers no watcher probe source');
  const unregisteredLanes = Object.values(TIMER_CLASS_BY_FILE)
    .flatMap((timerClass) => 'watcherBackedBy' in timerClass ? [timerClass.watcherBackedBy] : [])
    .filter((laneKey) => !registeredLaneKeys.has(laneKey));
  assert.deepEqual(unregisteredLanes, []);
});
