import type { WatcheeJobKind, WatcherJobPayload } from '../../shared/contracts/watcher-jobs.ts';
import type { WatcheeSettingsFile } from '../../shared/contracts/watchee-settings.ts';

type WatcheeTrigger =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'push'; source: 'github-app' };

type WatcheeGate = { run: true } | { run: false; reason: string };

type DetectOutcome<Kind extends WatcheeJobKind> =
  | { ok: true; events: WatcherJobPayload<Kind>[] }
  | { ok: false; reason: string; retryAfterMs?: number };

interface WatcheeContext {
  watcherHome: string;
  now: () => number;
  log: Pick<Console, 'log' | 'warn'>;
}

interface WatcheeDetector<Kind extends WatcheeJobKind> {
  detect(settings: WatcheeSettingsFile): Promise<DetectOutcome<Kind>>;
  stop(): void;
}

interface Watchee<Kind extends WatcheeJobKind> {
  kind: Kind;
  laneId: string;
  trigger(settings: WatcheeSettingsFile): WatcheeTrigger;
  gate(settings: WatcheeSettingsFile): WatcheeGate;
  start(context: WatcheeContext): WatcheeDetector<Kind>;
  eventKey(payload: WatcherJobPayload<Kind>, intervalStartMs: number): string;
}

type WatcheeRegistry = { [Kind in WatcheeJobKind]: Watchee<Kind> };

export type { DetectOutcome, Watchee, WatcheeContext, WatcheeDetector, WatcheeGate, WatcheeRegistry, WatcheeTrigger };
