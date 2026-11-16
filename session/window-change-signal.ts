import { readFile, readdir } from 'node:fs/promises';

const WINDOW_CHANGE_SIGNAL = 'SIGWINCH';
const MAX_SIGNALLED_PROCESSES = 512;

async function listChildProcessIds(processId: number): Promise<number[]> {
  const threadIds = await readdir(`/proc/${processId}/task`).catch(() => []);
  const childLists = await Promise.all(threadIds.map((threadId) => readFile(`/proc/${processId}/task/${threadId}/children`, 'utf8').catch(() => '')));
  return childLists.flatMap((childList) => childList.split(' ').filter((childId) => childId !== '').map(Number));
}

function sendWindowChange(processId: number): void {
  try {
    process.kill(processId, WINDOW_CHANGE_SIGNAL);
  } catch {}
}

async function signalWindowChangeBelow(rootProcessId: number): Promise<void> {
  const descendantProcessIds = await listChildProcessIds(rootProcessId);
  for (const processId of descendantProcessIds) {
    if (descendantProcessIds.length > MAX_SIGNALLED_PROCESSES) return;
    sendWindowChange(processId);
    descendantProcessIds.push(...await listChildProcessIds(processId));
  }
}

export { signalWindowChangeBelow };
