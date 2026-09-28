import type { createBackend } from '../../server/backend.ts';
import type { createIngestLane } from '../../server/ingest-wiring.ts';
import type { createUsageWiring } from '../../server/usage-wiring.ts';
import type { createVisionsWiring } from '../../server/visions-wiring.ts';

type Backend = ReturnType<typeof createBackend>;
type IngestLane = ReturnType<typeof createIngestLane>;
type UsageLane = ReturnType<typeof createUsageWiring>;
type VisionsLane = ReturnType<typeof createVisionsWiring>;

function ingestLane(backend: Backend): IngestLane | null {
  return backend.getLane('ingest');
}

function usageLane(backend: Backend): UsageLane {
  return backend.getLane('usage');
}

function visionsLane(backend: Backend): VisionsLane | null {
  return backend.getLane('visions');
}

export {
  ingestLane, usageLane, visionsLane,
};
export type {
  Backend, IngestLane, UsageLane, VisionsLane,
};
