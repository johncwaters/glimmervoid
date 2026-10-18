import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoherenceJournalEntry, CoherenceReadingRow, CoherenceTrendWindow, SessionCoherence } from '../shared/contracts/coherence.ts';
import { coherenceTrendDirectionLabel, coherenceTrendPanelRows } from '../public/coherence/trend-core.ts';
import { COHERENCE_HOOKS_INACTIVE } from '../shared/contracts/session.ts';
import { coherenceRowSignals, formatCoherenceReading, formatJournalEntry } from '../public/coherence/journal-core.ts';
import { SIGNAL_TIER } from '../public/signal-core.ts';
import { coherenceCheckStageLabel, coherenceCheckSummary } from '../public/coherence/check-core.ts';

test('Coherence check summary counts failures without counting skipped stages', () => {
  const stages = [
    { id: 'setting', status: 'pass', detail: 'Enabled' },
    { id: 'install', status: 'fail', detail: 'Not installed' },
    { id: 'hooks-claude', status: 'skip', detail: 'Install required' },
    { id: 'hooks-codex', status: 'fail', detail: 'Missing hook' },
  ] as const;
  assert.equal(coherenceCheckSummary(stages), '2 failed');
  assert.equal(coherenceCheckSummary(stages.slice(0, 2)), '1 failed');
  assert.equal(coherenceCheckSummary(stages.filter((stage) => stage.status !== 'fail')), 'All stages passed');
});

test('Coherence check preserves unknown stage ids including inherited property names', () => {
  for (const stageId of ['future-stage', 'constructor', '__proto__']) {
    assert.equal(coherenceCheckStageLabel(stageId), stageId);
  }
});

test('Coherence row signals carry only inactive hooks, never an agent-facing next action, while the drawer keeps the detail', () => {
  const entry: CoherenceJournalEntry = {
    id: 'entry-1', at: '2026-10-17T12:00:00.000Z', kind: 'decision',
    text: '<img src=x onerror=alert(1)>', detail: 'Keep markup as text', supersedes: 'entry-0',
  };
  const coherence: SessionCoherence = {
    journal: { ok: true, latest: entry },
    regulation: { ok: true, nextAction: { action: 'release', rule: null, evidence: 'Waiting for approval', remedy: 'Choose a direction', command: 'coherence decide', remaining: 1 } },
    updatedAt: 1,
  };
  const rowTexts = (hooks: Parameters<typeof coherenceRowSignals>[0]) => coherenceRowSignals(hooks).map((signal) => signal.text);
  assert.deepEqual(rowTexts(null), []);
  assert.deepEqual(rowTexts({ active: true }), []);
  assert.deepEqual(rowTexts({ active: false, reason: COHERENCE_HOOKS_INACTIVE.configMissing }), []);
  const [hooksOff] = coherenceRowSignals({ active: false, reason: 'Missing hook' });
  assert.deepEqual([hooksOff?.tier, hooksOff?.hoverText], [SIGNAL_TIER.broken, 'Coherence hooks not active: Missing hook']);
  if (!coherence.regulation.ok) assert.fail('Expected an available next action');
  coherence.regulation.nextAction.action = 'refuse';
  const drawerReading = formatCoherenceReading(null, coherence);
  assert.ok(drawerReading.lines.includes('Next action: Refuse'));
  assert.ok(drawerReading.lines.includes('Evidence: Waiting for approval'));
  assert.equal(drawerReading.command, 'coherence decide');
  const unavailable: SessionCoherence = { ...coherence, journal: { ok: false, reason: 'No journal' }, regulation: { ok: false, reason: 'No regulation' } };
  assert.deepEqual(formatCoherenceReading(null, unavailable).lines, ['Journal unavailable: No journal', 'Next action unavailable: No regulation']);
  assert.deepEqual(formatJournalEntry(entry), {
    heading: 'Decision | 2026-10-17T12:00:00.000Z | entry-1',
    text: entry.text, detail: entry.detail, supersedes: 'Supersedes: entry-0',
  });
});

