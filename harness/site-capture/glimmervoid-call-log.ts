import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const [callLogPath, shownFilesDirectory, glimmervoidCliPath, ...glimmervoidArguments] = process.argv.slice(2);
if (!callLogPath || !shownFilesDirectory || !glimmervoidCliPath) throw new Error('usage: glimmervoid-call-log.ts <call-log> <shown-files-dir> <glimmervoid-cli> [args...]');

if (glimmervoidArguments[0] === 'show') {
  for (const argument of glimmervoidArguments.slice(1)) {
    const isFile = await fs.stat(argument).then((stats) => stats.isFile(), () => false);
    if (isFile) await fs.copyFile(argument, path.join(shownFilesDirectory, path.basename(argument)));
  }
}

const calledAt = Date.now();
const exitCode = await new Promise<number>((resolve, reject) => {
  const child = spawn(process.execPath, [glimmervoidCliPath, ...glimmervoidArguments], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => resolve(code ?? 1));
});
await fs.appendFile(callLogPath, `${JSON.stringify({ ts: calledAt, args: glimmervoidArguments, exitCode })}\n`);
process.exitCode = exitCode;
