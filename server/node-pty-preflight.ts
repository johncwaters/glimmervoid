import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { nativeBindingCandidates } from './core/node-pty-preflight-core.ts';
import { firstLine } from './core/text-core.ts';

export type NodePtyProbeResult = { ok: true; packageDir: string } | { ok: false; reason: string; packageDir: string };

function errorMessage(error: unknown): string {
  return firstLine(error instanceof Error ? error.message : String(error));
}

function resolveNodePtyPackageDir(): { packageDir: string } | { error: string } {
  try {
    return { packageDir: path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json')) };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function scanNativeBinding(packageDir: string): NodePtyProbeResult {
  const candidates = nativeBindingCandidates({ packageDir, platform: process.platform, arch: process.arch });
  if (candidates.some((candidate) => fs.existsSync(candidate))) return { ok: true, packageDir };
  return { ok: false, reason: `no pty.node found; checked ${candidates.join(', ')}`, packageDir };
}

async function probeNodePty(): Promise<NodePtyProbeResult> {
  const resolved = resolveNodePtyPackageDir();
  if ('error' in resolved) return { ok: false, reason: resolved.error, packageDir: '(unresolved)' };

  try {
    await import('node-pty');
  } catch (err) {
    return { ok: false, reason: errorMessage(err), packageDir: resolved.packageDir };
  }

  return scanNativeBinding(resolved.packageDir);
}

export { probeNodePty, scanNativeBinding };
