import { clock } from '../../shared/clock.ts';
interface LaneGate {
  start: boolean;
  reason?: string | null;
}

type EmptyLaneStatus = {
  type: string;
  ts: number;
  configured: boolean;
  reason: string | null | undefined;
  projects: unknown[];
};

function emptyLaneStatus(type: string, gate: LaneGate): EmptyLaneStatus {
  return { type, ts: clock.nowMs(), configured: gate.start, reason: gate.reason, projects: [] };
}

export { emptyLaneStatus };
