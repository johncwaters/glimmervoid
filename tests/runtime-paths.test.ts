import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import test from 'node:test';

import { computeRuntimePaths } from '../server/core/runtime-paths.ts';

const PACKAGE_ROOT = path.join(path.sep, 'opt', 'glimmervoid');

function onlyRootHasPackageJson(directory: string): boolean {
  return directory === PACKAGE_ROOT;
}

test('a source checkout resolves relays and the CLI as .ts beside the package root', () => {
  const paths = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'server', 'runtime-paths.ts'),
    hasPackageJson: onlyRootHasPackageJson,
  });

  assert.equal(paths.packageRoot, PACKAGE_ROOT);
  assert.equal(paths.bundled, false);
  assert.equal(paths.assetRoot, PACKAGE_ROOT);
  assert.equal(paths.extensionDir, path.join(PACKAGE_ROOT, 'tools', 'vscode-visions'));
  assert.equal(paths.cliPath, path.join(PACKAGE_ROOT, 'bin', 'glimmervoid.ts'));
  assert.equal(paths.relayPath('hook-relay'), path.join(PACKAGE_ROOT, 'session', 'hook-relay.ts'));
});

test('a bundled install resolves the same assets as .js under dist', () => {
  const paths = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'dist', 'server', 'index.js'),
    hasPackageJson: onlyRootHasPackageJson,
  });

  assert.equal(paths.packageRoot, PACKAGE_ROOT);
  assert.equal(paths.bundled, true);
  assert.equal(paths.assetRoot, path.join(PACKAGE_ROOT, 'dist'));
  assert.equal(paths.extensionDir, path.join(PACKAGE_ROOT, 'dist', 'tools', 'vscode-visions'));
  assert.equal(paths.cliPath, path.join(PACKAGE_ROOT, 'dist', 'bin', 'glimmervoid.js'));
  assert.equal(paths.relayPath('visions-relay'), path.join(PACKAGE_ROOT, 'dist', 'session', 'visions-relay.js'));
});

test('the dashboard build is always read from dist/client, bundled or not', () => {
  const fromSource = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'server', 'backend', 'backend-http.ts'),
    hasPackageJson: onlyRootHasPackageJson,
  });
  const fromBundle = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'dist', 'chunks', 'shared-abc123.js'),
    hasPackageJson: onlyRootHasPackageJson,
  });

  assert.equal(fromSource.clientDir, path.join(PACKAGE_ROOT, 'dist', 'client'));
  assert.equal(fromBundle.clientDir, path.join(PACKAGE_ROOT, 'dist', 'client'));
  assert.equal(fromBundle.bundled, true, 'a shared chunk under dist is still a bundled layout');
});

test('a module with no package.json above it falls back to the parent of its own directory', () => {
  const paths = computeRuntimePaths({
    moduleFile: path.join(path.sep, 'tmp', 'loose', 'server', 'runtime-paths.ts'),
    hasPackageJson: () => false,
  });

  assert.equal(paths.packageRoot, path.join(path.sep, 'tmp', 'loose'));
  assert.equal(paths.bundled, false);
});


test('package bins resolve from the package root and reject missing packages or bins', async () => {
  const { resolvePackageBin } = await import('../server/runtime-paths.ts');
  const binPath = resolvePackageBin('cc-safety-net', 'cc-safety-net');
  assert.ok(binPath);
  assert.equal(fs.statSync(binPath).isFile(), true);
  assert.equal(path.isAbsolute(binPath), true);
  assert.equal(resolvePackageBin('cc-safety-net', 'ccsn'), binPath);
  assert.equal(resolvePackageBin('cc-safety-net', 'missing-bin'), null);
  assert.equal(resolvePackageBin('missing-glimmervoid-package', 'missing-bin'), null);
  assert.equal(resolvePackageBin('cc-safety-net', 'cc-safety-net'), binPath);
});
