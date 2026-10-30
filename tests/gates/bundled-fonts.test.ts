import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const FONTS_DIRECTORY = path.join(REPO_ROOT, 'public', 'fonts');
const LICENCE_BY_FONT_PREFIX = [
  { prefix: 'commit-mono-', file: 'CommitMono-OFL.txt', marks: [/Copyright \(c\) 2023 Eigil Nikolajsen/, /SIL OPEN FONT LICENSE Version 1\.1/] },
  { prefix: 'comic-mono-', file: 'ComicMono-LICENSE.txt', marks: [/Copyright \(c\) 2018 Shannon Miwa/, /MIT License/] },
] as const;
const dashboardStylesheet = fs.readFileSync(path.join(REPO_ROOT, 'public', 'style.css'), 'utf8');

test('every bundled font ships with its own licence', () => {
  const fontFiles = fs.readdirSync(FONTS_DIRECTORY).filter((name) => name.endsWith('.woff2'));
  assert.ok(fontFiles.length > 0);
  for (const fontFile of fontFiles) {
    const licence = LICENCE_BY_FONT_PREFIX.find((candidate) => fontFile.startsWith(candidate.prefix));
    assert.ok(licence, `${fontFile} names a licence`);
    const licenceText = fs.readFileSync(path.join(REPO_ROOT, 'assets', 'fonts', licence.file), 'utf8');
    for (const mark of licence.marks) assert.match(licenceText, mark);
  }
});

test('every font-face source in the dashboard stylesheet points at a bundled file', () => {
  const sources = [...dashboardStylesheet.matchAll(/url\('\.\/fonts\/([^']+)'\)/g)].map((match) => match[1]);
  assert.equal(sources.length, 6);
  const missingSources = sources.filter((source) => !fs.existsSync(path.join(FONTS_DIRECTORY, source)));
  assert.deepEqual(missingSources, []);
});
