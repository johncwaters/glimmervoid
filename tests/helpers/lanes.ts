import type { createBackend } from '../../server/backend/backend.ts';
import type { createUsageWiring } from '../../server/usage/usage-wiring.ts';
import { waitFor } from './wait-for.ts';

type Backend = ReturnType<typeof createBackend>;
type UsageLane = ReturnType<typeof createUsageWiring>;

function usageLane(backend: Backend): UsageLane {
  return backend.getLane('usage');
}

async function settleBackendShutdown(backend: Backend): Promise<void> {
  const settled = backend.shutdown();
  await Promise.allSettled([...settled.reaps, ...settled.stoppers.map((entry) => entry.promise)]);
}

async function agentIngressBase(backend: Backend): Promise<string> {
  await waitFor(() => backend.hookPort() !== null, 'the agent ingress listener is bound');
  return `http://127.0.0.1:${backend.hookPort()}`;
}

export {
  agentIngressBase, settleBackendShutdown, usageLane,
};
export type {
  Backend, UsageLane,
};
