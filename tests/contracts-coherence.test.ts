import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { CoherenceJournalOutput } from '../shared/contracts/coherence.ts';
import { areCodexHooksTrusted, codexHookHashes, trustedCodexHookHashes } from '../server/coherence/core/coherence-codex-trust-core.ts';
import { judgeCoherenceSupport } from '../server/coherence/core/coherence-support-core.ts';

const fixtures = new URL('./fixtures/coherence/1.8.0/', import.meta.url);

for (const fixture of ['journal.json', 'journal-empty.json']) {
  test(`CoherenceJournalOutput parses 1.8.0 ${fixture}`, () => {
    const output: unknown = JSON.parse(fs.readFileSync(new URL(fixture, fixtures), 'utf8'));
    assert.deepEqual(CoherenceJournalOutput.parse(output), output);
  });
}

test('unknown journal kinds degrade one row while malformed known kinds fail closed', () => {
  const output = CoherenceJournalOutput.parse(JSON.parse(fs.readFileSync(new URL('journal.json', fixtures), 'utf8')));
  assert.deepEqual(CoherenceJournalOutput.parse({ ...output, records: [...output.records, { id: 'future-1', kind: 'future', extra: 'opaque' }] }).records.at(-1), { id: 'future-1', kind: 'future' });
  assert.equal(CoherenceJournalOutput.safeParse({ ...output, records: [{ id: 'd-broken', kind: 'decision' }] }).success, false);
});

test('Coherence version fixture and supported range reject prereleases and unrelated output', () => {
  assert.deepEqual(judgeCoherenceSupport(fs.readFileSync(new URL('version.txt', fixtures), 'utf8')), { status: 'supported', version: '1.8.0' });
  for (const version of ['0.37.1', '1.7.99', '2.0.0', '1.8.0-beta.1']) {
    assert.deepEqual(judgeCoherenceSupport(`coherence ${version}: the installed package (node_modules).`), { status: 'unsupported', version });
  }
  assert.deepEqual(judgeCoherenceSupport('unrelated output'), { status: 'unreadable' });
});

test('Coherence 1.8.0 Codex inline hooks hash additionalContextLimit and require current trust', () => {
  const text = fs.readFileSync(new URL('codex-hooks.json', fixtures), 'utf8');
  const hashes = codexHookHashes('/repo/.codex/hooks.json', text);
  assert.equal(hashes.size, 7);
  assert.equal([...hashes.values()].every((hash) => hash !== null), true);
  const hooks = JSON.parse(text) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
  const identity = { event_name: 'session_start', hooks: [{ additionalContextLimit: 4000, async: false, command: hooks.hooks.SessionStart[0].hooks[0].command, timeout: 60, type: 'command' }] };
  const expectedHash = `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
  assert.equal(hashes.get('/repo/.codex/hooks.json:session_start:0:0'), expectedHash);
  const trust = [...hashes].map(([key, hash]) => `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}`).join('\n');
  assert.equal(areCodexHooksTrusted(hashes, trustedCodexHookHashes(trust)), true);
  assert.equal(areCodexHooksTrusted(hashes, trustedCodexHookHashes(trust.replace(expectedHash, 'stale'))), false);
});
