import test from 'node:test';
import assert from 'node:assert/strict';
import { isCredentialLikePath, nulSeparatedPaths } from '../server/core/git-changed-paths-core.ts';

test('reads NUL separated git paths verbatim, keeping non-ASCII, tab, quote, newline and trailing space bytes', () => {
  const awkwardWorkflowPaths = ['.github/workflows/é.yml', '.github/workflows/a\tb.yml', '.github/workflows/"q".yml', '.github/workflows/line\nbreak.yml', '.github/workflows/trailing .yml '];
  assert.deepEqual(nulSeparatedPaths(`src/a.ts\0${awkwardWorkflowPaths.join('\0')}\0`), ['src/a.ts', ...awkwardWorkflowPaths]);
  assert.deepEqual(nulSeparatedPaths(''), []);
});

test('classifies credential-like file names by their last segment, with either slash', () => {
  for (const credentialPath of ['.env', 'config/.env.production', 'certs\\server.pem', 'home/id_rsa.pub', '.npmrc', 'a\\b\\.netrc', 'credentials.json', 'tls/private.key']) {
    assert.equal(isCredentialLikePath(credentialPath), true, credentialPath);
  }
  for (const ordinaryPath of ['src/monkey.ts', 'src/env.ts', 'docs/credential-rotation.md', '.env-dir\\readme.md']) {
    assert.equal(isCredentialLikePath(ordinaryPath), false, ordinaryPath);
  }
});
