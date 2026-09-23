import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { nativeBindingCandidates, spawnHelperCandidates } from './core/node-pty-preflight-core.ts';
import { firstLine } from './core/text-core.ts';

export type NodePtyProbeResult = { ok: true; packageDir: string } | { ok: false; reason: string; packageDir: string };

export interface NativeScanScope {
  platform: NodeJS.Platform;
  arch: string;
}

function hostScope(): NativeScanScope {
  return { platform: process.platform, arch: process.arch };
}

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

const EXECUTABLE_MODE = 0o755;

function isExecutableByThisProcess(helperPath: string): boolean {
  try {
    fs.accessSync(helperPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureSpawnHelperExecutable(
  packageDir: string,
  scope: NativeScanScope,
): { ok: true } | { ok: false; reason: string } {
  const helperCandidates = spawnHelperCandidates({ packageDir, ...scope });
  if (helperCandidates.length === 0) return { ok: true };

  let hasExecutableHelper = false;
  let lastRepairError = 'no candidate spawn-helper exists';
  for (const helperPath of helperCandidates) {
    if (isExecutableByThisProcess(helperPath)) {
      hasExecutableHelper = true;
      continue;
    }
    if (!fs.existsSync(helperPath)) continue;
    try {
      fs.chmodSync(helperPath, EXECUTABLE_MODE);
    } catch (err) {
      lastRepairError = `${helperPath}: ${errorMessage(err)}`;
      continue;
    }
    if (isExecutableByThisProcess(helperPath)) {
      hasExecutableHelper = true;
      continue;
    }
    lastRepairError = `${helperPath}: still not executable after chmod 0755`;
  }
  if (hasExecutableHelper) return { ok: true };

  return {
    ok: false,
    reason: `no executable spawn-helper found; checked ${helperCandidates.join(', ')}; last repair failure: ${lastRepairError}`,
  };
}

function scanNativeBinding(packageDir: string, scope: NativeScanScope = hostScope()): NodePtyProbeResult {
  const candidates = nativeBindingCandidates({ packageDir, ...scope });
  const hasBinding = candidates.some((candidate) => fs.existsSync(candidate));
  if (!hasBinding) return { ok: false, reason: `no pty.node found; checked ${candidates.join(', ')}`, packageDir };

  const helper = ensureSpawnHelperExecutable(packageDir, scope);
  if (!helper.ok) return { ok: false, reason: helper.reason, packageDir };
  return { ok: true, packageDir };
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

function requireExecutableSpawnHelper(
  packageDir: string | null = null,
  scope: NativeScanScope = hostScope(),
): void {
  const resolved = packageDir === null ? resolveNodePtyPackageDir() : { packageDir };
  if ('error' in resolved) return;
  const helper = ensureSpawnHelperExecutable(resolved.packageDir, scope);
  if (!helper.ok) throw new Error(helper.reason);
}

export { probeNodePty, requireExecutableSpawnHelper, scanNativeBinding };
