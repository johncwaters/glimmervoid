import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { INSTALL_COMMAND, LINUX_INSTALL_COMMAND } from '../site/src/lib/install-command.ts';

const SITE_COMPONENTS = path.join(import.meta.dirname, '..', 'site', 'src', 'components');

test('the default install command skips the node-pty script flag only because the hero points Linux to its own command', () => {
  assert.equal(INSTALL_COMMAND.includes('--allow-scripts=node-pty'), false);
  assert.match(LINUX_INSTALL_COMMAND, /--allow-scripts=node-pty/);
  const hero = fs.readFileSync(path.join(SITE_COMPONENTS, 'Hero.astro'), 'utf8');
  assert.match(hero, /On Linux, use the <a href="#install">Linux command<\/a>/);
  const install = fs.readFileSync(path.join(SITE_COMPONENTS, 'Install.astro'), 'utf8');
  assert.match(install, /<InstallCommand class="cmd" command=\{LINUX_INSTALL_COMMAND\} \/>/);
});
