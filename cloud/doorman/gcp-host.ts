import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { createGcpRest, isRetryableRefusal } from './gcp-rest.ts';
import type { DoormanGcpHost, DoormanTenant } from '../../shared/contracts/doorman.ts';
import { gceWakeAction, isGceSettling, isGceStockout, machineTypesToTry } from './doorman-core.ts';
import { clock } from '../../shared/clock.ts';

type ColdStartReport = { onColdStart(): void; onStartedOn(machineType: string): void };
type HostAdapter = { wake(tenant: DoormanTenant, coldStartReport?: ColdStartReport): Promise<void>; stop(tenant: DoormanTenant): Promise<void> };
type HostAction = 'resume' | 'start' | 'stop' | 'suspend' | 'setMachineType';

const COMPUTE_ORIGIN = 'https://compute.googleapis.com';
const SETTLE_POLL_MS = 2000;
const OPERATION_TIMEOUT_MS = 120_000;
const OPERATION_WAIT_REQUEST_TIMEOUT_MS = 150_000;
const STOPPED_STATUSES: ReadonlySet<string> = new Set(['SUSPENDING', 'SUSPENDED', 'STOPPING', 'STOPPED', 'TERMINATED']);
const SILENT_COLD_START_REPORT: ColdStartReport = Object.freeze({ onColdStart: () => {}, onStartedOn: () => {} });

const GceInstance = z.object({ status: z.string().min(1), machineType: z.string().min(1).optional() });
const GceOperation = z.object({
  status: z.string().min(1).optional(),
  selfLink: z.url().optional(),
  error: z.object({ errors: z.array(z.object({ code: z.string() })).default([]) }).optional(),
});
type GceOperation = z.infer<typeof GceOperation>;

function errorCodesOf(operation: GceOperation): string[] {
  return operation.error?.errors.map((operationError) => operationError.code) ?? [];
}

function machineTypeNameOf(machineTypeUrl: string): string {
  return machineTypeUrl.slice(machineTypeUrl.lastIndexOf('/') + 1);
}

