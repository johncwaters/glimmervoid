import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const FONTS_DIRECTORY = path.join(REPO_ROOT, 'assets', 'fonts');
const dashboardStylesheet = fs.readFileSync(path.join(REPO_ROOT, 'public', 'style.css'), 'utf8');

test('every bundled font ships with the SIL OFL licence beside it', () => {
  const fontFiles = fs.readdirSync(FONTS_DIRECTORY).filter((name) => name.endsWith('.woff2'));
  assert.ok(fontFiles.length > 0);
  const licence = fs.readFileSync(path.join(FONTS_DIRECTORY, 'CommitMono-OFL.txt'), 'utf8');
  assert.match(licence, /Copyright \(c\) 2023 Eigil Nikolajsen/);
  assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/);
});

test('every font-face source in the dashboard stylesheet points at a bundled file', () => {
  const sources = [...dashboardStylesheet.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((match) => match[1]);
  assert.equal(sources.length, 4);
  const missingSources = sources.filter((source) => !fs.existsSync(path.join(FONTS_DIRECTORY, source)));
  assert.deepEqual(missingSources, []);
});
