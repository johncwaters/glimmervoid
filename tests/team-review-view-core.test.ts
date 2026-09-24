import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePhase, phaseLabel, prAttentionSignature, prNeedsAction,
  prStatusPlaceholder, severityFor, sortPrsByAttention, summarizePrs,
} from '../public/team-review-view-core.ts';

test('an empty review feed has a useful placeholder', () => {
  assert.equal(prStatusPlaceholder(null), 'No pull requests to review.');
  assert.equal(prStatusPlaceholder({ projects: [] }), 'No pull requests to review.');
});

test('unknown phases stay visible and do not claim a known severity', () => {
  assert.equal(normalizePhase(null), 'pending');
  assert.deepEqual(phaseLabel('future'), { label: 'future', known: false });
  assert.equal(severityFor('future'), 'dim');
  assert.equal(severityFor('future', { inFlight: true }), 'info');
});

test('error and changes phases have actionable severities', () => {
  assert.equal(severityFor('error'), 'crit');
  assert.equal(severityFor('done'), 'warn');
  assert.equal(prNeedsAction({ phase: 'error' }), true);
  assert.equal(prNeedsAction({ phase: 'done' }), true);
  assert.equal(prNeedsAction({ phase: 'in-review' }), false);
});

test('a clean review reads as clean and needs no action', () => {
  assert.deepEqual(phaseLabel('clean'), { label: 'clean', known: true });
  assert.equal(severityFor('clean'), 'ok');
  assert.equal(prNeedsAction({ phase: 'clean' }), false);
  assert.deepEqual(phaseLabel('changes-requested'), { label: 'changes requested', known: true });
  assert.equal(prNeedsAction({ phase: 'changes-requested' }), true);
});

test('PRs sort by attention then descending number', () => {
  const rows = [
    { title: 'pending', number: 10 },
    { title: 'older error', number: 2, phase: 'error' },
    { title: 'changes', number: 7, phase: 'done' },
    { title: 'newer error', number: 5, phase: 'error' },
  ];
  assert.deepEqual(sortPrsByAttention(rows).map((row) => row.title), [
    'newer error', 'older error', 'changes', 'pending',
  ]);
  assert.equal(rows[0]?.title, 'pending');
});

test('summary counts active reviews and errors', () => {
  assert.deepEqual(summarizePrs([
    { phase: 'error' }, { phase: 'in-review', inFlight: true }, {},
  ]), { open: 3, inReview: 1, errors: 1 });
});

test('attention signature tracks errors by repository and PR number', () => {
  const snapshot = { projects: [{ repoSlug: 'team/app', prs: [
    { number: 7, phase: 'error' }, { number: 8, phase: 'in-review' },
  ] }] };
  assert.equal(prAttentionSignature(snapshot), 'team/app#7:error');
  assert.equal(prAttentionSignature({ projects: [] }), '');
});
