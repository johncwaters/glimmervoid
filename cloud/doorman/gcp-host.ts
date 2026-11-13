import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { createGcpRest, isRetryableRefusal } from './gcp-rest.ts';
import type { DoormanGcpHost, DoormanTenant } from '../../shared/contracts/doorman.ts';
import { gceWakeAction, isGceSettling } from './doorman-core.ts';
import { clock } from '../../shared/clock.ts';

type HostAdapter = { wake(tenant: DoormanTenant): Promise<void>; stop(tenant: DoormanTenant): Promise<void> };

const COMPUTE_ORIGIN = 'https://compute.googleapis.com';
const SETTLE_POLL_MS = 2000;
const STOPPED_STATUSES: ReadonlySet<string> = new Set(['SUSPENDING', 'SUSPENDED', 'STOPPING', 'STOPPED', 'TERMINATED']);

const GceInstance = z.object({ status: z.string().min(1) });

function createGcpHostAdapter({ fetchFn = fetch, now = clock.nowMs, settleTimeoutMs, settlePollMs = SETTLE_POLL_MS }: {
  fetchFn?: typeof fetch;
  now?: () => number;
  settleTimeoutMs: number;
  settlePollMs?: number;
}): HostAdapter {
  const google = createGcpRest({ fetchFn });

  function computeCall(method: 'GET' | 'POST', url: string, what: string): Promise<unknown> {
    return google.authorizedJson(url, { method }, what);
  }

  function instanceUrlOf(host: DoormanGcpHost): string {
    return `${COMPUTE_ORIGIN}/compute/v1/projects/${host.project}/zones/${host.zone}/instances/${host.instance}`;
  }

  async function readStatus(host: DoormanGcpHost): Promise<string> {
    return GceInstance.parse(await computeCall('GET', instanceUrlOf(host), `reading instance ${host.instance}`)).status;
  }

  async function statusUntil(host: DoormanGcpHost, deadlineMs: number): Promise<string | null> {
    try {
      return await readStatus(host);
    } catch (readError) {
      if (!isRetryableRefusal(readError) || now() >= deadlineMs) throw readError;
      return null;
    }
  }

  async function settledStatus(host: DoormanGcpHost): Promise<string> {
    const deadlineMs = now() + settleTimeoutMs;
    let status = await statusUntil(host, deadlineMs);
    while ((status === null || isGceSettling(status)) && now() < deadlineMs) {
      await sleep(settlePollMs);
      status = await statusUntil(host, deadlineMs);
    }
    if (status === null) throw new Error(`instance ${host.instance} status could not be read`);
    return status;
  }

  async function act(host: DoormanGcpHost, action: 'resume' | 'start' | 'suspend'): Promise<void> {
    await computeCall('POST', `${instanceUrlOf(host)}/${action}`, `${action} of instance ${host.instance}`);
  }

  function hostOf(tenant: DoormanTenant): DoormanGcpHost {
    if (tenant.host === null) throw new Error(`tenant ${tenant.slug} has no host`);
    return tenant.host;
  }

  async function wake(tenant: DoormanTenant): Promise<void> {
    const host = hostOf(tenant);
    const action = gceWakeAction(await settledStatus(host));
    if (action !== null) await act(host, action);
  }

  async function stop(tenant: DoormanTenant): Promise<void> {
    const host = hostOf(tenant);
    const status = await settledStatus(host);
    if (status === 'RUNNING') return act(host, 'suspend');
    if (!STOPPED_STATUSES.has(status)) throw new Error(`instance ${host.instance} is ${status}, so it was not suspended`);
  }

  return { wake, stop };
}

export { createGcpHostAdapter };
export type { HostAdapter };
