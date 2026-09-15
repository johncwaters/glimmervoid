import { recoverHandoff } from '../scripts/recover-handoff.mjs';
import { formatNodePtyBootRefusal } from './core/node-pty-preflight-core.ts';
import { probeNodePty } from './node-pty-preflight.ts';
import { packageRoot } from './runtime-paths.ts';

recoverHandoff(packageRoot);

const nodePty = await probeNodePty();
if (!nodePty.ok) {
  console.error(formatNodePtyBootRefusal({
    platform: process.platform,
    packageDir: nodePty.packageDir,
    reason: nodePty.reason,
  }));
  process.exit(1);
}

await import('./main.ts');
