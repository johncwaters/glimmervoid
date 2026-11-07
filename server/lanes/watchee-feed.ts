import { startAwakeStopwatch } from '../awake-timer.ts';
import { isOlderObservation } from './core/watchee-feed-core.ts';
import type { Observation } from './core/watchee-feed-core.ts';

interface WatcheeFeed<Payload extends Observation> {
  accept: (payload: Payload) => boolean;
  latest: () => Payload | null;
  silenceMs: () => number;
  stop: () => void;
}

function createWatcheeFeed<Payload extends Observation>(): WatcheeFeed<Payload> {
  let latestPayload: Payload | null = null;
  let silenceStopwatch = startAwakeStopwatch();

  function accept(payload: Payload): boolean {
    silenceStopwatch.stop();
    silenceStopwatch = startAwakeStopwatch();
    if (isOlderObservation(payload, latestPayload)) return false;
    latestPayload = payload;
    return true;
  }

  return {
    accept,
    latest: () => latestPayload,
    silenceMs: () => silenceStopwatch.awakeElapsedMs(),
    stop: () => silenceStopwatch.stop(),
  };
}

export { createWatcheeFeed };
