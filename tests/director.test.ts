import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDirector } from '../server/board-session/director.ts';
import { DIRECTOR_RESULT_FILE, leftoverDirectorCardOps } from '../server/core/director-core.ts';
import { Board } from '../shared/contracts/whiteboard.ts';
import type { TraceRecord } from '../shared/contracts/trace.ts';
import { directorDigestKeyOf } from '../shared/director-digest-key.ts';
import { UNTRUSTED_PAYLOAD_FILENAME } from '../shared/contracts/untrusted-payload.ts';

const SETTLE_MS = 60;
const LATER_RECORD_DELAY_MS = 25;
const LONG_REPLY = `Checkout totals now add tax before the card charge. ${'The cart test covers the rounding case. '.repeat(20)}`;
const DIGEST = 'Checkout totals now add tax before the card charge';

function recordOf(kind: 'prompt' | 'assistant', text: string, ts = Date.now()): TraceRecord {
  return { kind, ts, text, uuid: null, parentUuid: null, vendorSessionId: 'vendor-1' };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDirector(settleMs: number, afterTurnEnd: (records: TraceRecord[]) => { opensOperatorTurn: boolean }) {
  const openedAt = Date.now() - 1000;
  const records: TraceRecord[] = [recordOf('prompt', 'add tax to checkout', openedAt)];
  const repliesSeenByLane: string[] = [];
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'director-test-'));
  const director = createDirector({
    spawnLane: async ({ cwd }) => {
      repliesSeenByLane.push(await fs.readFile(path.join(cwd, UNTRUSTED_PAYLOAD_FILENAME), 'utf8'));
      await fs.writeFile(path.join(cwd, DIRECTOR_RESULT_FILE), JSON.stringify({ digest: DIGEST, points: [] }));
    },
    drainTrace: async () => {},
    readTracePage: async () => ({ records: [...records], start: 0, next: records.length, reset: false, path: 'trace.jsonl' }),
    digestsPath: path.join(home, 'director-digests.json'),
    announceDigest: () => {},
    boards: { loaded: Promise.resolve(), boardOf: async () => null, putWithoutReadCheck: async () => { throw new Error('no board writes'); }, snapshotMessage: () => ({ type: 'whiteboards-snapshot', boards: [] }) },
    settleMs,
    logger: { warn: () => {} },
  });
  const session = { id: 'main-1', name: 'repo main', ephemeral: false, isStudioMain: true, branchOf: null, _destroyed: false };
  director.onTurnEnd(session);
  await waitMs(LATER_RECORD_DELAY_MS);
  director.onTraceAppended({ id: session.id, ...afterTurnEnd(records) });
  await waitMs(settleMs + 200);
  const digests = await director.digestsOf([session.id]);
  await director.stop();
  await fs.rm(home, { recursive: true, force: true });
  return { digests, repliesSeenByLane, key: directorDigestKeyOf(session.id, openedAt) };
}

test('a reply that reaches the trace after the turn-end hook is still digested', async () => {
  const { digests, repliesSeenByLane, key } = await runDirector(SETTLE_MS, (records) => {
    records.push(recordOf('assistant', LONG_REPLY));
    return { opensOperatorTurn: false };
  });
  assert.equal(repliesSeenByLane.length, 1);
  assert.match(repliesSeenByLane[0] ?? '', /Checkout totals now add tax/);
  assert.deepEqual(digests, { [key]: DIGEST });
});

test('the next prompt arriving inside the settle window still digests the turn that ended', async () => {
  const { digests, repliesSeenByLane, key } = await runDirector(SETTLE_MS, (records) => {
    records.splice(1, 0, recordOf('assistant', LONG_REPLY, Date.now() - 500));
    records.push(recordOf('prompt', 'now ship it'));
    return { opensOperatorTurn: true };
  });
  assert.match(repliesSeenByLane[0] ?? '', /Checkout totals now add tax/);
  assert.deepEqual(digests, { [key]: DIGEST });
});

test('the leftover sweep removes only director cards with their own wire', () => {
  const elements = [
    { kind: 'box', id: 'dir-0pc501t-334', title: 'digest', tone: 'violet', place: { at: { x: 0, y: 0 } } },
    { kind: 'wire', id: 'dir-0pc501t-334-to', from: 'dir-0pc501t-334', to: 'dir-backend-api', dashed: true },
    { kind: 'box', id: 'dir-backend-api', title: 'backend', place: { at: { x: 0, y: 0 } } },
    { kind: 'box', id: 'dir-session-1', title: 'session', tone: 'violet', place: { at: { x: 0, y: 0 } } },
  ];
  const board = Board.parse({ id: 'b1', title: 'Code map', version: 1, caption: null, project: '/repo', createdAt: 1, updatedAt: 1, elements: Object.fromEntries(elements.map((element) => [element.id, element])) });
  assert.deepEqual(leftoverDirectorCardOps(board).map((op) => op.op === 'remove' ? op.id : op.op), ['dir-0pc501t-334-to', 'dir-0pc501t-334']);
});
