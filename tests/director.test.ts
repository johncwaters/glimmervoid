import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDirector } from '../server/board-session/director.ts';
import { DIRECTOR_PROMPT_FILE, DIRECTOR_RESULT_FILE, leftoverDirectorCardOps } from '../server/core/director-core.ts';
import { Board } from '../shared/contracts/whiteboard.ts';
import type { TraceRecord } from '../shared/contracts/trace.ts';
import { directorDigestKeyOf } from '../shared/director-digest-key.ts';
import { standingMisfitOf } from '../shared/director-fit.ts';
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

const ORCHESTRATOR_SESSION = { id: 'main-1', name: 'repo main', ephemeral: false, isStudioMain: true, parent: null, _destroyed: false };
const BRANCH_SESSION = { id: 'branch-1', name: 'shop checkout', ephemeral: false, isStudioMain: false, parent: { sessionId: 'main-1', box: { id: 'cm-box', title: 'src/checkout', repoName: 'shop' } }, _destroyed: false };
const DIGEST_RESULT = { chatLine: null, digest: DIGEST, points: [] };

async function runDirector(settleMs: number, finalReply: string | null, afterTurnEnd: (records: TraceRecord[]) => { opensOperatorTurn: boolean }, session: typeof ORCHESTRATOR_SESSION | typeof BRANCH_SESSION = ORCHESTRATOR_SESSION, laneResult: Record<string, unknown> | 'lane fails' = DIGEST_RESULT, sharedHome: string | null = null) {
  const openedAt = Date.now() - 1000;
  const records: TraceRecord[] = [recordOf('prompt', 'add tax to checkout', openedAt)];
  const repliesSeenByLane: string[] = [];
  const promptsSeenByLane: string[] = [];
  const toldOrchestrator: { branchId: string; text: string }[] = [];
  const home = sharedHome ?? await fs.mkdtemp(path.join(os.tmpdir(), 'director-test-'));
  const director = createDirector({
    spawnLane: async ({ cwd }) => {
      repliesSeenByLane.push(await fs.readFile(path.join(cwd, UNTRUSTED_PAYLOAD_FILENAME), 'utf8'));
      promptsSeenByLane.push(await fs.readFile(path.join(cwd, DIRECTOR_PROMPT_FILE), 'utf8'));
      if (laneResult === 'lane fails') throw new Error('lane timed out');
      await fs.writeFile(path.join(cwd, DIRECTOR_RESULT_FILE), JSON.stringify(laneResult));
    },
    drainTrace: async () => {},
    readTracePage: async () => ({ records: [...records], start: 0, next: records.length, reset: false, path: 'trace.jsonl' }),
    digestsPath: path.join(home, 'director-digests.json'),
    announceDigest: () => {},
    tellOrchestrator: (branchId, text) => { toldOrchestrator.push({ branchId, text }); },
    boards: { loaded: Promise.resolve(), boardOf: async () => null, putWithoutReadCheck: async () => { throw new Error('no board writes'); }, snapshotMessage: () => ({ type: 'whiteboards-snapshot', boards: [] }) },
    settleMs,
    logger: { warn: () => {} },
  });
  director.onTurnEnd(session, finalReply);
  await waitMs(LATER_RECORD_DELAY_MS);
  director.onTraceAppended({ id: session.id, ...afterTurnEnd(records) });
  await waitMs(Math.min(settleMs, SETTLE_MS) + 200);
  const digests = await director.verdictsOf([session.id]);
  await director.stop();
  if (sharedHome === null) await fs.rm(home, { recursive: true, force: true });
  return { digests, repliesSeenByLane, promptsSeenByLane, toldOrchestrator, key: directorDigestKeyOf(session.id, openedAt) };
}

test('a reply that reaches the trace after the turn-end hook is still digested', async () => {
  const { digests, repliesSeenByLane, key } = await runDirector(SETTLE_MS, null, (records) => {
    records.push(recordOf('assistant', LONG_REPLY));
    return { opensOperatorTurn: false };
  });
  assert.equal(repliesSeenByLane.length, 1);
  assert.match(repliesSeenByLane[0] ?? '', /Checkout totals now add tax/);
  assert.deepEqual(digests, { [key]: { chatLine: null, digest: DIGEST, fitsTask: null, misfit: null } });
});

test('the next prompt arriving inside the settle window still digests the turn that ended', async () => {
  const { digests, repliesSeenByLane, key } = await runDirector(SETTLE_MS, null, (records) => {
    records.splice(1, 0, recordOf('assistant', LONG_REPLY, Date.now() - 500));
    records.push(recordOf('prompt', 'now ship it'));
    return { opensOperatorTurn: true };
  });
  assert.match(repliesSeenByLane[0] ?? '', /Checkout totals now add tax/);
  assert.deepEqual(digests, { [key]: { chatLine: null, digest: DIGEST, fitsTask: null, misfit: null } });
});

