import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isExternalHttpUrl, isHostedInEditorBrowser, isNewTabActivation, shouldOpenLinksOnHost,
} from '../public/external-link-core.ts';

const VSCODIUM_BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) VSCodium/1.135.0 Chrome/148.0.7778.280 Electron/42.8.1 Safari/537.36';
const VSCODE_BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.135.0 Chrome/148.0.7778.280 Electron/42.8.1 Safari/537.36';
const CHROME_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const SAFARI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';

test('isHostedInEditorBrowser recognizes the Electron token VSCodium and VS Code browser views carry', () => {
  assert.equal(isHostedInEditorBrowser(VSCODIUM_BROWSER_USER_AGENT), true);
  assert.equal(isHostedInEditorBrowser(VSCODE_BROWSER_USER_AGENT), true);
  assert.equal(isHostedInEditorBrowser(CHROME_USER_AGENT), false);
  assert.equal(isHostedInEditorBrowser(SAFARI_USER_AGENT), false);
  assert.equal(isHostedInEditorBrowser(''), false);
});

test('shouldOpenLinksOnHost needs both the editor browser and a loopback page', () => {
  assert.equal(shouldOpenLinksOnHost({ userAgent: VSCODIUM_BROWSER_USER_AGENT, pageHostname: 'localhost' }), true);
  assert.equal(shouldOpenLinksOnHost({ userAgent: VSCODIUM_BROWSER_USER_AGENT, pageHostname: '127.0.0.1' }), true);
  assert.equal(shouldOpenLinksOnHost({ userAgent: VSCODIUM_BROWSER_USER_AGENT, pageHostname: 'glimmer.example.com' }), false);
  assert.equal(shouldOpenLinksOnHost({ userAgent: CHROME_USER_AGENT, pageHostname: 'localhost' }), false);
});

test('isExternalHttpUrl accepts absolute http and https only', () => {
  assert.equal(isExternalHttpUrl('https://github.com/owner/repo/pull/1'), true);
  assert.equal(isExternalHttpUrl('http://localhost:8080/'), true);
  assert.equal(isExternalHttpUrl('#settings/updates'), false);
  assert.equal(isExternalHttpUrl('mailto:someone@example.com'), false);
  assert.equal(isExternalHttpUrl('javascript:void(0)'), false);
  assert.equal(isExternalHttpUrl('/relative'), false);
});

test('isNewTabActivation takes primary and middle clicks on new-tab anchors only', () => {
  assert.equal(isNewTabActivation({ button: 0, opensInNewTab: true }), true);
  assert.equal(isNewTabActivation({ button: 1, opensInNewTab: true }), true);
  assert.equal(isNewTabActivation({ button: 2, opensInNewTab: true }), false);
  assert.equal(isNewTabActivation({ button: 0, opensInNewTab: false }), false);
});
