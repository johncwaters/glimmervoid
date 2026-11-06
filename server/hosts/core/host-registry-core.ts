import { HostEntry } from '../../../shared/contracts/hosts.ts';

const LOOPBACK_TARGET_RE = /^(?:[^@]*@)?(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i;

type HostRegistryChange = { ok: true; hosts: HostEntry[] } | { ok: false; error: string };

function addHostTo(hosts: readonly HostEntry[], candidate: unknown): HostRegistryChange {
  const parsed = HostEntry.safeParse(candidate);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') };
  const host = parsed.data;
  if (LOOPBACK_TARGET_RE.test(host.sshTarget)) return { ok: false, error: `host sshTarget ${host.sshTarget} is this machine; link another machine` };
  if (hosts.some((registered) => registered.id === host.id)) return { ok: false, error: `a host with id ${host.id} is already registered` };
  return { ok: true, hosts: [...hosts, host] };
}

function removeHostFrom(hosts: readonly HostEntry[], hostId: string): HostRegistryChange {
  if (!hosts.some((registered) => registered.id === hostId)) return { ok: false, error: `no host with id ${hostId} is registered` };
  return { ok: true, hosts: hosts.filter((registered) => registered.id !== hostId) };
}

function isSameHostEntry(left: HostEntry, right: HostEntry): boolean {
  return left.name === right.name && left.sshTarget === right.sshTarget && left.dashboardPort === right.dashboardPort;
}

export { addHostTo, isSameHostEntry, removeHostFrom };
export type { HostRegistryChange };
