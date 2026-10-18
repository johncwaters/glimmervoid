import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoherenceJournalEntry, SessionCoherence } from '../shared/contracts/coherence.ts';
import { coherenceRowLine, formatCoherenceReading, formatJournalEntry } from '../public/coherence/journal-core.ts';

test('Coherence keeps one row line with hooks, actionable guidance and journal priority while preserving drawer detail', () => {
  const entry: CoherenceJournalEntry = {
    id: 'entry-1', at: '2026-10-17T12:00:00.000Z', kind: 'decision',
    text: '<img src=x onerror=alert(1)>', detail: 'Keep markup as text', supersedes: 'entry-0',
  };
  const coherence: SessionCoherence = {
    journal: { ok: true, latest: entry },
    regulation: { ok: true, nextAction: { action: 'release', rule: null, evidence: 'Waiting for approval', remedy: 'Choose a direction', command: 'coherence decide', remaining: 1 } },
    updatedAt: 1,
  };
  assert.equal(coherenceRowLine(null, null), null);
  assert.equal(coherenceRowLine({ active: true }, null), null);
  for (const action of ['release', 'refuse'] as const) {
    if (!coherence.regulation.ok) assert.fail('Expected an available next action');
    coherence.regulation.nextAction.action = action;
    assert.equal(coherenceRowLine(null, coherence), `Decision: ${entry.text}`);
    assert.equal(coherenceRowLine(null, { ...coherence, journal: { ok: true, latest: null } }), null);
  }
  for (const action of ['require-decision', 'redirect'] as const) {
    if (!coherence.regulation.ok) assert.fail('Expected an available next action');
    coherence.regulation.nextAction.action = action;
    assert.equal(coherenceRowLine(null, coherence), 'Coherence: Choose a direction coherence decide');
    assert.equal(coherenceRowLine({ active: false, reason: 'Missing hook' }, coherence), 'Coherence hooks not active: Missing hook');
  }
  if (!coherence.regulation.ok) assert.fail('Expected an available next action');
  coherence.regulation.nextAction.remedy = null;
  assert.equal(coherenceRowLine(null, coherence), 'Coherence: Waiting for approval coherence decide');
  coherence.regulation.nextAction.action = 'refuse';
  const drawerReading = formatCoherenceReading(null, coherence);
  assert.ok(drawerReading.lines.includes('Next action: Refuse'));
  assert.ok(drawerReading.lines.includes('Evidence: Waiting for approval'));
  assert.equal(drawerReading.command, 'coherence decide');
  const unavailable: SessionCoherence = { ...coherence, journal: { ok: false, reason: 'No journal' }, regulation: { ok: false, reason: 'No regulation' } };
  assert.equal(coherenceRowLine(null, unavailable), null);
  assert.deepEqual(formatCoherenceReading(null, unavailable).lines, ['Journal unavailable: No journal', 'Next action unavailable: No regulation']);
  for (const kind of ['decision', 'defect', 'blocked', 'conjecture'] as const) {
    const latest = { ...entry, kind };
    const rowLine = coherenceRowLine(null, { ...coherence, journal: { ok: true, latest } });
    assert.equal(rowLine, `${kind[0].toUpperCase()}${kind.slice(1)}: ${entry.text}`);
  }
  assert.equal(coherenceRowLine(null, { ...coherence, journal: { ok: true, latest: { ...entry, kind: 'session' } } }), null);
  assert.deepEqual(formatJournalEntry(entry), {
    heading: 'Decision | 2026-10-17T12:00:00.000Z | entry-1',
    text: entry.text, detail: entry.detail, supersedes: 'Supersedes: entry-0',
  });
});
