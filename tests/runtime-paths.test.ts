import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import path from 'node:path';

import test from 'node:test';

import { computeRuntimePaths } from '../server/core/runtime-paths.ts';

const PACKAGE_ROOT = path.join(path.sep, 'opt', 'glimmervoid');

function onlyRootHasPackageJson(directory: string): boolean {
  return directory === PACKAGE_ROOT;
}

test('a bundled install resolves the same assets as .js under dist', () => {
  const paths = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'dist', 'server', 'index.js'),
    hasPackageJson: onlyRootHasPackageJson,
    isBinary: false,
  });

  assert.equal(paths.packageRoot, PACKAGE_ROOT);
  assert.equal(paths.bundled, true);
  assert.equal(paths.assetRoot, path.join(PACKAGE_ROOT, 'dist'));
  assert.equal(paths.cliPath, path.join(PACKAGE_ROOT, 'dist', 'bin', 'glimmervoid.js'));
  assert.equal(paths.examplePacksDir, path.join(PACKAGE_ROOT, 'dist', 'examples', 'packs'));
  assert.equal(paths.relayPath('hook-relay'), path.join(PACKAGE_ROOT, 'dist', 'session', 'hook-relay.js'));
});

test('the dashboard build is always read from dist/client, bundled or not', () => {
  const fromSource = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'server', 'backend', 'backend-http.ts'),
    hasPackageJson: onlyRootHasPackageJson,
    isBinary: false,
  });
  const fromBundle = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'dist', 'chunks', 'shared-abc123.js'),
    hasPackageJson: onlyRootHasPackageJson,
    isBinary: false,
  });

  assert.equal(fromSource.clientDir, path.join(PACKAGE_ROOT, 'dist', 'client'));
  assert.equal(fromBundle.clientDir, path.join(PACKAGE_ROOT, 'dist', 'client'));
  assert.equal(fromBundle.bundled, true, 'a shared chunk under dist is still a bundled layout');
});

test('a binary relaunches itself through __run, while node installs launch the entry file', () => {
  const binaryPaths = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'dist', 'server', 'index.mjs'),
    hasPackageJson: onlyRootHasPackageJson,
    isBinary: true,
  });
  const bundledPaths = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'dist', 'server', 'index.js'),
    hasPackageJson: onlyRootHasPackageJson,
    isBinary: false,
  });

  assert.equal(binaryPaths.boardStoreWorkerPath, path.join(PACKAGE_ROOT, 'dist', 'server', 'whiteboard', 'board-store-worker.mjs'));
  assert.deepEqual(binaryPaths.selfLaunch('cli', '/usr/local/bin/glimmervoid'), ['/usr/local/bin/glimmervoid']);
  assert.deepEqual(binaryPaths.selfLaunch('hook-relay', '/usr/local/bin/glimmervoid'), ['/usr/local/bin/glimmervoid', '__run', 'hook-relay']);
  assert.deepEqual(bundledPaths.selfLaunch('hook-relay', '/usr/bin/node'), ['/usr/bin/node', path.join(PACKAGE_ROOT, 'dist', 'session', 'hook-relay.js')]);
});

test('a binary runs the glimmervoid-fnox shipped beside it, while a checkout runs the pinned fnox it fetched', () => {
  const binaryPaths = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'dist', 'server', 'index.mjs'),
    hasPackageJson: onlyRootHasPackageJson,
    isBinary: true,
  });
  const sourcePaths = computeRuntimePaths({
    moduleFile: path.join(PACKAGE_ROOT, 'server', 'index.ts'),
    hasPackageJson: onlyRootHasPackageJson,
    isBinary: false,
  });
  const installDir = path.join(path.sep, 'home', 'operator', '.glimmervoid', 'bin');

  assert.equal(binaryPaths.fnoxPath({ execPath: path.join(installDir, 'glimmervoid'), platform: 'darwin', fnoxVersion: '1.48.0' }), path.join(installDir, 'glimmervoid-fnox'));
  assert.equal(binaryPaths.fnoxPath({ execPath: path.join(installDir, 'glimmervoid.exe'), platform: 'win32', fnoxVersion: '1.48.0' }), path.join(installDir, 'glimmervoid-fnox.exe'));
  assert.equal(sourcePaths.fnoxPath({ execPath: '/usr/bin/node', platform: 'linux', fnoxVersion: '1.48.0' }), path.join(PACKAGE_ROOT, '.fnox', '1.48.0', 'fnox'));
});
