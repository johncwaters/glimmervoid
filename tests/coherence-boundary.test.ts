import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(?:ts|mjs|js|json|css|html|sh)$/.test(entry.name) ? [entryPath] : [];
  });
}

test('Coherence execution and journal paths stay inside server/coherence with no runtime package dependency', () => {
  const violations: string[] = [];
  for (const directory of ['server', 'session', 'shared', 'public', 'bin', 'detection', 'notifications', 'scripts']) {
    for (const file of sourceFiles(path.join(root, directory))) {
      if (file.startsWith(path.join(root, 'server', 'coherence') + path.sep)) continue;
      const source = fs.readFileSync(file, 'utf8');
      if (/['"`][^'"`\r\n]*\.coherence(?:[/\\'"`])/.test(source)) violations.push(path.relative(root, file));
      if (/(?:execFile(?:Async|Sync)?|spawn|runCoherence|resolvePackageBin)\s*\([^;]*?['"](?:@[^'"]*\/)?coherence['"]/s.test(source)) violations.push(path.relative(root, file));
    }
  }
  assert.deepEqual(violations, []);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(Object.keys(manifest[section] ?? {}).some((name) => /(?:^|\/)coherence$/.test(name)), false);
  }
});
