import { readFile } from 'node:fs/promises';
import { listChildProcessIds } from './window-change-signal.ts';

const MAX_MEASURED_PROCESSES = 512;

async function readResidentBytes(processId: number): Promise<number | null> {
  const statusText = await readFile(`/proc/${processId}/status`, 'utf8').catch(() => null);
  const match = statusText === null ? null : /^VmRSS:\s+(\d+)\s+kB$/m.exec(statusText);
  return match ? Number(match[1]) * 1024 : null;
}

async function readProcessTreeResidentBytes(rootProcessId: number): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  const rootBytes = await readResidentBytes(rootProcessId);
  if (rootBytes === null) return null;
  const processIds = await listChildProcessIds(rootProcessId);
  let totalBytes = rootBytes;
  for (const processId of processIds) {
    if (processIds.length > MAX_MEASURED_PROCESSES) break;
    totalBytes += await readResidentBytes(processId) ?? 0;
    processIds.push(...await listChildProcessIds(processId));
  }
  return totalBytes;
}

export { readProcessTreeResidentBytes };
