import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { DoormanGcpHost, DoormanTenant } from '../../shared/contracts/doorman.ts';
import { gceWakeAction, isGceSettling } from './doorman-core.ts';
import { clock } from '../../shared/clock.ts';

type HostAdapter = { wake(tenant: DoormanTenant): Promise<void>; stop(tenant: DoormanTenant): Promise<void> };

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const COMPUTE_ORIGIN = 'https://compute.googleapis.com';
const REQUEST_TIMEOUT_MS = 15_000;
const SETTLE_POLL_MS = 2000;
const STOPPED_STATUSES: ReadonlySet<string> = new Set(['SUSPENDING', 'SUSPENDED', 'STOPPING', 'STOPPED', 'TERMINATED']);

type ComputeRefusal = Error & { httpStatus: number };

function isRetryableRefusal(error: unknown): boolean {
  if (!(error instanceof Error) || !('httpStatus' in error) || typeof error.httpStatus !== 'number') return false;
  return error.httpStatus === 429 || error.httpStatus >= 500;
}

const MetadataToken = z.object({ access_token: z.string().min(1) });
const GceInstance = z.object({ status: z.string().min(1) });

function createGcpHostAdapter({ fetchFn = fetch, now = clock.nowMs, settleTimeoutMs, settlePollMs = SETTLE_POLL_MS }: {
  fetchFn?: typeof fetch;
  now?: () => number;
  settleTimeoutMs: number;
  settlePollMs?: number;
}): HostAdapter {
  async function jsonFrom(url: string, init: RequestInit, what: string): Promise<unknown> {
    const response = await fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      await response.body?.cancel();
      const refusal: ComputeRefusal = Object.assign(new Error(`${what} answered ${response.status}`), { httpStatus: response.status });
      throw refusal;
    }
    return response.json();
  }

  async function computeCall(method: 'GET' | 'POST', url: string, what: string): Promise<unknown> {
    const metadataToken = MetadataToken.parse(await jsonFrom(METADATA_TOKEN_URL, { headers: { 'metadata-flavor': 'Google' } }, 'the metadata server'));
    return jsonFrom(url, { method, headers: { authorization: `Bearer ${metadataToken.access_token}` } }, what);
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
