import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { INSTALL_COMMAND, LINUX_INSTALL_COMMAND } from '../site/src/lib/install-command.ts';
import { INSTALL_PLATFORMS } from '../site/src/lib/install-platform.ts';

const SITE_COMPONENTS = path.join(import.meta.dirname, '..', 'site', 'src', 'components');

test('the default install command skips the node-pty script flag only because the hero offers Linux its own command', () => {
  assert.equal(INSTALL_COMMAND.includes('--allow-scripts=node-pty'), false);
  assert.match(LINUX_INSTALL_COMMAND, /--allow-scripts=node-pty/);
  const hero = fs.readFileSync(path.join(SITE_COMPONENTS, 'Hero.astro'), 'utf8');
  assert.match(hero, /On Linux, use the <a href="#install">Linux command<\/a>/);
  assert.match(hero, /<span data-install-for="linux" hidden><InstallCommand command=\{LINUX_INSTALL_COMMAND\} \/><\/span>/);
  const install = fs.readFileSync(path.join(SITE_COMPONENTS, 'Install.astro'), 'utf8');
  assert.match(install, /<InstallCommand class="cmd" command=\{LINUX_INSTALL_COMMAND\} \/>/);
});

test('the hero carries every markup hook its platform switch script applies the view to', () => {
  const hero = fs.readFileSync(path.join(SITE_COMPONENTS, 'Hero.astro'), 'utf8');
  assert.match(hero, /<code id="install-command"><span data-install-for="default">/);
  assert.match(hero, /<span data-install-for="linux" hidden>/);
  assert.match(hero, /<div class="platform-switch" id="platform-switch"[^>]*>\s*\{INSTALL_PLATFORMS\.map\(\(platform\) => <button type="button" data-platform=\{platform\}/);
  assert.match(hero, /id="linux-build-note" hidden/);
  assert.deepEqual([...INSTALL_PLATFORMS].sort(), ['linux', 'macos', 'windows']);
});
