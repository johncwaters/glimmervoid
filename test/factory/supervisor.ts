import { setTimeout as sleep } from 'node:timers/promises';

const POLL_MS = 250;
const TERMINATION_WAIT_MS = 8_000;

function processIdArgument(text: string | undefined): number {
  const processId = Number(text);
  if (!text || !/^\d+$/.test(text) || !Number.isSafeInteger(processId) || processId < 2) throw new Error('Usage: node test/factory/supervisor.ts <harness pid> <server process group id>');
  return processId;
}

const harnessPid = processIdArgument(process.argv[2]);
const serverGroupId = processIdArgument(process.argv[3]);

function signalServerGroup(signal: NodeJS.Signals | 0): boolean {
  try { process.kill(-serverGroupId, signal); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

async function hasServerOutlivedHarness(): Promise<boolean> {
  while (process.ppid === harnessPid) {
    if (!signalServerGroup(0)) return false;
    await sleep(POLL_MS);
  }
  return signalServerGroup(0);
}

if (await hasServerOutlivedHarness() && signalServerGroup('SIGTERM')) {
  const killDeadline = Date.now() + TERMINATION_WAIT_MS;
  while (Date.now() < killDeadline && signalServerGroup(0)) await sleep(100);
  signalServerGroup('SIGKILL');
}