test('project trends keep direction quiet and retain comparison, findings and setup detail in panel rows', () => {
  const trend: CoherenceTrendWindow = {
    direction: 'decohering', rows: 5, comparedRows: 3,
    redundancyPairs: { from: 2, to: 6 }, lines: { from: 1000, to: 1200 },
  };
  const latest: CoherenceReadingRow = {
    sha: 'a'.repeat(40), at: '2026-10-17T12:00:00.000Z',
    drift: { status: 'ok', developmentCommits: 10, localityPercent: 80, locality: 'converging', spread: 'narrowing' },
    decompose: { status: 'ok', components: 2, commitsAnalyzed: 10, localityPercent: 80, topFindings: [{ kind: 'missing-abstraction', subject: '<img src=x onerror=alert(1)>', count: 3 }] },
    redundancy: { status: 'ok', pairCount: 6, topPairs: [{
      a: { file: '<script>one.ts</script>', kind: 'function', name: 'first' },
      b: { file: 'two.ts', kind: 'function', name: '<b>second</b>' }, score: 0.9, isDiverged: true,
    }] },
    mass: { status: 'ok', lines: 1200, files: 20, symbols: 100 },
  };
  for (const direction of ['converging', 'steady', 'decohering'] as const) {
    assert.equal(coherenceTrendDirectionLabel({ ...trend, direction }), direction);
  }
  const panelRows = coherenceTrendPanelRows(latest, trend);
  assert.equal(panelRows.find((row) => row.label === 'Comparison')?.text, '3 rows compared out of 5 recorded rows. Direction tracks redundant pairs per 1,000 lines.');
  assert.equal(panelRows.find((row) => row.label === 'Redundant pairs')?.text, '2 to 6');
  assert.equal(panelRows.find((row) => row.label === 'Lines')?.text, '1000 to 1200');
  assert.equal(panelRows.find((row) => row.label === 'Drift')?.text, '10 development commits; 80% locality (converging); component spread narrowing.');
  assert.equal(panelRows.find((row) => row.label === 'Decomposition')?.text, '2 components; 10 commits analyzed; 80% locality.');
  assert.equal(panelRows.find((row) => row.label === 'Redundancy')?.text, '6 redundant pairs.');
  assert.equal(panelRows.find((row) => row.label === 'Size')?.text, '1200 lines, 20 files, 100 symbols.');
  assert.equal(panelRows.find((row) => row.label === 'Missing abstraction')?.text, '<img src=x onerror=alert(1)>: 3');
  assert.equal(panelRows.find((row) => row.label === 'Top redundancy pair')?.text, 'first (function, <script>one.ts</script>) and <b>second</b> (function, two.ts); similarity score 0.9; diverged.');
  const configLine = '"components": [{ "name": "<component>", "files": ["<folder>/**"] }]';
  const needsComponents = { status: 'needs-components', configLine } as const;
  const setupRows = coherenceTrendPanelRows({ ...latest, drift: needsComponents, decompose: needsComponents }, trend);
  for (const label of ['Drift', 'Decomposition']) assert.equal(setupRows.find((row) => row.label === label)?.configLine, configLine);
  const unavailable = { status: 'unavailable', reason: 'the reading timed out' } as const;
  const unavailableRows = coherenceTrendPanelRows({ ...latest, drift: unavailable, decompose: unavailable, redundancy: unavailable, mass: unavailable }, trend);
  assert.equal(unavailableRows.filter((row) => row.text === 'Unavailable: the reading timed out').length, 4);
  assert.equal(coherenceTrendDirectionLabel(trend), 'decohering');
  const limitedHistory = coherenceTrendPanelRows({ ...latest, drift: { status: 'insufficient-history', developmentCommits: 1 } }, { ...trend, direction: 'steady', comparedRows: 1, redundancyPairs: null, lines: null });
  assert.equal(limitedHistory.find((row) => row.label === 'Drift')?.text, 'Not enough history: 1 mapped development commits.');
  assert.equal(limitedHistory.find((row) => row.label === 'Lines')?.text, 'Not enough comparable history.');
});
