import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installFakeCoherence } from './helpers/coherence-cli.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CoherenceJournalOutput, COHERENCE_JOURNAL_DRAWER_MAX_ROWS, COHERENCE_JOURNAL_TEXT_MAX_CHARS } from '../shared/contracts/coherence.ts';
import { appendJournalWindow, journalEntries, selectLatestShownEntry } from '../server/coherence/core/coherence-feed-core.ts';
import { resolveCoherence } from '../server/coherence/coherence-runtime.ts';

test('coherence attachment gates operator hosts on the setting', async (context) => {
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'coherence-support-'));
  context.after(() => rm(worktree, { recursive: true, force: true }));
  for (const version of ['timeout', 'failure']) {
    await installFakeCoherence(worktree, { version });
    const attachment = await resolveCoherence({ worktree, host: 'claude', isSettingOn: true, timeoutMs: 1000 });
    assert.deepEqual(attachment?.hooks, { active: false, reason: version === 'timeout' ? 'version check timed out' : 'version check failed' });
  }
  assert.equal(await resolveCoherence({ worktree: '/absent', host: 'claude', isSettingOn: false }), null);
  assert.equal(await resolveCoherence({ worktree: '/absent', host: 'grok', isSettingOn: true }), null);
});

test('the coherence feed keeps a bounded deduplicated window and shows the latest unretracted 1.8 entry', () => {
  const head = { at: '2026-10-17T10:00:00.000Z', session: 's1', agent: 'test', commit: null, dirty: false, binding: 'none' };
  const output = CoherenceJournalOutput.parse({ branch: null, escalations: [], citedBy: {}, damaged: [], records: [
    { ...head, id: 'd-1', kind: 'decision', chose: 'chose\u0007', over: [], because: 'why' },
    { ...head, id: 'c-1', kind: 'conjecture', observation: 'slow parse', couldBe: ['cache'], discriminatedBy: 'warm run' },
    { ...head, id: 'rs-1', kind: 'resolution', of: 'c-1', because: 'warm run passed' },
    { ...head, id: 'd-other', kind: 'decision', chose: 'other session', over: [], because: 'why', session: 'other' },
  ] });
  const entries = journalEntries(output, 's1');
  assert.equal(entries.length, 3);
  assert.equal(entries[0].text, 'chose');
  assert.equal(selectLatestShownEntry(appendJournalWindow([], entries))?.id, 'd-1');
  const defect = { ...entries[0], id: 'df-1', kind: 'defect', text: 'x'.repeat(COHERENCE_JOURNAL_TEXT_MAX_CHARS) };
  const window = appendJournalWindow(entries, [defect, defect]);
  assert.equal(window.length, 4);
  assert.equal(selectLatestShownEntry(window)?.id, 'df-1');
  assert.equal(appendJournalWindow([], Array.from({ length: 250 }, (_, index) => ({ ...defect, id: `df-${index}` }))).length, COHERENCE_JOURNAL_DRAWER_MAX_ROWS);
});
