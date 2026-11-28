import os from 'node:os';
import { recoverHandoff } from '../scripts/recover-handoff.mjs';
import { glimmervoidHomeDir } from './core/config-path-core.ts';
import { formatNodePtyBootRefusal } from './core/node-pty-preflight-core.ts';
import { acquireHomeLockAsync, isHomeLockRefusal, registerBootHomeLock } from './home-lock.ts';
import { probeNodePty } from './node-pty-preflight.ts';
import { packageRoot } from './runtime-paths.ts';
import { teeProcessOutputToServerLog } from './server-log-file.ts';

const bootHomeDir = glimmervoidHomeDir(os.homedir(), process.env);
let bootHomeLock: Awaited<ReturnType<typeof acquireHomeLockAsync>>;
try {
  bootHomeLock = await acquireHomeLockAsync({ homeDir: bootHomeDir, port: null, env: process.env });
} catch (error) {
  if (isHomeLockRefusal(error)) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
registerBootHomeLock(bootHomeDir, bootHomeLock);

teeProcessOutputToServerLog();
recoverHandoff(packageRoot);

const nodePty = await probeNodePty();
if (!nodePty.ok) {
  bootHomeLock.release();
  console.error(formatNodePtyBootRefusal({
    platform: process.platform,
    packageDir: nodePty.packageDir,
    reason: nodePty.reason,
  }));
  process.exit(1);
}

await import('./main.ts');
