import { PacksStatus } from '#shared/contracts/control/pack-messages.ts';
import { describeSchemaIssues } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';

let latestPacksStatus: PacksStatus | null = null;
const listeners = new Set<() => void>();

export function packsSnapshot(): PacksStatus | null {
  return latestPacksStatus;
}

export function subscribePacks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applyPacksStatus(message: unknown): void {
  const parsed = PacksStatus.safeParse(message);
  if (!parsed.success) {
    reportToServerLog('settings', `dropped packs-status: ${describeSchemaIssues(parsed.error.issues)}`);
    return;
  }
  latestPacksStatus = parsed.data;
  for (const listener of listeners) listener();
}
