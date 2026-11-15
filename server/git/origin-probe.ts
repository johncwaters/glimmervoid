import net from 'node:net';
import { ORIGIN_PROBE_TIMEOUT_CODE, ORIGIN_PROBE_TIMEOUT_MS, reachabilityOf } from './core/origin-probe-core.ts';
import type { OriginProbeTarget, OriginReachability } from './core/origin-probe-core.ts';

type OriginProbe = (target: OriginProbeTarget) => Promise<OriginReachability>;

function failureCodeOf(error: unknown): string {
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' ? code : 'unknown';
}

function probeOriginReachability({ host, port }: OriginProbeTarget, timeoutMs = ORIGIN_PROBE_TIMEOUT_MS): Promise<OriginReachability> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (failureCode: string | null) => {
      socket.destroy();
      resolve(reachabilityOf(failureCode));
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(null));
    socket.once('timeout', () => settle(ORIGIN_PROBE_TIMEOUT_CODE));
    socket.once('error', (error) => settle(failureCodeOf(error)));
  });
}

export { probeOriginReachability };
export type { OriginProbe };
