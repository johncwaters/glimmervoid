import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoherenceJournalEntry } from '../shared/contracts/coherence.ts';
import { COHERENCE_HOOKS_INACTIVE } from '../shared/contracts/session.ts';
import { coherenceRowSignals, formatCoherenceReading, formatJournalEntry } from '../public/coherence/journal-core.ts';
import { SIGNAL_TIER } from '../public/signal-core.ts';

test('Coherence row signals keep absent installs silent and show unsupported versions with journal detail', () => {
  const entry: CoherenceJournalEntry = {
    id: 'entry-1', at: '2026-10-17T12:00:00.000Z', kind: 'decision',
    text: '<img src=x onerror=alert(1)>', detail: 'Keep markup as text', supersedes: 'entry-0',
  };
  for (const hooks of [null, { active: true }, { active: false, reason: COHERENCE_HOOKS_INACTIVE.notInstalled }] as const) assert.deepEqual(coherenceRowSignals(hooks), []);
  const [hooksOff] = coherenceRowSignals({ active: false, reason: COHERENCE_HOOKS_INACTIVE.unsupportedVersion, version: '0.37.1' });
  assert.equal(hooksOff.tier, SIGNAL_TIER.broken);
  assert.match(hooksOff.hoverText ?? '', /0\.37\.1/);
  assert.deepEqual(formatCoherenceReading(null, { journal: { ok: false, reason: 'No journal' }, updatedAt: 1 }).lines, ['Journal unavailable: No journal']);
  assert.deepEqual(formatJournalEntry(entry), { heading: 'Decision | 2026-10-17T12:00:00.000Z | entry-1', text: entry.text, detail: entry.detail, supersedes: 'Supersedes: entry-0' });
  assert.match(formatJournalEntry({ ...entry, kind: 'future' }).heading, /^future \|/);
  assert.match(formatJournalEntry({ ...entry, kind: 'constructor' }).heading, /^constructor \|/);
});