test('a turn end carrying its final reply is digested at once with that reply, before the trace holds it and with no settle wait', async () => {
  const { digests, repliesSeenByLane, key } = await runDirector(60_000, LONG_REPLY, () => ({ opensOperatorTurn: false }));
  assert.equal(repliesSeenByLane.length, 1);
  assert.match(repliesSeenByLane[0] ?? '', /Checkout totals now add tax/);
  assert.deepEqual(digests, { [key]: { chatLine: null, digest: DIGEST, fitsTask: null, misfit: null } });
});

test('a branch turn the Director judges off its task is kept with the reason and the Orchestrator is told, naming the branch and the reason', async () => {
  const misfit = 'It rewrote the mail templates, which the checkout tax task never asked for.';
  const flagged = await runDirector(60_000, LONG_REPLY, () => ({ opensOperatorTurn: false }), BRANCH_SESSION, { ...DIGEST_RESULT, fitsTask: false, misfit });
  assert.match(flagged.repliesSeenByLane[0] ?? '', /Repo shop, started on src\/checkout\. Asked: add tax to checkout/, 'the Director reads the task beside the reply');
  assert.match(flagged.promptsSeenByLane[0] ?? '', /"fitsTask": true or false/);
  assert.deepEqual(flagged.digests, { [flagged.key]: { chatLine: null, digest: DIGEST, fitsTask: false, misfit } });
  assert.equal(flagged.toldOrchestrator.length, 1);
  assert.equal(flagged.toldOrchestrator[0]?.branchId, BRANCH_SESSION.id);
  assert.match(flagged.toldOrchestrator[0]?.text ?? '', /your branch shop checkout in shop .* does not fit its task: It rewrote the mail templates, which the checkout tax task never asked for\. /);

  const fitting = await runDirector(60_000, LONG_REPLY, () => ({ opensOperatorTurn: false }), BRANCH_SESSION, { ...DIGEST_RESULT, fitsTask: true, misfit: 'ignored when the turn fits' });
  assert.deepEqual(fitting.digests, { [fitting.key]: { chatLine: null, digest: DIGEST, fitsTask: true, misfit: null } });
  assert.deepEqual(fitting.toldOrchestrator, []);

  const unreasoned = await runDirector(60_000, LONG_REPLY, () => ({ opensOperatorTurn: false }), BRANCH_SESSION, { ...DIGEST_RESULT, fitsTask: false, misfit: null });
  assert.deepEqual(unreasoned.toldOrchestrator, [], 'a misfit with no reason redirects nobody');
  assert.equal(unreasoned.digests[unreasoned.key]?.fitsTask, null, 'and counts as no judgment');

  const ownTurn = await runDirector(60_000, LONG_REPLY, () => ({ opensOperatorTurn: false }), ORCHESTRATOR_SESSION, { ...DIGEST_RESULT, fitsTask: false, misfit });
  assert.doesNotMatch(ownTurn.promptsSeenByLane[0] ?? '', /fitsTask/, 'the Orchestrator has no box, so its own turn gets no fit check');
  assert.deepEqual(ownTurn.digests, { [ownTurn.key]: { chatLine: null, digest: DIGEST, fitsTask: null, misfit: null } });
  assert.deepEqual(ownTurn.toldOrchestrator, []);
});

test('a flag stands through a turn the Director could not judge and leaves only when a later turn is judged to fit', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'director-flag-'));
  const misfit = 'It rewrote the mail templates.';
  const noTurnLeft = () => ({ opensOperatorTurn: false });
  const flagged = await runDirector(60_000, LONG_REPLY, noTurnLeft, BRANCH_SESSION, { ...DIGEST_RESULT, fitsTask: false, misfit }, home);
  const unjudged = await runDirector(60_000, LONG_REPLY, noTurnLeft, BRANCH_SESSION, 'lane fails', home);
  assert.equal(unjudged.digests[unjudged.key]?.fitsTask, null);
  assert.equal(standingMisfitOf([unjudged.digests[unjudged.key], unjudged.digests[flagged.key]]), misfit, 'a failed Director call is no judgment, so the flag stands');
  const fitting = await runDirector(60_000, LONG_REPLY, noTurnLeft, BRANCH_SESSION, { chatLine: null, digest: null, points: [], fitsTask: true, misfit: null }, home);
  assert.deepEqual(fitting.digests[fitting.key], { chatLine: null, digest: null, fitsTask: true, misfit: null }, 'a fitting turn with nothing else to show is still kept, to clear the flag');
  assert.equal(standingMisfitOf([fitting.digests[fitting.key], fitting.digests[unjudged.key], fitting.digests[flagged.key]]), null);
  await fs.rm(home, { recursive: true, force: true });
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
