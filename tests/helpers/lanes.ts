import type { createBackend } from '../../server/backend/backend.ts';
import type { createUsageWiring } from '../../server/usage/usage-wiring.ts';

type Backend = ReturnType<typeof createBackend>;
type UsageLane = ReturnType<typeof createUsageWiring>;

function usageLane(backend: Backend): UsageLane {
  return backend.getLane('usage');
}

async function settleBackendShutdown(backend: Backend): Promise<void> {
  const settled = backend.shutdown();
  await Promise.allSettled([...settled.reaps, ...settled.stoppers.map((entry) => entry.promise)]);
}

export {
  settleBackendShutdown, usageLane,
};
export type {
  Backend, UsageLane,
};
