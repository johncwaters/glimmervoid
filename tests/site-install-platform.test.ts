import test from 'node:test';
import assert from 'node:assert/strict';

import { detectInstallPlatform, installPlatformView } from '../site/src/lib/install-platform.ts';

test('the user agent client hint platform decides first', () => {
  assert.equal(detectInstallPlatform({ userAgentDataPlatform: 'macOS', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), 'macos');
  assert.equal(detectInstallPlatform({ userAgentDataPlatform: 'Windows' }), 'windows');
  assert.equal(detectInstallPlatform({ userAgentDataPlatform: 'Linux' }), 'linux');
  assert.equal(detectInstallPlatform({ userAgentDataPlatform: 'Chrome OS' }), 'linux');
});

test('without a client hint the user agent string decides, as in Safari and Firefox', () => {
  assert.equal(detectInstallPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/605.1.15' }), 'macos');
  assert.equal(detectInstallPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0' }), 'windows');
  assert.equal(detectInstallPlatform({ userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0' }), 'linux');
});

test('phones and unknown agents get no guess, so the page keeps its default command', () => {
  assert.equal(detectInstallPlatform({ userAgentDataPlatform: 'Android', userAgent: 'Mozilla/5.0 (Linux; Android 15)' }), null);
  assert.equal(detectInstallPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36' }), null);
  assert.equal(detectInstallPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), null);
  assert.equal(detectInstallPlatform({ userAgent: 'curl/8.7.1' }), null);
  assert.equal(detectInstallPlatform({}), null);
});

test('an unrecognised client hint falls back to the user agent string', () => {
  assert.equal(detectInstallPlatform({ userAgentDataPlatform: 'Chromium OS', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36' }), 'linux');
  assert.equal(detectInstallPlatform({ userAgentDataPlatform: 'Unknown', userAgent: 'Mozilla/5.0 (X11; FreeBSD amd64) AppleWebKit/537.36' }), 'linux');
});

test('linux shows the linux command and the build note', () => {
  assert.deepEqual(installPlatformView('linux'), { visibleCommand: 'linux', pressedPlatform: 'linux', isBuildNoteShown: true });
});

test('macos and windows show the default command without the build note', () => {
  assert.deepEqual(installPlatformView('macos'), { visibleCommand: 'default', pressedPlatform: 'macos', isBuildNoteShown: false });
  assert.deepEqual(installPlatformView('windows'), { visibleCommand: 'default', pressedPlatform: 'windows', isBuildNoteShown: false });
});
