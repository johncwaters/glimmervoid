import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { CoherenceJournalOutput } from '../shared/contracts/coherence.ts';
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
