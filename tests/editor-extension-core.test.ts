import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideEditorTargets, isExtensionInstalled, parseInstalledExtensions, resolveEditorPathsFor, visionsExtensionFiles,
} from '../server/core/editor-extension-core.ts';
import type { EditorProbe } from '../server/core/editor-extension-core.ts';

const CURSOR_BUNDLE_CLI = '/Applications/Cursor.app/Contents/Resources/app/bin/cursor';
const NOTHING_ON_DISK: EditorProbe = { platform: 'linux', exists: () => false };

test('every detected editor is a target, in candidate order', () => {
  const { targets, reason } = decideEditorTargets({
    resolvedByCommand: { cursor: '/usr/bin/cursor', codium: '/usr/bin/codium' },
    probe: NOTHING_ON_DISK,
  });
  assert.equal(reason, 'detected');
  assert.deepEqual(targets.map((target) => target.command), ['codium', 'cursor']);
  assert.equal(targets[0].commandPath, '/usr/bin/codium');
});

test('an explicit editor wins and unresolved means no targets at all', () => {
  const chosen = decideEditorTargets({ requested: 'code', resolvedByCommand: { code: '/usr/bin/code', codium: '/usr/bin/codium' }, probe: NOTHING_ON_DISK });
  assert.deepEqual(chosen.targets.map((target) => target.command), ['code']);

  const missing = decideEditorTargets({ requested: 'code', resolvedByCommand: { codium: '/usr/bin/codium' }, probe: NOTHING_ON_DISK });
  assert.deepEqual(missing.targets, []);
  assert.match(missing.reason, /not found on PATH: code/);
});

test('no editor on PATH refuses rather than picking one', () => {
  const { targets, reason } = decideEditorTargets({ resolvedByCommand: {}, probe: NOTHING_ON_DISK });
  assert.deepEqual(targets, []);
  assert.match(reason, /no VS Code family editor/);
});

test('an unknown requested editor still installs under its own command name', () => {
  const { targets } = decideEditorTargets({ requested: 'positron', resolvedByCommand: { positron: '/opt/positron' }, probe: NOTHING_ON_DISK });
  assert.deepEqual(targets, [{ command: 'positron', label: 'positron', commandPath: '/opt/positron' }]);
});

test('every macOS app bundle names its own CLI, and a PATH hit is never overridden by one', () => {
  const resolved = resolveEditorPathsFor({
    platform: 'darwin',
    homeDir: '/Users/j',
    matchesOnPath: (command) => (command === 'cursor' ? ['/usr/local/bin/cursor'] : []),
    exists: () => true,
  });
  assert.deepEqual(resolved, {
    codium: '/Applications/VSCodium.app/Contents/Resources/app/bin/codium',
    code: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    'code-insiders': '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
    cursor: '/usr/local/bin/cursor',
    windsurf: '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
  });
});

test('the macOS bundle fallback finds a per-user install as readily as a system-wide one', () => {
  const systemWide = resolveEditorPathsFor({
    platform: 'darwin',
    homeDir: '/Users/j',
    matchesOnPath: () => [],
    exists: (candidate) => candidate === CURSOR_BUNDLE_CLI,
  });
  assert.deepEqual(systemWide, { cursor: CURSOR_BUNDLE_CLI });

  const perUserCursorCli = '/Users/j/Applications/Cursor.app/Contents/Resources/app/bin/cursor';
  const perUser = resolveEditorPathsFor({
    platform: 'darwin',
    homeDir: '/Users/j',
    matchesOnPath: () => [],
    exists: (candidate) => candidate === perUserCursorCli,
  });
  assert.deepEqual(perUser, { cursor: perUserCursorCli });
});

test('off macOS an editor absent from PATH stays undetected, whatever exists on disk', () => {
  for (const platform of ['linux', 'win32'] as NodeJS.Platform[]) {
    const resolved = resolveEditorPathsFor({
      platform,
      homeDir: '/home/j',
      matchesOnPath: () => [],
      exists: () => true,
    });
    assert.deepEqual(resolved, {}, `no bundle path is invented on ${platform}`);
  }
});

test('an absolute editor path is accepted when it is on disk, and refused when it is not', () => {
  const chosen = decideEditorTargets({
    requested: CURSOR_BUNDLE_CLI,
    resolvedByCommand: {},
    probe: { platform: 'darwin', exists: (candidate) => candidate === CURSOR_BUNDLE_CLI },
  });
  assert.deepEqual(chosen.targets, [{ command: CURSOR_BUNDLE_CLI, label: 'Cursor', commandPath: CURSOR_BUNDLE_CLI }]);
  assert.equal(chosen.reason, 'requested');

  const absent = decideEditorTargets({
    requested: '/Applications/Nope.app/Contents/Resources/app/bin/nope',
    resolvedByCommand: {},
    probe: { platform: 'darwin', exists: () => false },
  });
  assert.deepEqual(absent.targets, []);
  assert.equal(absent.reason, 'editor path does not exist on disk: /Applications/Nope.app/Contents/Resources/app/bin/nope');
});

test('a bare editor name is still resolved through PATH, never probed as a file', () => {
  let probes = 0;
  const chosen = decideEditorTargets({
    requested: 'code',
    resolvedByCommand: { code: '/usr/bin/code' },
    probe: { platform: 'darwin', exists: () => { probes += 1; return true; } },
  });
  assert.equal(chosen.targets[0].commandPath, '/usr/bin/code');
  assert.equal(probes, 0, 'a relative name is a PATH lookup, so nothing is stat-ed');
});

test('the packed extension stamps the relay path it was built from', () => {
  const files = visionsExtensionFiles({
    manifestJson: '{}', extensionJs: 'a', convertJs: 'b', lspCoreJs: 'c', relayPath: '/opt/glimmervoid/session/visions-relay.js',
  });
  assert.deepEqual(files.map((file) => file.path), ['package.json', 'extension.js', 'lsp-convert.js', 'visions-lsp-core.js', 'relay-path.json']);
  assert.equal(JSON.parse(files[4].data).relayPath, '/opt/glimmervoid/session/visions-relay.js');
});

test('installed detection ignores case and blank lines', () => {
  const stdout = '\nms-python.python\nJohnWaters.Glimmervoid-Visions\n\n';
  assert.deepEqual(parseInstalledExtensions(stdout), ['ms-python.python', 'JohnWaters.Glimmervoid-Visions']);
  assert.equal(isExtensionInstalled(stdout, 'johnwaters.glimmervoid-visions'), true);
  assert.equal(isExtensionInstalled(stdout, 'johnwaters.other'), false);
});
