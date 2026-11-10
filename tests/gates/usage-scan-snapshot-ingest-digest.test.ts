import '../helpers/isolate-home.ts';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked } from '../helpers/tracked-files.ts';
import { extractImportSpecifiers } from '../../server/core/import-graph-core.ts';
import { SCAN_SNAPSHOT_INGEST_DIGEST } from '../../server/usage/core/usage-scan-core.ts';

const SCANNER_MODULE = 'server/usage/usage-scanner.ts';
const USAGE_FOLDER = 'server/usage/';
const SHARED_IMPORT_ALIAS = '#shared/';
const DIGEST_DECLARATION = /const SCAN_SNAPSHOT_INGEST_DIGEST = '[^']*';/;
const TYPE_ONLY_IMPORT = /\bimport\s+type\b[^;]*?\bfrom\s*(['"])[^'"]+\1/g;

function repoPathOfImport(importingPath: string, specifier: string): string | null {
  if (specifier.startsWith(SHARED_IMPORT_ALIAS)) return `shared/${specifier.slice(SHARED_IMPORT_ALIAS.length)}`;
  if (!specifier.startsWith('.')) return null;
  return path.posix.join(path.posix.dirname(importingPath), specifier);
}

function scannerImportClosure(): string[] {
  const visitedPaths = new Set<string>();
  const pendingPaths = [SCANNER_MODULE];
  while (pendingPaths.length > 0) {
    const modulePath = pendingPaths.pop() ?? SCANNER_MODULE;
    if (visitedPaths.has(modulePath)) continue;
    visitedPaths.add(modulePath);
    if (!modulePath.startsWith(USAGE_FOLDER)) continue;
    for (const specifier of extractImportSpecifiers(readTracked(modulePath).replace(TYPE_ONLY_IMPORT, ''))) {
      const importedPath = repoPathOfImport(modulePath, specifier);
      if (importedPath) pendingPaths.push(importedPath);
    }
  }
  return [...visitedPaths].sort();
}

test('the scan snapshot ingest digest matches the usage modules the scanner loads and their direct imports', () => {
  const closurePaths = scannerImportClosure();
  assert.ok(closurePaths.includes('server/usage/core/usage-scan-core.ts'), closurePaths.join(', '));
  const ingestDigest = createHash('sha256');
  for (const modulePath of closurePaths) {
    const moduleText = readTracked(modulePath).replaceAll('\r\n', '\n').replace(DIGEST_DECLARATION, '');
    ingestDigest.update(`${modulePath}\n${moduleText}`);
  }
  const currentDigest = ingestDigest.digest('hex').slice(0, 16);
  assert.equal(
    SCAN_SNAPSHOT_INGEST_DIGEST,
    currentDigest,
    `scanner code changed: set SCAN_SNAPSHOT_INGEST_DIGEST in server/usage/core/usage-scan-core.ts to '${currentDigest}' so saved scan snapshots are discarded and rescanned`,
  );
});
