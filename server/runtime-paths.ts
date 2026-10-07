import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { computeRuntimePaths } from './core/runtime-paths.ts';
import type { RuntimePaths } from './core/runtime-paths.ts';

function hasPackageManifest(directory: string): boolean {
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (typeof doc !== 'object' || doc === null || !('name' in doc)) return false;
    return typeof doc.name === 'string';
  } catch {
    return false;
  }
}

const runtimePaths: RuntimePaths = computeRuntimePaths({
  moduleFile: fileURLToPath(import.meta.url),
  hasPackageJson: hasPackageManifest,
});

const { assetRoot, bundled, cliPath, clientDir, extensionDir, packageRoot, relayPath } = runtimePaths;

export { assetRoot, bundled, cliPath, clientDir, extensionDir, packageRoot, relayPath, runtimePaths };

const packageBins = new Map<string, string | null>();

function resolvePackageBin(packageName: string, binName: string): string | null {
  const cacheKey = `${packageName}:${binName}`;
  if (packageBins.has(cacheKey)) return packageBins.get(cacheKey) ?? null;
  const resolvedBin = readPackageBin(packageName, binName);
  packageBins.set(cacheKey, resolvedBin);
  return resolvedBin;
}

function readPackageBin(packageName: string, binName: string): string | null {
  try {
    const require = createRequire(path.join(packageRoot, 'package.json'));
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || !('bin' in manifest)) return null;
    const bins = manifest.bin;
    const relativeBin = typeof bins === 'string' ? bins
      : bins && typeof bins === 'object' ? Reflect.get(bins, binName) : null;
    if (typeof relativeBin !== 'string') return null;
    const binPath = path.join(path.dirname(manifestPath), relativeBin);
    return fs.statSync(binPath).isFile() ? binPath : null;
  } catch {
    return null;
  }
}

export { resolvePackageBin };
