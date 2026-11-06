import type { HostStatus } from '#shared/contracts/hosts.ts';

let latestHostStatuses: readonly HostStatus[] = [];

export function applyHostsStatus(hosts: readonly HostStatus[]) {
  latestHostStatuses = [...hosts];
}

export function hostStatuses(): readonly HostStatus[] {
  return latestHostStatuses;
}

export function hostStatusText(status: HostStatus): string {
  if (status.state === 'unreachable' && status.lastError) return `unreachable: ${status.lastError}`;
  if (status.state === 'version-differs') return `version differs: host ${status.hostVersion ?? 'unknown'}, this machine ${status.hubVersion}`;
  return status.state;
}
