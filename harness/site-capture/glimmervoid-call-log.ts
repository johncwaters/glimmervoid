import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const [callLogPath, glimmervoidCliPath, ...glimmervoidArguments] = process.argv.slice(2);
if (!callLogPath || !glimmervoidCliPath) throw new Error('usage: glimmervoid-call-log.ts <call-log> <glimmervoid-cli> [args...]');

const calledAt = Date.now();
const exitCode = await new Promise<number>((resolve, reject) => {
  const child = spawn(process.execPath, [glimmervoidCliPath, ...glimmervoidArguments], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => resolve(code ?? 1));
});
await fs.appendFile(callLogPath, `${JSON.stringify({ ts: calledAt, args: glimmervoidArguments, exitCode })}\n`);
process.exitCode = exitCode;
