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
  assert.match(install, /<span data-install-for="linux"><InstallCommand command=\{LINUX_INSTALL_COMMAND\} \/><\/span>/);
});

test('the hero and install section carry every markup hook the install picker applies the view to', () => {
  for (const component of ['Hero.astro', 'Install.astro']) {
    const markup = fs.readFileSync(path.join(SITE_COMPONENTS, component), 'utf8');
    assert.match(markup, /<code[^>]* data-install-command[^>]*><span data-install-for="default">/, component);
    assert.match(markup, /<span data-install-for="linux"[^>]*>/, component);
    assert.match(markup, /data-copy-install/, component);
    assert.match(markup, /data-copy-status/, component);
    assert.match(markup, /<fieldset class="platform-switch" data-platform-switch[^>]*>\s*\{INSTALL_PLATFORMS\.map\(\(platform\) => <button type="button" data-platform=\{platform\}/, component);
  }
  assert.deepEqual([...INSTALL_PLATFORMS].sort(), ['linux', 'macos', 'windows']);
});
