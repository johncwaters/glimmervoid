import { WATCHER_LANE_IDS } from '../../shared/contracts/watcher-link.ts';
import type { ProbeFailure } from '../../shared/contracts/watcher-link.ts';
import type { WatcherChildEndKind, WatcherFailureKind, WatcherTelemetryLane } from '../../shared/contracts/telemetry.ts';

const FAILURE_KIND_BY_STATUS: Readonly<Record<number, WatcherFailureKind>> = { 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 429: 'rate_limited' };
const KNOWN_LANE_IDS: ReadonlySet<string> = new Set(WATCHER_LANE_IDS);

function isTelemetryLane(laneId: string): laneId is (typeof WATCHER_LANE_IDS)[number] {
  return KNOWN_LANE_IDS.has(laneId);
}

function telemetryLaneOf(laneId: string): WatcherTelemetryLane {
  return isTelemetryLane(laneId) ? laneId : 'other';
}

function answerlessFailureKindOf(reason: string): WatcherFailureKind {
  if (reason.startsWith('GraphQL error RATE_LIMITED')) return 'rate_limited';
  if (reason.startsWith('GraphQL error')) return 'graphql_error';
  if (reason.includes('read credential')) return 'no_credential';
  return 'unreachable';
}

function failureKindOf(failure: ProbeFailure): WatcherFailureKind {
  if (failure.status === null) return answerlessFailureKindOf(failure.reason);
  const kindForStatus = FAILURE_KIND_BY_STATUS[failure.status];
  if (kindForStatus !== undefined) return kindForStatus;
  return failure.status >= 500 ? 'server_error' : 'other';
}

function endKindOf(ending: { exitCode: number | null; didFailToStart: boolean }): WatcherChildEndKind {
  if (ending.didFailToStart) return 'failed_to_start';
  return ending.exitCode === 0 ? 'exited' : 'crashed';
}

export { endKindOf, failureKindOf, telemetryLaneOf };