function createGcpHostAdapter({ fetchFn = fetch, now = clock.nowMs, settleTimeoutMs, settlePollMs = SETTLE_POLL_MS, operationTimeoutMs = OPERATION_TIMEOUT_MS }: {
  fetchFn?: typeof fetch;
  now?: () => number;
  settleTimeoutMs: number;
  settlePollMs?: number;
  operationTimeoutMs?: number;
}): HostAdapter {
  const google = createGcpRest({ fetchFn });

  function computeCall(method: 'GET' | 'POST', url: string, what: string, body?: object, signal?: AbortSignal): Promise<unknown> {
    if (body === undefined) return google.authorizedJson(url, { method, signal }, what);
    return google.authorizedJson(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, what);
  }

  function instanceUrlOf(host: DoormanGcpHost): string {
    return `${COMPUTE_ORIGIN}/compute/v1/projects/${host.project}/zones/${host.zone}/instances/${host.instance}`;
  }

  async function readInstance(host: DoormanGcpHost): Promise<z.infer<typeof GceInstance>> {
    return GceInstance.parse(await computeCall('GET', instanceUrlOf(host), `reading instance ${host.instance}`));
  }

  async function statusUntil(host: DoormanGcpHost, deadlineMs: number): Promise<string | null> {
    try {
      return (await readInstance(host)).status;
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

  async function operationUntil(selfLink: string, what: string, deadlineMs: number): Promise<GceOperation | null> {
    try {
      return GceOperation.parse(await computeCall('POST', `${selfLink}/wait`, `waiting on the ${what} operation`, undefined, AbortSignal.timeout(OPERATION_WAIT_REQUEST_TIMEOUT_MS)));
    } catch (readError) {
      if (!isRetryableRefusal(readError) || now() >= deadlineMs) throw readError;
      await sleep(settlePollMs);
      return null;
    }
  }

  async function finishedOperation(started: GceOperation, what: string): Promise<GceOperation> {
    const deadlineMs = now() + operationTimeoutMs;
    const selfLink = started.selfLink;
    let operation = started;
    while (operation.status !== undefined && operation.status !== 'DONE' && selfLink !== undefined) {
      if (now() >= deadlineMs) throw new Error(`${what} did not finish within ${operationTimeoutMs} ms`);
      const waitStartedAtMs = now();
      operation = (await operationUntil(selfLink, what, deadlineMs)) ?? operation;
      const didWaitReturnEarly = operation.status !== 'DONE' && now() - waitStartedAtMs < settlePollMs;
      if (didWaitReturnEarly) await sleep(settlePollMs);
    }
    return operation;
  }

  async function act(host: DoormanGcpHost, action: HostAction, body?: object): Promise<string[]> {
    const what = `${action} of instance ${host.instance}`;
    const started = GceOperation.parse(await computeCall('POST', `${instanceUrlOf(host)}/${action}`, what, body));
    return errorCodesOf(await finishedOperation(started, what));
  }

  async function actOrThrow(host: DoormanGcpHost, action: HostAction, body?: object): Promise<void> {
    const errorCodes = await act(host, action, body);
    if (errorCodes.length > 0) throw new Error(`${action} of instance ${host.instance} failed: ${errorCodes.join(', ')}`);
  }

  async function startOnAnyMachineType(host: DoormanGcpHost, coldStartReport: ColdStartReport): Promise<void> {
    const currentMachineType = machineTypeNameOf((await readInstance(host)).machineType ?? '');
    let machineTypeOnInstance = currentMachineType;
    for (const machineType of machineTypesToTry(currentMachineType)) {
      if (machineType !== machineTypeOnInstance) {
        await actOrThrow(host, 'setMachineType', { machineType: `zones/${host.zone}/machineTypes/${machineType}` });
        machineTypeOnInstance = machineType;
      }
      const startErrorCodes = await act(host, 'start');
      if (startErrorCodes.length === 0) return coldStartReport.onStartedOn(machineType);
      if (!isGceStockout(startErrorCodes)) throw new Error(`start of instance ${host.instance} on ${machineType} failed: ${startErrorCodes.join(', ')}`);
    }
    throw new Error(`no machine type in ${machineTypesToTry(currentMachineType).join(', ')} has room in zone ${host.zone} for instance ${host.instance}`);
  }

  async function coldStart(host: DoormanGcpHost, coldStartReport: ColdStartReport): Promise<void> {
    await actOrThrow(host, 'stop');
    coldStartReport.onColdStart();
    const stoppedStatus = await settledStatus(host);
    if (stoppedStatus !== 'TERMINATED') throw new Error(`instance ${host.instance} is ${stoppedStatus} after stop, so it was not started fresh`);
    await startOnAnyMachineType(host, coldStartReport);
  }

  function hostOf(tenant: DoormanTenant): DoormanGcpHost {
    if (tenant.host === null) throw new Error(`tenant ${tenant.slug} has no host`);
    return tenant.host;
  }

  async function wake(tenant: DoormanTenant, coldStartReport: ColdStartReport = SILENT_COLD_START_REPORT): Promise<void> {
    const host = hostOf(tenant);
    const action = gceWakeAction(await settledStatus(host));
    if (action === null) return;
    if (action === 'start') return startOnAnyMachineType(host, coldStartReport);
    const resumeErrorCodes = await act(host, 'resume');
    if (resumeErrorCodes.length === 0) return;
    if (!isGceStockout(resumeErrorCodes)) throw new Error(`resume of instance ${host.instance} failed: ${resumeErrorCodes.join(', ')}`);
    await coldStart(host, coldStartReport);
  }

  async function stop(tenant: DoormanTenant): Promise<void> {
    const host = hostOf(tenant);
    const status = await settledStatus(host);
    if (status === 'RUNNING') {
      await computeCall('POST', `${instanceUrlOf(host)}/suspend`, `suspend of instance ${host.instance}`);
      return;
    }
    if (!STOPPED_STATUSES.has(status)) throw new Error(`instance ${host.instance} is ${status}, so it was not suspended`);
  }

  return { wake, stop };
}

export { createGcpHostAdapter };
export type { ColdStartReport, HostAdapter };
