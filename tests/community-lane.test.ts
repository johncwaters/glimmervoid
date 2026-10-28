import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCommunityPoller } from '../server/community/community-poller.ts';
import type { SourceRows } from '../server/community/community-poller.ts';
import { createCommunityStateIo } from '../server/community/community-wiring.ts';

const ENABLED_AT = Date.parse('2026-10-28T12:00:00Z');

function forumRow(id: number, createdAt: string, subject: string): Record<string, unknown> {
  return {
    id,
    attributes: JSON.stringify({
      subject, body: `${subject} body`, permalink: `question-${id}`, createdAt, resolved: true, numReplies: 9,
      profile: { data: { id: 7, attributes: { firstName: 'Asker' } } },
    }),
  };
}

function startPoller(statePath: string, nowMs: () => number, queryForum: (sinceIso: string) => Promise<SourceRows>) {
  const stateIo = createCommunityStateIo(statePath, { warn() {} });
  return createCommunityPoller({
    intervalMinutes: 5, queryForum, readState: stateIo.readState, writeState: stateIo.writeState,
    now: nowMs, log: { warn() {} },
  });
}

test('community lane queues only questions asked after enabling, whatever their status, and keeps them across a restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'community-lane-'));
  const statePath = path.join(directory, 'community-state.json');
  let currentMs = ENABLED_AT;
  const askedSince: string[] = [];
  let forumRows: Record<string, unknown>[] = [forumRow(1, '2026-10-27T09:00:00Z', 'asked before enabling')];
  const queryForum = async (sinceIso: string): Promise<SourceRows> => {
    askedSince.push(sinceIso);
    return { ok: true, rows: forumRows };
  };
  try {
    const firstRun = startPoller(statePath, () => currentMs, queryForum);
    await firstRun.start();
    assert.deepEqual(askedSince, []);
    assert.deepEqual(firstRun.state().entries, {});

    currentMs += 5 * 60000;
    forumRows = [
      forumRow(2, '2026-10-28T12:01:00Z', 'resolved question with many replies'),
      { id: 3, attributes: '{not json' },
    ];
    await firstRun.tick();
    await firstRun.stop();
    assert.deepEqual(askedSince, ['2026-10-28T12:00:00.000Z']);
    const queued = firstRun.state().entries['forum:2'];
    assert.equal(queued?.status, 'queued');
    assert.equal(queued?.item.url, 'https://posthog.com/questions/question-2');
    assert.deepEqual(Object.keys(firstRun.state().entries), ['forum:2']);

    const restarted = startPoller(statePath, () => currentMs, queryForum);
    await restarted.start();
    await restarted.stop();
    assert.deepEqual(Object.keys(restarted.state().entries), ['forum:2']);
    assert.equal(restarted.state().watermarks.forum, '2026-10-28T12:01:00.000Z');
    assert.equal(askedSince.at(-1), '2026-10-28T12:01:00.000Z');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
